// project.mjs — движок-нейтральное ядро проекции памяти (рендер курируемых фактов /
// обрезка блока / вырезание секций и маркер-блоков), вынесено из внутреннего
// оркестратора (~/.claude/memory-bridge/sync.mjs). Чистые функции над данными:
// без fs/сети/process.env/console — вход и выход только через параметры, дефолты
// на английском. Побочные эффекты (чтение канона с диска, логирование, env-флаги)
// остаются на стороне вызывающего кода.

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…(truncated, ${s.length} chars total)`;
}

/** Dedup entries by `name`, first occurrence wins. Callers already sort entries into their
 *  target order (freshness / hygiene score) — this only drops later duplicates, it never
 *  reorders. Root fix for the "stale copy shadows the fresh one" class of bug: when the same
 *  curated fact shows up more than once across snapshots/files, keep the first (= most
 *  relevant per the caller's ordering) and discard the rest. */
export function dedupeByName(entries) {
  const seen = new Set();
  return entries.filter(e => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

/**
 * Render a list of curated-fact entries `{ name, desc, body }` (already sorted by the caller —
 * NOT re-sorted here) into markdown. Two modes:
 *   - indexTail=false (default): every entry rendered in full (clamped to maxFactChars).
 *   - indexTail=true: the first `coreFresh` entries in full, the rest collapsed into a
 *     one-line index (`- **name** — desc`) under `indexHeading`, with `recallHint` as a pointer
 *     to fetch the full text elsewhere (e.g. via search/recall).
 * Dedupes by name first (see dedupeByName) — a duplicate never eats into coreFresh's budget.
 */
export function renderFactEntries(entries, {
  maxFactChars = 6000,
  indexTail = false,
  coreFresh = 12,
  recallHint = 'Full text via samemind MCP memory_search/memory_get or CLI recall.',
  indexHeading = 'Index of other memories',
  emptyLabel = '(no curated facts)',
} = {}) {
  const deduped = dedupeByName(entries);
  if (!deduped.length) return `_${emptyLabel}_\n`;

  const full = (e) => `### ${e.name}\n${e.desc ? `_${e.desc}_\n\n` : ''}${clamp(e.body, maxFactChars)}\n`;
  if (!indexTail) return deduped.map(full).join('\n');

  const parts = deduped.slice(0, coreFresh).map(full);
  const tail = deduped.slice(coreFresh);
  if (tail.length) {
    const lines = tail.map(e => `- **${e.name}**${e.desc ? ` — ${e.desc}` : ''}`);
    parts.push(`### ${indexHeading} (${tail.length})\n_${recallHint}_\n\n${lines.join('\n')}\n`);
  }
  return parts.join('\n');
}

/**
 * Hard-cap `block` to `maxChars`, reserving room so the result both fits the cap AND (when
 * `endMark` is given) ends with it — the caller may depend on that trailing marker to relocate
 * or re-inject the block later. `endMark=''` is a no-op for marker preservation (JS's
 * `''.endsWith('')`-style edge case from the original code is why this is called out): the
 * block is still truncated, just without any marker appended back.
 * Returns `{ text, truncated, cutName }` — `cutName` is the nearest `##`–`####` heading at the
 * cut point (for the caller's own logging), `null` when nothing was truncated.
 */
export function truncateBlock(block, { maxChars = 60000, endMark = '' } = {}) {
  if (block.length <= maxChars) return { text: block, truncated: false, cutName: null };

  const head = block.slice(0, maxChars);
  const heads = [...head.matchAll(/^#{2,4}\s+(.+)$/gm)];
  let cutName = heads.length ? heads[heads.length - 1][1].trim() : '?';
  if (!heads.length) {
    const m = block.slice(maxChars).match(/#{2,4}\s+([^\n]+)/);
    if (m) cutName = m[1].trim();
  }

  const note = `\n…(truncated to ${maxChars} chars)\n`;
  const reserve = note.length + (endMark ? endMark.length : 0);
  const bodyLimit = Math.max(maxChars - reserve, 0);
  const body = block.slice(0, bodyLimit).replace(/\n+$/, '');
  const text = endMark ? `${body}${note}${endMark}` : `${body}${note}`;
  return { text, truncated: true, cutName };
}

/** Remove every `<!-- BEGIN: name --> … <!-- END: name -->` block for each `name` in
 *  `markerNames`. Unmatched names are simply no-ops. */
export function stripMarkerBlocks(md, markerNames = []) {
  let out = md;
  for (const name of markerNames) {
    const re = new RegExp(
      `<!-- BEGIN: ${escapeRegExp(name)} -->[\\s\\S]*?<!-- END: ${escapeRegExp(name)} -->`,
      'g',
    );
    out = out.replace(re, '');
  }
  return out;
}

/** Remove each section starting at a literal `heading` string (e.g. `## Some heading:`) up to
 *  the next `#`/`##` heading, the next HTML comment, or end of string — whichever comes first.
 *  Headings are caller-supplied text, not a hardcoded convention. */
export function stripSections(md, headings = []) {
  let out = md;
  for (const heading of headings) {
    const re = new RegExp(`${escapeRegExp(heading)}[\\s\\S]*?(?=\\n#{1,2} |\\n<!-- |$)`, 'g');
    out = out.replace(re, '');
  }
  return out;
}
