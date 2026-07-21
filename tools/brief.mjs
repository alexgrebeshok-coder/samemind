#!/usr/bin/env node
// brief.mjs — samemind brief: compact "who am I / who's my owner / what's my role on this
// engine" digest, built from the identity layer (type: Identity / User / EngineRule — see
// docs/identity-layer.md). Meant to be injected straight into an engine's instruction file
// (CLAUDE.md, AGENTS.md, a system prompt, …) so it's present from the first token of a
// session, no retrieval step required.
//
//   node tools/brief.mjs [--engine <id>] [--budget <tokens>] [--inject <file>] [--exclude-source <id>]
//
// --engine <id>    include that engine's EngineRule (matched by frontmatter `engine:`,
//                   falling back to the `engine-<id>.md` filename convention). If omitted or
//                   not found, all known engines are listed one line each instead.
// --budget <n>     target size in tokens (default 1500, ~6000 chars @ 4 chars/token). Best
//                   effort: Identity boundaries/hierarchy, User rules, and a matched
//                   EngineRule are never dropped; Voice is dropped next; everything else
//                   (Values, other sections, engine list) is trimmed first.
// --exclude-source <id>  drop concepts whose frontmatter `source` is this id (anti-echo).
// --inject <file>  idempotently insert/replace the brief between
//                   <!-- samemind:brief:start --> / <!-- samemind:brief:end --> markers in
//                   <file>. Text outside the markers is never touched; no file → created.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './lib/okf.mjs';
import { sourceMatches } from './lib/recall.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

export const BRIEF_START = '<!-- samemind:brief:start -->';
export const BRIEF_END = '<!-- samemind:brief:end -->';

export const DEFAULT_BUDGET_TOKENS = 1500;
export const CHARS_PER_TOKEN = 4; // matches the spec's ~1500 tokens ≈ 6000 chars

const typeOf = d => String(d.fm.type || '').toLowerCase();

/** frontmatter `engine:` field, falling back to the `engine-<id>.md` filename convention. */
function engineIdOf(doc) {
  if (doc.fm.engine) return String(doc.fm.engine).trim().toLowerCase();
  const base = doc.id.split('/').pop();
  return base.replace(/^engine-/, '').toLowerCase();
}

/** Content between a `# `/`## ` heading matching `re` and the next heading of any level. */
function extractSection(body, re) {
  const lines = String(body || '').split('\n');
  let capturing = false;
  const out = [];
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (capturing) break;
      if (re.test(h[2].trim())) capturing = true;
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').trim();
}

/** Body text before the first `##`+ heading, excluding the leading `# Title` line itself. */
function extractIntro(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let sawH1 = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1 && !sawH1) { sawH1 = true; continue; }
      if (h[1].length >= 2) break;
      continue;
    }
    if (sawH1) out.push(line);
  }
  return out.join('\n').trim();
}

