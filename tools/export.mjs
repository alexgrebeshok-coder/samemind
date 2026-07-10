#!/usr/bin/env node
// export.mjs — samemind export: shareable OKF-bundle without secrets.
//   node tools/export.mjs <target-dir> [--visibility public|internal] [--dry-run] [--to-gbrain]
//
// Copies concepts whose visibility ≤ threshold into an empty target dir.
// NEVER exports: secret/, mirror/, inbox/. Broken links to stripped nodes → warnings only.
// --to-gbrain: map each concept to a garrytan/gbrain-style page (see docs/interop.md).
import {
  existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, statSync,
} from 'node:fs';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, load, resolveLink, resolveRelationPath, pathToId,
} from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

/** visibility rank — lower = more open. Export if rank(doc) ≤ rank(threshold). */
export const VISIBILITY_RANK = Object.freeze({
  public: 0,
  internal: 1,
  secret: 2,
  mirror: 3,
});

/** Top-level dirs that must never leave the machine. */
export const NEVER_EXPORT_TOP = Object.freeze(new Set(['secret', 'mirror', 'inbox']));

export function visibilityRank(v) {
  const key = String(v || 'internal').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(VISIBILITY_RANK, key)
    ? VISIBILITY_RANK[key]
    : VISIBILITY_RANK.internal;
}

export function passesVisibility(docVis, threshold) {
  return visibilityRank(docVis) <= visibilityRank(threshold);
}

/** Top-level folder of a bundle-relative id/path. */
export function topLevelOf(idOrPath) {
  const rel = String(idOrPath || '').replace(/^\//, '').replace(/\.md$/, '');
  return rel.split(/[/\\]/)[0] || '';
}

/**
 * Ensure root index frontmatter carries okf_version: "0.1" (Google OKF v0.1 marker).
 * Other keys/body left intact.
 */
export function ensureOkfVersion(raw) {
  const text = String(raw || '');
  if (/^---\n[\s\S]*?\n---/.test(text)) {
    if (/^okf_version:\s*/m.test(text.slice(0, text.indexOf('\n---') + 1))) {
      return text.replace(/^okf_version:\s*.*$/m, 'okf_version: "0.1"');
    }
    return text.replace(/^---\n/, '---\nokf_version: "0.1"\n');
  }
  return `---\nokf_version: "0.1"\n---\n\n${text}`;
}

/**
 * Decide which docs leave the bundle.
 * Returns { included: Doc[], excluded: {doc, reason}[], warnings: string[] }.
 * Docs are raw walk results (need file paths); reserved root index/log handled separately.
 */
export function selectExportDocs(docs, { visibility = 'internal' } = {}) {
  const included = [];
  const excluded = [];
  for (const d of docs) {
    const top = topLevelOf(d.id);
    // Root index.md / log.md are handled by copyRootFiles, not as concepts.
    if (d.reserved && (d.base === 'index.md' || d.base === 'log.md')) {
      excluded.push({ doc: d, reason: 'root reserved (copied separately as index/log)' });
      continue;
    }
    if (NEVER_EXPORT_TOP.has(top)) {
      excluded.push({ doc: d, reason: `top-level «${top}/» never exported` });
      continue;
    }
    // Folder indexes (concepts/index.md etc.) — reserved basename, not concepts; skip.
    if (d.reserved) {
      excluded.push({ doc: d, reason: 'reserved basename (not a concept)' });
      continue;
    }
    const vis = d.fm?.visibility || 'internal';
    if (!passesVisibility(vis, visibility)) {
      excluded.push({ doc: d, reason: `visibility «${vis}» > threshold «${visibility}»` });
      continue;
    }
    included.push(d);
  }
  return { included, excluded };
}

/**
 * Broken link / relation targets relative to the export set.
 * Only reports links that resolve inside the source bundle but are not exported.
 */
export function findBrokenExportLinks(included, { root = ROOT } = {}) {
  const exportedIds = new Set(included.map(d => d.id));
  // also treat exported paths with .md
  const exportedFiles = new Set(included.map(d => resolve(d.file)));
  const warnings = [];

  for (const d of included) {
    for (const link of d.links || []) {
      const resolved = resolveLink(d.file, link);
      if (!resolved || !existsSync(resolved)) continue; // already dead in source — not our job
      const id = relative(root, resolved).replace(/\.md$/, '');
      if (NEVER_EXPORT_TOP.has(topLevelOf(id))) {
        warnings.push(`${d.id}: link → /${id}.md (stripped: ${topLevelOf(id)}/)`);
        continue;
      }
      if (!exportedFiles.has(resolve(resolved)) && !exportedIds.has(id)) {
        warnings.push(`${d.id}: link → /${id}.md (not in export set)`);
      }
    }
    const rel = d.relations || {};
    for (const [type, paths] of Object.entries(rel)) {
      for (const p of paths) {
        const resolved = resolveRelationPath(p);
        if (!resolved || !existsSync(resolved)) continue;
        const cleanId = relative(root, resolved).replace(/\.md$/, '');
        if (NEVER_EXPORT_TOP.has(topLevelOf(cleanId))) {
          warnings.push(`${d.id}: relation ${type} → /${cleanId}.md (stripped: ${topLevelOf(cleanId)}/)`);
          continue;
        }
        if (!exportedFiles.has(resolve(resolved)) && !exportedIds.has(cleanId)) {
          warnings.push(`${d.id}: relation ${type} → /${cleanId}.md (not in export set)`);
        }
      }
    }
  }
  return warnings;
}

/**
 * Map one OKF concept → gbrain page markdown.
 * Preserves type/title/tags; body → ## Compiled truth; timeline from timestamp+source;
 * relations → Related: line. See docs/interop.md for what is lost.
 */
export function toGbrainPage(doc) {
  const fm = doc.fm || {};
  const type = fm.type || 'Concept';
  const title = fm.title || doc.id;
  const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []);
  const tagsLine = tags.length
    ? `tags: [${tags.map(t => String(t)).join(', ')}]`
    : 'tags: []';

  const body = String(doc.body || '').replace(/^\s+/, '').replace(/\s+$/, '');
  const ts = fm.timestamp ? String(fm.timestamp) : '';
  const source = fm.source ? String(fm.source) : '';
  let timeline = '- (no timestamp/source on source concept)';
  if (ts || source) {
    timeline = `- ${ts || '(no timestamp)'}${source ? ` · ${source}` : ''}`;
  }

  const relatedParts = [];
  const rel = doc.relations || {};
  for (const paths of Object.values(rel)) {
    for (const p of paths) {
      const id = pathToId(p);
      const label = id.split('/').pop() || id;
      // gbrain-style wiki-ish path reference; keep OKF absolute path form for round-trip hints
      relatedParts.push(`[${label}](${p.startsWith('/') ? p : '/' + p})`);
    }
  }
  // also surface body markdown links as Related
  for (const link of doc.links || []) {
    const abs = link.startsWith('/') ? link : `/${link}`;
    const label = pathToId(abs).split('/').pop() || abs;
    const entry = `[${label}](${abs})`;
    if (!relatedParts.includes(entry)) relatedParts.push(entry);
  }
  const relatedLine = relatedParts.length
    ? `Related: ${relatedParts.join(', ')}`
    : '';

  const lines = [
    '---',
    `type: ${type}`,
    `title: ${title}`,
    tagsLine,
    '---',
    '',
    '## Compiled truth',
    '',
    body || '_(empty)_',
    '',
    '## Timeline',
    '',
    timeline,
  ];
  if (relatedLine) {
    lines.push('', relatedLine);
  }
  lines.push('');
  return lines.join('\n');
}

