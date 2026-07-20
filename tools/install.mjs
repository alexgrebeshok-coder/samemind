#!/usr/bin/env node
// install.mjs — samemind install: wire the identity brief + memory protocol straight into
// an agent engine's own instruction file (CLAUDE.md, AGENTS.md, .cursor/rules/samemind.md, …),
// so "works with your agent out of the box" is true without a manual copy-paste step.
//
//   node tools/install.mjs --list
//   node tools/install.mjs --agent <id> [--target <dir>] [--budget <n>]
//   node tools/install.mjs --agent all  [--target <dir>] [--budget <n>]
//   node tools/install.mjs --agent <any-id> --file <path>   # generic install for an unsupported agent
//
// One shared template (protocolBlock below + buildBrief from brief.mjs) is rendered per
// engine — not 13 hand-copied snippets. Insertion is idempotent between
// <!-- samemind:install:start/end --> markers (atomic write; text outside is never touched;
// no file → created; missing parent folders — e.g. .cursor/rules/ — are created).
//
// `--agent <id>` fully installs that engine: every file it owns is created/updated.
// `--agent all` is conservative: it only refreshes instruction files that ALREADY exist in
// `--target` (never creates all N files "just in case"). Files shared by several engines
// (AGENTS.md is read by Cursor/Copilot/Codex/opencode/Windsurf/Antigravity; GEMINI.md by
// Gemini CLI/Antigravity) get the engine-specific brief only when installed for one engine
// explicitly; under `--agent all` a shared file that already exists gets the generic
// (no single --engine) brief, since which of its several readers is actually in use can't be
// inferred from the file's mere presence.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrief, BRIEF_START, BRIEF_END, DEFAULT_BUDGET_TOKENS } from './brief.mjs';
import { load } from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

export const INSTALL_START = '<!-- samemind:install:start -->';
export const INSTALL_END = '<!-- samemind:install:end -->';

/**
 * Supported engines → instruction file(s) each one reads. Order matters for `--agent all`'s
 * tie-break on shared files (first declared owner wins when the file has no single owner).
 * Paths with a `/` live in a subfolder created on demand (rules-file convention: Cursor,
 * Roo Code, Kiro get a dedicated `samemind.md`/`samemind.md`-shaped file rather than sharing
 * their folder's other rule files).
 */
