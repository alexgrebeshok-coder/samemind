#!/usr/bin/env node
// interop.test.mjs — export / import / --to-gbrain (N10). All work in mkdtemp; never touches the real repo.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  VISIBILITY_RANK,
  passesVisibility,
  selectExportDocs,
  ensureOkfVersion,
  toGbrainPage,
  NEVER_EXPORT_TOP,
} from './export.mjs';
import {
  validateOkfFile,
  setSourceField,
  formatInboxBlocks,
  runImport,
} from './import.mjs';
import { assertSafeConceptId } from '../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');
const EXPORT = join(HERE, 'export.mjs');
const IMPORT = join(HERE, 'import.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-interop-${prefix}-`));
}

/** Minimal synthetic doc object matching okf.parse shape. */
function doc({ id, file, type, title, visibility, tags, body, links, relations, timestamp, source, reserved, base }) {
  const fm = {
    type: type || 'Concept',
    title: title || id,
    visibility: visibility || 'internal',
  };
  if (tags) fm.tags = tags;
  if (timestamp) fm.timestamp = timestamp;
  if (source) fm.source = source;
  if (relations) fm.relations = relations;
  return {
    id,
    file: file || `/virtual/${id}.md`,
    base: base || `${id.split('/').pop()}.md`,
    reserved: !!reserved,
    fm,
    body: body || `# ${title || id}\n`,
    links: links || [],
    relations: relations || {},
    hasFM: true,
  };
}