/** Refuse non-empty target (same contract as init). */
export function assertEmptyTarget(targetDir) {
  const dir = resolve(targetDir);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      return { ok: false, reason: `«${dir}» существует и не является папкой` };
    }
    const entries = readdirSync(dir);
    if (entries.length > 0) {
      return {
        ok: false,
        reason: `папка «${dir}» не пуста (${entries.length} элементов) — export только в пустую папку, ничего не перезаписываю`,
      };
    }
  }
  return { ok: true, dir };
}

/**
 * Run export.
 * @returns {{ ok, dir?, included, excluded, warnings, written: string[], dryRun, toGbrain, reason? }}
 */
export function runExport({
  targetDir,
  visibility = 'internal',
  dryRun = false,
  toGbrain = false,
  root = ROOT,
  docs,
} = {}) {
  if (!targetDir) {
    return { ok: false, reason: 'нужен target-dir: samemind export <dir> [--visibility public|internal] [--dry-run] [--to-gbrain]' };
  }

  const visKey = String(visibility || 'internal').toLowerCase();
  if (visKey !== 'public' && visKey !== 'internal') {
    return { ok: false, reason: `--visibility должен быть public|internal (получено «${visibility}»)` };
  }

  const empty = assertEmptyTarget(targetDir);
  if (!empty.ok && !dryRun) return { ...empty, included: [], excluded: [], warnings: [], written: [], dryRun, toGbrain };
  // dry-run may target a non-empty path — we just report, never write
  const dir = resolve(targetDir);

  // Load with secret+mirror so exclusion reasons are visible in the report;
  // selection still strips them via NEVER_EXPORT_TOP + visibility.
  const all = docs || (() => {
    // Temporarily walk with secret/mirror if present under root.
    // load() uses module ROOT; for tests pass docs explicitly or set OKF_ROOT.
    return load({ includeSecret: true, includeMirror: true });
  })();

  const { included, excluded } = selectExportDocs(all, { visibility: visKey });
  // Also record anything under never-export tops that load might have skipped
  // (when includeSecret/includeMirror false). With true flags we already see them.
  const warnings = findBrokenExportLinks(included, { root });

  const written = [];
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });

    // Root index.md + log.md
    const srcIndex = join(root, 'index.md');
    const srcLog = join(root, 'log.md');
    if (existsSync(srcIndex)) {
      const content = ensureOkfVersion(readFileSync(srcIndex, 'utf8'));
      const dest = join(dir, 'index.md');
      atomicWriteFileSync(dest, content);
      written.push('index.md');
    } else {
      atomicWriteFileSync(join(dir, 'index.md'), ensureOkfVersion('# Exported OKF bundle\n'));
      written.push('index.md');
    }
    if (existsSync(srcLog)) {
      atomicWriteFileSync(join(dir, 'log.md'), readFileSync(srcLog, 'utf8'));
      written.push('log.md');
    } else {
      atomicWriteFileSync(join(dir, 'log.md'), ensureOkfVersion('# Log\n\n- export snapshot\n'));
      written.push('log.md');
    }

    for (const d of included) {
      const relPath = relative(root, d.file);
      // path safety: refuse escape
      const dest = resolve(dir, relPath);
      const rootPrefix = resolve(dir) + sep;
      if (!dest.startsWith(rootPrefix) && dest !== resolve(dir)) {
        warnings.push(`skip unsafe path: ${relPath}`);
        continue;
      }
      if (toGbrain) {
        // gbrain: flat-ish pages under same relative path, rewritten body
        atomicWriteFileSync(dest, toGbrainPage(d));
      } else {
        // byte-faithful copy of the concept file
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(d.file, dest);
      }
      written.push(relPath);
    }
  }

  return {
    ok: true,
    dir,
    included,
    excluded,
    warnings,
    written,
    dryRun,
    toGbrain,
    visibility: visKey,
  };
}