export const ENGINE_FILES = {
  'claude-code': { label: 'Claude Code', files: ['CLAUDE.md'] },
  cursor: { label: 'Cursor', files: ['AGENTS.md', '.cursor/rules/samemind.md'] },
  copilot: { label: 'GitHub Copilot (agent mode)', files: ['.github/copilot-instructions.md', 'AGENTS.md'] },
  codex: { label: 'Codex CLI', files: ['AGENTS.md'] },
  'gemini-cli': { label: 'Gemini CLI', files: ['GEMINI.md'] },
  opencode: { label: 'opencode', files: ['AGENTS.md'] },
  cline: { label: 'Cline', files: ['.clinerules'] },
  roo: { label: 'Roo Code', files: ['.roo/rules/samemind.md'] },
  windsurf: { label: 'Windsurf', files: ['.windsurf/rules/samemind.md', 'AGENTS.md'] },
  goose: { label: 'Goose', files: ['.goosehints'] },
  kiro: { label: 'Kiro', files: ['.kiro/steering/samemind.md'] },
  antigravity: { label: 'Antigravity', files: ['AGENTS.md', 'GEMINI.md'] },
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** One shared protocol template, parameterized only by the display label. */
function protocolBlock(label) {
  return `## samemind memory

Local git-native markdown memory (samemind / OKF bundle) — no cloud service, no API keys.
On session start, run \`memory_handoff\` (MCP) or \`samemind handoff\` for work state before re-explaining.

When a question needs past context (owner, people, projects, decisions):

1. **Search first (cheap):** \`samemind recall "<q>" -k 5\` or MCP \`memory_search\`.
2. **Read top 3–5 fully:** \`samemind query get <id>\` or MCP \`memory_get\`. At most one relation hop if still within budget.
3. **Answer with path citations** like \`/entities/x.md\`, \`/projects/y.md\`.
4. **Always end with** \`## What the memory doesn't cover\` — gaps for this question + staleness from each node's \`timestamp\`.
5. **New facts/decisions** → MCP \`memory_write_inbox\` only. Never write into \`concepts/\` / \`entities/\` / \`projects/\` as the agent.

Full protocol: docs/memory-protocol.md. Bundle root = \`OKF_ROOT\` env or the current directory.

## Write discipline (MUST)

The bundle holds **work**, not only facts (full spec: docs/work-discipline.md).

- Agreed a plan/position with the owner → write a \`Plan\`/\`Decision\` to \`inbox/\` **now** (MCP \`memory_write_inbox\`). "Later" = didn't happen.
- Plan changed → write a **new** \`Plan\` with \`relations.supersedes: /projects/<old>.md\`; mark old \`status: superseded\`. Plans/Decisions are append-only.
- Session ended → write a \`Session\` to \`inbox/\` (\`engine\`, \`date\`, \`## Done\` / \`## Decided\` / \`## Next\`).
- Task changed status → edit the \`Task\` **in place**. \`status: blocked\` requires a non-empty \`blocked_reason\`.

\`samemind query validate\` warns on Plan/Task missing \`status\`, bad \`status\`, or a blocked Task without a reason.

Tools on this bundle: \`samemind query|recall|gde|brief|handoff|forget|serve\` (or MCP \`memory_search/get/list/write_inbox/handoff\`).
This block was installed for **${label}** by \`samemind install\` — safe to re-run, safe to delete by hand.`;
}

/**
 * Renders the full install block for one engine (or a generic one when engineId is null,
 * used by `--agent all` for files shared across several engines).
 * docs: pre-loaded OKF docs (tools/lib/okf.mjs `load()`), same shape buildBrief expects.
 */
export function buildInstallBlock(docs, engineId, { budgetTokens = DEFAULT_BUDGET_TOKENS } = {}) {
  const meta = engineId ? ENGINE_FILES[engineId] : null;
  const label = meta ? meta.label : (engineId || 'this agent');

  const { markdown: briefMd, warnings } = buildBrief(docs, { engine: meta ? engineId : null, budgetTokens });
  const briefInner = briefMd
    .replace(new RegExp(`^${escapeRe(BRIEF_START)}\\n?`), '')
    .replace(new RegExp(`\\n?${escapeRe(BRIEF_END)}$`), '')
    .trim();

  const header = `<!-- samemind: identity + memory protocol for ${label}. Installed by `
    + `\`samemind install --agent ${engineId || '<id>'}\` — safe to regenerate; edit outside these markers. `
    + `Docs: docs/identity-layer.md · docs/memory-protocol.md · docs/work-discipline.md -->`;

  const body = [header, briefInner, protocolBlock(label)].filter(Boolean).join('\n\n');
  return { block: `${INSTALL_START}\n${body}\n${INSTALL_END}`, warnings };
}

/**
 * Idempotently inserts/replaces `block` between INSTALL_START/END markers in `filePath`.
 * Text outside the markers is never touched; creates the file (and parent dirs — caller's
 * job, see installEngine) if it doesn't exist yet. Same shape as brief.mjs's injectBrief.
 */
export function injectInstallBlock(filePath, block) {
  const target = resolve(filePath);
  const exists = existsSync(target);
  const original = exists ? readFileSync(target, 'utf8') : '';

  const startIdx = original.indexOf(INSTALL_START);
  const endIdx = original.indexOf(INSTALL_END);

  let next;
  let replaced = false;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const tail = original.slice(endIdx + INSTALL_END.length);
    next = original.slice(0, startIdx) + block + tail;
    replaced = true;
  } else if (!exists || !original.trim()) {
    next = `${block}\n`;
  } else {
    next = `${original.replace(/\n*$/, '\n\n')}${block}\n`;
  }

  atomicWriteFileSync(target, next);
  return { file: target, created: !exists, replaced };
}

/** All (relative-path → owning engine ids[]) pairs, in ENGINE_FILES declaration order. */
export function fileOwnerMap() {
  const owners = new Map();
  for (const [id, meta] of Object.entries(ENGINE_FILES)) {
    for (const rel of meta.files) {
      if (!owners.has(rel)) owners.set(rel, []);
      owners.get(rel).push(id);
    }
  }
  return owners;
}

/**
 * Full install for one named engine: writes (creates or updates) every file it owns.
 * For an engine id NOT in ENGINE_FILES, a `file` option is required — then a generic install
 * (buildInstallBlock already renders an unknown id) is written into that one file. Returns
 * { ok:false, reason } for an unknown id without --file — never throws.
 */