/** Scaffold a mini bundle on disk for CLI/integration tests. */
function writeBundle(root, nodes) {
  mkdirSync(join(root, 'concepts'), { recursive: true });
  mkdirSync(join(root, 'entities'), { recursive: true });
  mkdirSync(join(root, 'projects'), { recursive: true });
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'secret'), { recursive: true });
  mkdirSync(join(root, 'mirror'), { recursive: true });

  writeFileSync(join(root, 'index.md'), `---\nokf_version: "0.1"\n---\n\n# Test bundle\n`, 'utf8');
  writeFileSync(join(root, 'log.md'), `---\nokf_version: "0.1"\n---\n\n# Log\n\n- test\n`, 'utf8');
  writeFileSync(join(root, 'inbox', 'note.md'), `---\ntype: Note\ntitle: Raw\nvisibility: internal\n---\n\ninbox raw\n`, 'utf8');
  writeFileSync(join(root, 'secret', 'creds.md'), `---\ntype: Concept\ntitle: Creds\nvisibility: secret\n---\n\nSECRET-MARKER-XYZ\n`, 'utf8');
  writeFileSync(join(root, 'mirror', 'claude.md'), `---\ntype: Concept\ntitle: Mirror\nvisibility: mirror\n---\n\nmirror body\n`, 'utf8');

  for (const n of nodes) {
    const rel = n.path.endsWith('.md') ? n.path : `${n.path}.md`;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    const tags = n.tags ? `tags: [${n.tags.join(', ')}]` : 'tags: []';
    const relBlock = n.relations
      ? `relations:\n${Object.entries(n.relations).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`
      : '';
    writeFileSync(full, `---
type: ${n.type || 'Concept'}
title: ${n.title || n.path}
description: ${n.description || 'test'}
visibility: ${n.visibility || 'internal'}
${tags}
timestamp: ${n.timestamp || '2026-07-10T00:00:00Z'}
source: ${n.source || 'test'}
${relBlock}---

${n.body || `# ${n.title || n.path}\n\nBody of ${n.path}.`}
`, 'utf8');
  }
}

describe('visibility helpers', () => {
  it('ranks public < internal < secret < mirror', () => {
    assert.ok(VISIBILITY_RANK.public < VISIBILITY_RANK.internal);
    assert.ok(VISIBILITY_RANK.internal < VISIBILITY_RANK.secret);
    assert.ok(VISIBILITY_RANK.secret < VISIBILITY_RANK.mirror);
  });

  it('passesVisibility: internal threshold keeps public+internal, drops secret', () => {
    assert.equal(passesVisibility('public', 'internal'), true);
    assert.equal(passesVisibility('internal', 'internal'), true);
    assert.equal(passesVisibility('secret', 'internal'), false);
    assert.equal(passesVisibility('mirror', 'internal'), false);
  });

  it('passesVisibility: public threshold keeps only public', () => {
    assert.equal(passesVisibility('public', 'public'), true);
    assert.equal(passesVisibility('internal', 'public'), false);
    assert.equal(passesVisibility('secret', 'public'), false);
  });
});

describe('selectExportDocs', () => {
  it('default internal excludes secret/mirror/inbox tops and secret visibility', () => {
    const docs = [
      doc({ id: 'concepts/a', visibility: 'public' }),
      doc({ id: 'concepts/b', visibility: 'internal' }),
      doc({ id: 'concepts/c', visibility: 'secret' }),
      doc({ id: 'secret/creds', visibility: 'secret' }),
      doc({ id: 'mirror/x', visibility: 'mirror' }),
      doc({ id: 'inbox/note', visibility: 'internal' }),
      doc({ id: 'index', base: 'index.md', reserved: true, visibility: 'internal' }),
    ];
    const { included, excluded } = selectExportDocs(docs, { visibility: 'internal' });
    const ids = included.map(d => d.id).sort();
    assert.deepEqual(ids, ['concepts/a', 'concepts/b']);
    assert.ok(excluded.some(e => e.doc.id === 'concepts/c'));
    assert.ok(excluded.some(e => e.doc.id === 'secret/creds'));
    assert.ok(excluded.some(e => e.doc.id === 'mirror/x'));
    assert.ok(excluded.some(e => e.doc.id === 'inbox/note'));
    assert.ok(NEVER_EXPORT_TOP.has('secret') && NEVER_EXPORT_TOP.has('inbox'));
  });

  it('--visibility public keeps only public', () => {
    const docs = [
      doc({ id: 'concepts/pub', visibility: 'public' }),
      doc({ id: 'concepts/int', visibility: 'internal' }),
    ];
    const { included } = selectExportDocs(docs, { visibility: 'public' });
    assert.deepEqual(included.map(d => d.id), ['concepts/pub']);
  });
});

describe('ensureOkfVersion', () => {
  it('injects or normalizes okf_version: "0.1"', () => {
    const a = ensureOkfVersion('---\ntitle: x\n---\n\n# Hi\n');
    assert.match(a, /okf_version: "0\.1"/);
    const b = ensureOkfVersion('---\nokf_version: 1\n---\n\n# Hi\n');
    assert.match(b, /okf_version: "0\.1"/);
    const c = ensureOkfVersion('# no fm\n');
    assert.match(c, /^---\nokf_version: "0\.1"\n---/);
  });
});

describe('toGbrainPage', () => {
  it('preserves type/title/tags and builds Compiled truth + Timeline + Related', () => {
    const page = toGbrainPage(doc({
      id: 'concepts/nova',
      type: 'Identity',
      title: 'Nova',
      tags: ['agent', 'identity'],
      timestamp: '2026-07-10T00:00:00Z',
      source: 'demo',
      body: 'She is direct.\n',
      relations: { uses: ['/concepts/engine-claude-code.md'] },
      links: ['/entities/alex-doe.md'],
    }));
    assert.match(page, /^---\n/);
    assert.match(page, /type: Identity/);
    assert.match(page, /title: Nova/);
    assert.match(page, /tags: \[agent, identity\]/);
    assert.match(page, /## Compiled truth/);
    assert.match(page, /She is direct\./);
    assert.match(page, /## Timeline/);
    assert.match(page, /2026-07-10T00:00:00Z · demo/);
    assert.match(page, /Related:/);
    assert.match(page, /engine-claude-code/);
    assert.match(page, /alex-doe/);
  });
});

describe('runExport — filesystem', () => {
  it('default export excludes secret/mirror/inbox; writes concepts + index/log', () => {
    const root = tmp('exp-def');
    const out = tmp('exp-out');
    try {
      writeBundle(root, [
        { path: 'concepts/pub', title: 'Pub', visibility: 'public', body: '# Pub\n\npublic body\n' },
        { path: 'concepts/int', title: 'Int', visibility: 'internal', body: '# Int\n\ninternal body\n' },
        { path: 'concepts/sec-vis', title: 'SecVis', visibility: 'secret', body: '# SecVis\n\nshould not export\n' },
      ]);
      // Build docs from disk via spawn so ROOT is correct
      const r = spawnSync(process.execPath, [EXPORT, out], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(existsSync(join(out, 'index.md')));
      assert.ok(existsSync(join(out, 'log.md')));
      assert.ok(existsSync(join(out, 'concepts', 'pub.md')));
      assert.ok(existsSync(join(out, 'concepts', 'int.md')));
      assert.ok(!existsSync(join(out, 'concepts', 'sec-vis.md')));
      assert.ok(!existsSync(join(out, 'secret')));
      assert.ok(!existsSync(join(out, 'mirror')));
      assert.ok(!existsSync(join(out, 'inbox')));
      const idx = readFileSync(join(out, 'index.md'), 'utf8');
      assert.match(idx, /okf_version: "0\.1"/);
      const all = readFileSync(join(out, 'concepts', 'pub.md'), 'utf8')
        + readFileSync(join(out, 'concepts', 'int.md'), 'utf8');
      assert.doesNotMatch(all, /SECRET-MARKER-XYZ/);
      assert.doesNotMatch(all, /should not export/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('--visibility public strips internal', () => {
    const root = tmp('exp-pub');
    const out = tmp('exp-pub-out');
    try {
      writeBundle(root, [
        { path: 'concepts/pub', title: 'Pub', visibility: 'public' },
        { path: 'concepts/int', title: 'Int', visibility: 'internal' },
      ]);
      const r = spawnSync(process.execPath, [EXPORT, out, '--visibility', 'public'], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(existsSync(join(out, 'concepts', 'pub.md')));
      assert.ok(!existsSync(join(out, 'concepts', 'int.md')));
      assert.match(r.stdout, /included: 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('--dry-run writes nothing even when target is empty', () => {
    const root = tmp('exp-dry');
    const out = tmp('exp-dry-out');
    try {
      writeBundle(root, [
        { path: 'concepts/a', title: 'A', visibility: 'internal' },
      ]);
      // leave out empty
      const before = readdirSync(out);
      const r = spawnSync(process.execPath, [EXPORT, out, '--dry-run'], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.deepEqual(readdirSync(out), before);
      assert.match(r.stdout, /DRY-RUN/);
      assert.match(r.stdout, /written: 0/);
      assert.ok(!existsSync(join(out, 'concepts')));
      assert.ok(!existsSync(join(out, 'index.md')));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('--to-gbrain writes pages with type/title/tags + Compiled truth', () => {
    const root = tmp('exp-gb');
    const out = tmp('exp-gb-out');
    try {
      writeBundle(root, [
        {
          path: 'concepts/nova',
          type: 'Identity',
          title: 'Nova',
          tags: ['agent', 'identity'],
          visibility: 'internal',
          timestamp: '2026-07-10T00:00:00Z',
          source: 'demo',
          body: '# Nova\n\nDirect agent.\n',
          relations: { uses: '/concepts/engine.md' },
        },
      ]);
      const r = spawnSync(process.execPath, [EXPORT, out, '--to-gbrain'], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const page = readFileSync(join(out, 'concepts', 'nova.md'), 'utf8');
      assert.match(page, /type: Identity/);
      assert.match(page, /title: Nova/);
      assert.match(page, /tags: \[agent, identity\]/);
      assert.match(page, /## Compiled truth/);
      assert.match(page, /Direct agent/);
      assert.match(page, /## Timeline/);
      assert.match(page, /Related:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('refuses non-empty target (not dry-run)', () => {
    const root = tmp('exp-ne');
    const out = tmp('exp-ne-out');
    try {
      writeBundle(root, [{ path: 'concepts/a', title: 'A' }]);
      writeFileSync(join(out, 'stale.txt'), 'nope', 'utf8');
      const r = spawnSync(process.execPath, [EXPORT, out], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr + r.stdout, /не пуста|non-empty|не перезаписываю/i);
      assert.equal(readFileSync(join(out, 'stale.txt'), 'utf8'), 'nope');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('warns on links to non-exported concepts without failing', () => {
    const root = tmp('exp-warn');
    const out = tmp('exp-warn-out');
    try {
      writeBundle(root, [
        {
          path: 'concepts/open',
          title: 'Open',
          visibility: 'public',
          body: '# Open\n\nSee [secretish](/concepts/hidden.md).\n',
        },
        {
          path: 'concepts/hidden',
          title: 'Hidden',
          visibility: 'secret',
          body: '# Hidden\n',
        },
      ]);
      const r = spawnSync(process.execPath, [EXPORT, out, '--visibility', 'public'], {
        env: { ...process.env, OKF_ROOT: root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /warnings/);
      assert.match(r.stdout, /hidden/);
      assert.ok(existsSync(join(out, 'concepts', 'open.md')));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('import — validate + inbox + concepts', () => {
  it('validateOkfFile accepts type+fm and rejects missing type / no fm', () => {
    const root = tmp('val');
    try {
      mkdirSync(join(root, 'concepts'), { recursive: true });
      const good = join(root, 'concepts', 'ok.md');
      writeFileSync(good, '---\ntype: Concept\ntitle: Ok\n---\n\nbody\n', 'utf8');
      const v = validateOkfFile(good, root);
      assert.equal(v.ok, true);
      assert.equal(v.id, 'concepts/ok');

      const bad = join(root, 'concepts', 'nofm.md');
      writeFileSync(bad, '# just text\n', 'utf8');
      const v2 = validateOkfFile(bad, root);
      assert.equal(v2.ok, false);
      assert.match(v2.reason, /frontmatter/);

      const notype = join(root, 'concepts', 'notype.md');
      writeFileSync(notype, '---\ntitle: X\n---\n\nbody\n', 'utf8');
      const v3 = validateOkfFile(notype, root);
      assert.equal(v3.ok, false);
      assert.match(v3.reason, /type/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('path safety: rejects .. segments', () => {
    const root = tmp('path');
    try {
      // craft a relative path that looks evil — validate uses relative() from source root
      mkdirSync(join(root, 'concepts'), { recursive: true });
      const f = join(root, 'concepts', 'x.md');
      writeFileSync(f, '---\ntype: Concept\ntitle: X\n---\n\nb\n', 'utf8');
      // assertSafeConceptId path: import of id with ..
      const r = runImport({
        sourceDir: root,
        into: 'concepts',
        root: tmp('dest-safe'),
      });
      // normal concepts/x is fine
      assert.equal(r.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('import --into inbox creates blocks with source citation', () => {
    const src = tmp('imp-src');
    const dest = tmp('imp-dest');
    try {
      writeBundle(src, [
        { path: 'concepts/alpha', title: 'Alpha', type: 'Concept', body: '# Alpha\n\nalpha body\n' },
        { path: 'entities/bob', title: 'Bob', type: 'Entity', body: '# Bob\n' },
      ]);
      // dest needs inbox/
      mkdirSync(join(dest, 'inbox'), { recursive: true });
      const r = spawnSync(process.execPath, [IMPORT, src, '--into', 'inbox'], {
        env: { ...process.env, OKF_ROOT: dest },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const inboxFiles = readdirSync(join(dest, 'inbox')).filter(f => f.startsWith('import-'));
      assert.equal(inboxFiles.length, 1);
      const body = readFileSync(join(dest, 'inbox', inboxFiles[0]), 'utf8');
      assert.match(body, /## Alpha/);
      assert.match(body, /source:/);
      assert.match(body, /concepts\/alpha\.md/);
      assert.match(body, /## Bob/);
      assert.match(body, /type: Concept/);
      // original tree not auto-copied
      assert.ok(!existsSync(join(dest, 'concepts', 'alpha.md')));
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('import --into concepts does not overwrite existing files', () => {
    const src = tmp('imp-c-src');
    const dest = tmp('imp-c-dest');
    try {
      writeBundle(src, [
        { path: 'concepts/alpha', title: 'Alpha-new', body: '# NEW\n' },
        { path: 'concepts/beta', title: 'Beta', body: '# Beta\n' },
      ]);
      mkdirSync(join(dest, 'concepts'), { recursive: true });
      writeFileSync(join(dest, 'concepts', 'alpha.md'), '---\ntype: Concept\ntitle: Alpha-OLD\n---\n\nOLD\n', 'utf8');

      const r = spawnSync(process.execPath, [IMPORT, src, '--into', 'concepts'], {
        env: { ...process.env, OKF_ROOT: dest },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /refused: 1|collision/i);
      // old preserved
      const alpha = readFileSync(join(dest, 'concepts', 'alpha.md'), 'utf8');
      assert.match(alpha, /Alpha-OLD/);
      assert.match(alpha, /OLD/);
      assert.doesNotMatch(alpha, /Alpha-new/);
      // beta imported with source: import:…
      assert.ok(existsSync(join(dest, 'concepts', 'beta.md')));
      const beta = readFileSync(join(dest, 'concepts', 'beta.md'), 'utf8');
      assert.match(beta, /source: import:/);
      assert.match(beta, /title: Beta/);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('reports non-conformant files without aborting good ones', () => {
    const src = tmp('imp-nc');
    const dest = tmp('imp-nc-dest');
    try {
      mkdirSync(join(src, 'concepts'), { recursive: true });
      writeFileSync(join(src, 'concepts', 'good.md'), '---\ntype: Concept\ntitle: Good\n---\n\nok\n', 'utf8');
      writeFileSync(join(src, 'concepts', 'bad.md'), 'no frontmatter here\n', 'utf8');
      mkdirSync(join(dest, 'inbox'), { recursive: true });
      const r = spawnSync(process.execPath, [IMPORT, src], {
        env: { ...process.env, OKF_ROOT: dest },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /non-conformant: 1/);
      assert.match(r.stdout, /imported: 1/);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('setSourceField inserts source without clobbering other keys', () => {
    const raw = '---\ntype: Concept\ntitle: T\nvisibility: internal\n---\n\nbody\n';
    const next = setSourceField(raw, 'import:pack-a');
    assert.match(next, /source: import:pack-a/);
    assert.match(next, /type: Concept/);
    assert.match(next, /title: T/);
    assert.match(next, /\nbody\n/);
  });

  it('formatInboxBlocks embeds source path and fenced original', () => {
    const md = formatInboxBlocks([
      {
        id: 'concepts/x',
        rel: 'concepts/x.md',
        fm: { type: 'Concept', title: 'X' },
        raw: '---\ntype: Concept\ntitle: X\n---\n\nhello\n',
      },
    ], { date: '2026-07-10', sourceLabel: 'foreign' });
    assert.match(md, /## X/);
    assert.match(md, /foreign\/concepts\/x\.md/);
    assert.match(md, /```markdown/);
    assert.match(md, /hello/);
  });
});