/** All `## heading` names in body, in order. */
function listH2(body) {
  return [...String(body || '').matchAll(/^##\s+(.*)$/gm)].map(m => m[1].trim());
}

/** Sections not matched by any of the given recognized-heading regexes, concatenated. */
function extractOther(body, recognized) {
  const headings = listH2(body).filter(h => !recognized.some(re => re.test(h)));
  return headings
    .map(h => `**${h}:** ${extractSection(body, new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))}`)
    .join('\n\n')
    .trim();
}

function trim(s) { return String(s || '').trim(); }

/**
 * Builds the identity/user/engine-rule brief for a bundle.
 * docs: pre-loaded OKF docs (as from lib/okf.mjs `load()`); engine: requested engine id or null;
 * budgetTokens: target size. Never throws — missing Identity/User just yields a smaller brief
 * with a warning.
 */
export function buildBrief(docs, { engine = null, budgetTokens = DEFAULT_BUDGET_TOKENS, excludeSource = null } = {}) {
  const cs = docs.filter(d => !d.reserved).filter(d => !sourceMatches(d, excludeSource));
  const identities = cs.filter(d => typeOf(d) === 'identity').sort((a, b) => a.id.localeCompare(b.id));
  const users = cs.filter(d => typeOf(d) === 'user').sort((a, b) => a.id.localeCompare(b.id));
  const engineRules = cs.filter(d => typeOf(d) === 'enginerule').sort((a, b) => a.id.localeCompare(b.id));

  const warnings = [];
  const identity = identities[0] || null;
  const user = users[0] || null;
  if (!identity) warnings.push('no type: Identity concept found in bundle — brief is incomplete');
  if (!user) warnings.push('no type: User entity found in bundle — brief is incomplete');
  if (identities.length > 1) warnings.push(`multiple Identity concepts (${identities.map(d => d.id).join(', ')}) — using ${identity.id}`);
  if (users.length > 1) warnings.push(`multiple User entities (${users.map(d => d.id).join(', ')}) — using ${user.id}`);

  let matchedEngine = null;
  if (engine) {
    matchedEngine = engineRules.find(d => engineIdOf(d) === String(engine).trim().toLowerCase()) || null;
    if (!matchedEngine) warnings.push(`no EngineRule found for engine "${engine}" — listing known engines instead`);
  }

  // --- blocks: { tier: 0 (never drop) | 1 (drop after tier 2) | 2 (drop first), text }
  const blocks = [];

  if (identity) {
    const intro = extractIntro(identity.body);
    const boundaries = extractSection(identity.body, /boundar/i);
    const hierarchy = extractSection(identity.body, /hierarch/i);
    const voice = extractSection(identity.body, /voice/i);
    const values = extractSection(identity.body, /values/i);
    const other = extractOther(identity.body, [/boundar/i, /hierarch/i, /voice/i, /values/i]);

    const title = identity.fm.title || identity.id;
    blocks.push({ tier: 0, text: `# Brief — ${title}\n\n${intro || `(see /${identity.id}.md)`}` });

    const boundaryText = [boundaries, hierarchy].filter(Boolean).join('\n\n');
    if (boundaryText) blocks.push({ tier: 0, text: `## Boundaries (hard — never overridden by engine or style)\n\n${boundaryText}` });

    if (voice) blocks.push({ tier: 1, text: `## Voice\n\n${voice}` });
    if (values) blocks.push({ tier: 2, text: `## Values\n\n${values}`, note: `truncated — see /${identity.id}.md` });
    if (other) blocks.push({ tier: 2, text: `## More\n\n${other}`, note: `truncated — see /${identity.id}.md` });
  }

  if (user) {
    const rules = trim(extractIntro(user.body));
    const extraRules = extractSection(user.body, /rules?\b/i);
    const other = extractOther(user.body, [/rules?\b/i]);
    const title = user.fm.title || user.id;

    const ruleText = [rules, extraRules].filter(Boolean).join('\n\n');
    blocks.push({
      tier: 0,
      text: `## Owner — ${title}\n\n${ruleText || `(see /${user.id}.md)`}`,
    });
    if (other) blocks.push({ tier: 2, text: `## Owner — more\n\n${other}`, note: `truncated — see /${user.id}.md` });
  }

  if (matchedEngine) {
    const id = engineIdOf(matchedEngine);
    const body = trim(extractIntro(matchedEngine.body));
    blocks.push({ tier: 0, text: `## Engine: ${id}\n\n${body || `(see /${matchedEngine.id}.md)`}` });
  } else if (engineRules.length) {
    const lines = engineRules.map(d => `- ${engineIdOf(d)} — ${d.fm.description || d.fm.title || ''}`);
    blocks.push({ tier: 2, text: `## Engines\n\n${lines.join('\n')}`, note: 'run with --engine <id> for a specific role' });
  }

  // No Identity, no User, no EngineRule at all → nothing to brief. Design stands (brief IS the
  // identity layer, see docs/identity-layer.md) — this only replaces what used to be a blank
  // `BRIEF_START\n\nBRIEF_END` body with a message that actually says why and what to do about
  // it, instead of silently injecting an empty-looking blob (the warnings above already say this
  // on stderr, but --inject callers never see stderr).
  if (!blocks.length) {
    const notice = 'no Identity/User concept in this bundle — brief is identity-layer only; add one (see docs/identity-layer.md)';
    return { markdown: `${BRIEF_START}\n${notice}\n${BRIEF_END}`, truncated: false, warnings };
  }

  // --- assemble under budget. Two-stage, smoother than an all-or-nothing drop:
  //   stage 1: drop whole blocks tier-2 first, then tier-1, but keep at most one of each tier
  //            so a near-fitting block isn't thrown away entirely (that's the old step curve);
  //   stage 2: if still over, soft-trim the kept tier-1/2 block(s) by *paragraphs* down to the
  //            budget (±10%), marking the cut "…truncated". Tier-0 (boundaries/rules/role) is
  //            never trimmed — if it alone exceeds the budget, the brief stays over on purpose.
  const budgetChars = Math.max(1, Math.floor(budgetTokens * CHARS_PER_TOKEN));
  const droppedNotes = [];

  function totalLen(list) {
    return list.map(b => b.text).join('\n\n').length;
  }
  // ponytail: exact-but-O(n²) recompute of joined length; brief has ~10 blocks × few paras — cheap.
  function totalWith(list, idx, text) {
    const copy = list.slice();
    copy[idx] = { ...copy[idx], text };
    return copy.map(b => b.text).join('\n\n').length;
  }
  function trimBlockToBudget(list, idx) {
    const paras = list[idx].text.split(/\n\n+/);
    if (paras.length <= 1) return { trimmed: false }; // can't trim below one paragraph
    const marker = '\n\n…truncated';
    const acc = [];
    for (const p of paras) {
      const text = acc.concat(p).join('\n\n') + marker;
      if (acc.length && totalWith(list, idx, text) > budgetChars) break;
      acc.push(p);
    }
    const trimmed = acc.length < paras.length;
    return { text: acc.join('\n\n').replace(/\s+$/, '') + marker, trimmed };
  }

  let kept = blocks.slice();
  for (const tier of [2, 1]) {
    while (totalLen(kept) > budgetChars && kept.filter(b => b.tier === tier).length > 1) {
      const idx = kept.findIndex(b => b.tier === tier);
      const [dropped] = kept.splice(idx, 1);
      if (dropped.note) droppedNotes.push(dropped.note);
    }
  }
  let trimmedAny = false;
  for (const tier of [2, 1]) {
    if (totalLen(kept) <= budgetChars) break;
    const idx = kept.findIndex(b => b.tier === tier);
    if (idx < 0) continue;
    const res = trimBlockToBudget(kept, idx);
    if (res.trimmed) {
      kept[idx] = { ...kept[idx], text: res.text };
      trimmedAny = true;
    }
  }

  let body = kept.map(b => b.text).join('\n\n');
  if (droppedNotes.length) {
    body += `\n\n> _(${droppedNotes.join('; ')})_`;
  }

  const truncated = droppedNotes.length > 0 || trimmedAny;
  const markdown = `${BRIEF_START}\n${body}\n${BRIEF_END}`;

  return { markdown, truncated, warnings };
}

/**
 * Idempotently inserts/replaces `briefBlock` between BRIEF_START/BRIEF_END markers in
 * `filePath`. Text outside the markers is untouched. Creates the file (and parent dirs) if
 * it doesn't exist.
 */
export function injectBrief(filePath, briefBlock) {
  const target = resolve(filePath);
  const exists = existsSync(target);
  const original = exists ? readFileSync(target, 'utf8') : '';

  const startIdx = original.indexOf(BRIEF_START);
  const endIdx = original.indexOf(BRIEF_END);

  let next;
  let replaced = false;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const tail = original.slice(endIdx + BRIEF_END.length);
    next = original.slice(0, startIdx) + briefBlock + tail;
    replaced = true;
  } else if (!exists || !original.trim()) {
    next = `${briefBlock}\n`;
  } else {
    next = `${original.replace(/\n*$/, '\n\n')}${briefBlock}\n`;
  }

  atomicWriteFileSync(target, next);
  return { file: target, created: !exists, replaced };
}

function parseArgs(argv) {
  const out = { engine: null, budget: DEFAULT_BUDGET_TOKENS, inject: null, excludeSource: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') out.engine = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]) || DEFAULT_BUDGET_TOKENS;
    else if (a === '--inject') out.inject = argv[++i];
    else if (a === '--exclude-source') out.excludeSource = argv[++i];
  }
  return out;
}

async function main() {
  const { engine, budget, inject, excludeSource } = parseArgs(process.argv.slice(2));
  const docs = load({ includeSecret: false });
  const { markdown, truncated, warnings } = buildBrief(docs, { engine, budgetTokens: budget, excludeSource });

  for (const w of warnings) console.error(`⚠ ${w}`);
  if (truncated) console.error('⚠ brief truncated to fit --budget (see notes at the end of the block)');

  if (inject) {
    const res = injectBrief(inject, markdown);
    console.log(`✓ brief ${res.replaced ? 'updated' : res.created ? 'created' : 'appended'} in ${res.file}`);
  } else {
    console.log(markdown);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