export function installEngine(engineId, { targetDir = '.', docs, budgetTokens, file } = {}) {
  const meta = ENGINE_FILES[engineId];
  if (!meta) {
    if (!file) {
      return { ok: false, reason: `unknown engine "${engineId}" — supported ones: \`samemind install --list\`; for any other agent pass \`--file <path>\` for a generic install into that instruction file` };
    }
    const dir = resolve(targetDir);
    const { block, warnings } = buildInstallBlock(docs, engineId, { budgetTokens });
    const abs = resolve(dir, file);
    mkdirSync(dirname(abs), { recursive: true });
    const res = injectInstallBlock(abs, block);
    return { ok: true, id: engineId, label: engineId, generic: true, files: [{ path: file, ...res }], warnings };
  }
  const dir = resolve(targetDir);
  const { block, warnings } = buildInstallBlock(docs, engineId, { budgetTokens });

  const files = meta.files.map(rel => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const res = injectInstallBlock(abs, block);
    return { path: rel, ...res };
  });

  return { ok: true, id: engineId, label: meta.label, files, warnings };
}

/**
 * Conservative `--agent all`: refreshes only instruction files that already exist under
 * targetDir. Never creates a file that isn't there — that's what an explicit
 * `install --agent <id>` is for. A file shared by more than one engine gets the
 * engine-agnostic brief (buildInstallBlock with engineId=null); a file owned by exactly one
 * engine gets that engine's specific brief.
 */
export function installAll({ targetDir = '.', docs, budgetTokens } = {}) {
  const dir = resolve(targetDir);
  const owners = fileOwnerMap();
  const results = [];

  for (const [rel, engineIds] of owners) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue; // conservative: touch only what's already there
    const engineId = engineIds.length === 1 ? engineIds[0] : null;
    const { block } = buildInstallBlock(docs, engineId, { budgetTokens });
    const res = injectInstallBlock(abs, block);
    results.push({ path: rel, engineId, owners: engineIds, ...res });
  }
  return results;
}

function parseArgs(argv) {
  const out = { agent: null, target: null, budget: DEFAULT_BUDGET_TOKENS, list: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') out.agent = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]) || DEFAULT_BUDGET_TOKENS;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--list') out.list = true;
  }
  return out;
}

function printList() {
  console.log('Supported engines (samemind install --agent <id>):');
  for (const [id, meta] of Object.entries(ENGINE_FILES)) {
    console.log(`  ${id.padEnd(13)} ${meta.label} — ${meta.files.join(', ')}`);
  }
  console.log('');
  console.log('  all           install into every instruction file already existing under --target');
  console.log('  + any id via --file <path>  generic install for an unsupported agent into a file you name');
  console.log('');
  console.log('Without MCP: aider — see docs/adapters.md (CONVENTIONS.md via --read, no auto-load).');
  console.log('');
  console.log('Flags: --target <dir> (default cwd) · --budget <n> (identity brief, tokens) · --file <path> (required for an unknown --agent id).');
}

async function main() {
  const { agent, target, budget, list, file } = parseArgs(process.argv.slice(2));

  if (list || !agent) {
    printList();
    process.exitCode = agent ? 0 : (list ? 0 : 1);
    return;
  }

  const targetDir = resolve(target || process.cwd());
  const docs = load({ includeSecret: false });

  if (agent === 'all') {
    const results = installAll({ targetDir, docs, budgetTokens: budget });
    if (!results.length) {
      console.log(`No engine instruction file found in ${targetDir} — nothing touched.`);
      console.log('Install explicitly: samemind install --agent <id> (samemind install --list for the list).');
      return;
    }
    for (const r of results) {
      const verb = r.replaced ? 'updated' : r.created ? 'created' : 'appended';
      console.log(`✓ ${(r.engineId || 'shared').padEnd(13)} ${verb} ${r.path}`);
    }
    return;
  }

  const res = installEngine(agent, { targetDir, docs, budgetTokens: budget, file });
  if (!res.ok) {
    console.error(`✗ ${res.reason}`);
    process.exit(1);
  }
  for (const w of res.warnings || []) console.error(`⚠ ${w}`);
  console.log(`✓ ${res.label} (${res.id})${res.generic ? ' [generic]' : ''} in ${targetDir}:`);
  for (const f of res.files) {
    const verb = f.replaced ? 'updated' : f.created ? 'created' : 'appended';
    console.log(`  ${verb} ${f.path}`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