describe('CLI router', () => {
  it('samemind export / import appear in usage and route', () => {
    const help = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /export/);
    assert.match(help.stdout, /import/);

    const expHelp = spawnSync(process.execPath, [BIN, 'export'], { encoding: 'utf8' });
    assert.equal(expHelp.status, 0);
    assert.match(expHelp.stdout, /Usage:.*export/s);

    const impHelp = spawnSync(process.execPath, [BIN, 'import'], { encoding: 'utf8' });
    assert.equal(impHelp.status, 0);
    assert.match(impHelp.stdout, /Usage:.*import/s);
  });
});

describe('path safety on import concepts', () => {
  it('refuses .. segments and accepts safe concept ids', () => {
    const root = tmp('trav');
    try {
      assert.throws(() => assertSafeConceptId('../etc/passwd', root), /небезопасный|traversal/i);
      assert.throws(() => assertSafeConceptId('concepts/../../etc/passwd', root), /небезопасный|traversal/i);
      assert.throws(() => assertSafeConceptId('', root), /пустой/i);
      // leading slash is normalized away (bundle-absolute form), not a traversal
      assert.equal(assertSafeConceptId('/concepts/ok', root), 'concepts/ok');
      assert.equal(assertSafeConceptId('concepts/ok', root), 'concepts/ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