export function formatExportReport(result) {
  const lines = [];
  const mode = result.dryRun ? 'DRY-RUN' : (result.toGbrain ? 'EXPORT→gbrain' : 'EXPORT');
  lines.push(`${mode} visibility=${result.visibility || 'internal'} → ${result.dir}`);
  lines.push(`included: ${result.included.length}`);
  for (const d of result.included) {
    const vis = d.fm?.visibility || 'internal';
    lines.push(`  + ${d.id}  [${vis}]`);
  }
  lines.push(`excluded: ${result.excluded.length}`);
  // Group by reason prefix for readability; still list each id
  for (const { doc, reason } of result.excluded) {
    lines.push(`  − ${doc.id}  (${reason})`);
  }
  if (result.warnings.length) {
    lines.push(`warnings (broken links to non-exported): ${result.warnings.length}`);
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
  } else {
    lines.push('warnings: 0');
  }
  if (!result.dryRun) {
    lines.push(`written: ${result.written.length} files`);
  } else {
    lines.push('written: 0 (dry-run — disk untouched)');
  }
  return lines.join('\n');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    targetDir: null,
    visibility: 'internal',
    dryRun: false,
    toGbrain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--to-gbrain') out.toGbrain = true;
    else if (a === '--visibility') out.visibility = argv[++i] || 'internal';
    else if (a.startsWith('--visibility=')) out.visibility = a.slice('--visibility='.length);
    else if (!a.startsWith('--') && !out.targetDir) out.targetDir = a;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.targetDir) {
    console.log('Usage: samemind export <target-dir> [--visibility public|internal] [--dry-run] [--to-gbrain]');
    console.log('');
    console.log('  Копирует shareable OKF-bundle (без secret/mirror/inbox).');
    console.log('  target-dir должна быть пустой (как init). --dry-run — только отчёт.');
    console.log('  --to-gbrain — страницы в формате garrytan/gbrain (см. docs/interop.md).');
    return 0;
  }
  const result = runExport(opts);
  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    return 1;
  }
  console.log(formatExportReport(result));
  if (!result.dryRun) {
    console.log(`✓ bundle → ${result.dir}`);
  }
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }).then(code => {
    if (typeof code === 'number') process.exit(code);
  });
}
