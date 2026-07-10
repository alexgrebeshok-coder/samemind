// mcp.mjs — логика MCP-инструментов samemind (транспорт-агностичная; см. ../mcp-server.mjs).
// 5 инструментов: memory_search | memory_get | memory_list | memory_write_inbox | memory_health.
//
// Безопасность (см. наряд N3):
//  - visibility: secret НИКОГДА не попадает в docs, которые видят инструменты (load({includeSecret:false}))
//    — ни search, ни get, ни list; без флагов и без исключений.
//  - memory_get принимает id снаружи → assertSafeConceptId (lib/safe-path.mjs) отклоняет любой
//    path traversal (.., абсолютные пути вне bundle) до похода в файловую систему.
//  - memory_write_inbox пишет ТОЛЬКО в inbox/<agent>.md (имя агента санитизируется);
//    атомарная запись (lib/atomic-write.mjs), append-only; контент с признаками prompt-injection
//    не отклоняется, а оборачивается в quarantine fence (tools/lib/injection.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, load, findById } from './okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, recallSearch, extractSnippet,
} from './recall.mjs';
import { scanForInjection } from './injection.mjs';
import { loadIdx } from '../okf-recall.mjs';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { safeMdPath, assertSafeConceptId, sanitizeAgentName } from '../../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

export const SERVER_NAME = 'samemind';
export const SERVER_VERSION = PKG.version;
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const EMBED_MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: EMBED_MODEL });

// Документы, которые вообще видны MCP-инструментам: НИКОГДА secret, mirror включён (единая
// база памяти агента может законно содержать зеркало живой памяти — не блокируем).
function readableDocs() {
  return load({ includeSecret: false, includeMirror: true }).filter(d => !d.reserved);
}

export const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search the memory bundle (semantic if an index exists and answers, BM25 fallback otherwise). Never returns secret-visibility concepts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        k: { type: 'integer', minimum: 1, description: 'Max results (default 5)' },
        mode: { type: 'string', enum: ['bm25', 'semantic', 'auto'], description: 'Search mode (default auto)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one concept (full frontmatter + body) by id. Refuses secret-visibility concepts and any id outside the bundle (path traversal).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Concept id, e.g. "projects/lumen"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description: 'List concepts in the bundle, optionally filtered by type or tag. Never lists secret-visibility concepts.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by frontmatter type (e.g. Project, Concept)' },
        tag: { type: 'string', description: 'Filter by tag' },
      },
    },
  },
  {
    name: 'memory_write_inbox',
    description: 'Append a note to inbox/<agent>.md — the only writable path. Agent name comes from env SAMEMIND_AGENT (default "mcp"), sanitized to [a-z0-9-]. Content resembling prompt injection is never dropped, only wrapped and flagged quarantine:true.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note body to append' },
        title: { type: 'string', description: 'Optional short heading for the entry' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_health',
    description: 'Bundle root, concept count, active search mode, samemind version.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function memorySearch({ query, k = 5, mode = 'auto' } = {}) {
  if (!query || !String(query).trim()) throw new Error('memory_search: "query" обязателен');
  const kk = Number.isFinite(Number(k)) && Number(k) > 0 ? Math.floor(Number(k)) : 5;
  const docs = readableDocs();
  const docById = new Map(docs.map(d => [d.id, d]));
  const idx = loadIdx();
  const { hits, mode: used, warning } = await recallSearch({
    docs, query, mode, embed, idx, k: kk, includeSecret: false, includeMirror: true,
  });
  const results = hits.map(h => {
    const doc = docById.get(h.id);
    return {
      id: h.id,
      type: h.type || doc?.fm.type || null,
      title: h.title || doc?.fm.title || null,
      score: Number.isFinite(h.score) ? Number(h.score.toFixed(4)) : 0,
      snippet: extractSnippet(doc?.body || '', query, { contextLines: 1 }),
    };
  });
  return { query, mode: used, warning: warning || null, count: results.length, results };
}

async function memoryGet({ id } = {}) {
  const rel = assertSafeConceptId(id, ROOT); // бросает на traversal/пустой id — до похода в docs
  const docs = readableDocs(); // secret уже исключён на уровне load()
  const hits = findById(docs, rel);
  if (!hits.length) return { found: false, id: rel };
  if (hits.length > 1) {
    throw new Error(`memory_get: неоднозначно — ${hits.length} совпадений для «${rel}»: ${hits.map(d => d.id).join(', ')}`);
  }
  const doc = hits[0];
  if ((doc.fm.visibility || 'internal') === 'secret') return { found: false, id: rel }; // defense-in-depth
  const raw = readFileSync(doc.file, 'utf8');
  return {
    found: true,
    id: doc.id,
    type: doc.fm.type || null,
    title: doc.fm.title || null,
    visibility: doc.fm.visibility || 'internal',
    tags: doc.fm.tags || [],
    content: raw,
  };
}

async function memoryList({ type, tag } = {}) {
  let docs = readableDocs();
  if (type) docs = docs.filter(d => (d.fm.type || '').toLowerCase() === String(type).toLowerCase());
  if (tag) docs = docs.filter(d => (d.fm.tags || []).map(t => String(t).toLowerCase()).includes(String(tag).toLowerCase()));
  return {
    count: docs.length,
    items: docs
      .map(d => ({ id: d.id, type: d.fm.type || null, title: d.fm.title || null, visibility: d.fm.visibility || 'internal' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function memoryWriteInbox({ content, title } = {}) {
  if (content === undefined || content === null || !String(content).trim()) {
    throw new Error('memory_write_inbox: "content" обязателен и не может быть пустым');
  }
  const agent = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const inboxDir = join(ROOT, 'inbox');
  const target = safeMdPath(inboxDir, agent);

  const text = String(content);
  const scan = scanForInjection(text);
  const timestamp = new Date().toISOString();
  const heading = title && String(title).trim() ? String(title).trim() : '(без заголовка)';

  const block = scan.flagged
    ? [
      `## ${timestamp} — ${heading}`,
      `quarantine: true  <!-- паттерны: ${scan.matches.join(', ')} -->`,
      '',
      '```quarantine',
      text,
      '```',
      '',
    ].join('\n')
    : [
      `## ${timestamp} — ${heading}`,
      '',
      text.trim(),
      '',
    ].join('\n');

  const existing = existsSync(target)
    ? readFileSync(target, 'utf8')
    : `---\nokf_version: "0.1"\n---\n\n# Inbox — ${agent}\n\nAppend-only заметки, записанные через samemind MCP (memory_write_inbox).\n\n`;

  const next = `${existing.replace(/\n*$/, '\n\n')}${block}\n`;
  atomicWriteFileSync(target, next);

  return {
    ok: true,
    agent,
    file: relative(ROOT, target),
    quarantined: scan.flagged,
    matches: scan.matches,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
  };
}

async function memoryHealth() {
  const docs = readableDocs();
  const idx = loadIdx();
  const hasIndex = !!(idx && idx.items && Object.keys(idx.items).length > 0);
  return {
    root: ROOT,
    concepts: docs.length,
    searchMode: hasIndex ? 'semantic (index present; BM25 fallback if endpoint unavailable)' : 'bm25 (no semantic index — set OKF_EMBED_URL + run recall index)',
    embedUrl: process.env.OKF_EMBED_URL || null,
    version: SERVER_VERSION,
  };
}

const HANDLERS = {
  memory_search: memorySearch,
  memory_get: memoryGet,
  memory_list: memoryList,
  memory_write_inbox: memoryWriteInbox,
  memory_health: memoryHealth,
};

/** Выполняет вызов инструмента, никогда не бросает — ошибки → { isError: true }. */
export async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}
