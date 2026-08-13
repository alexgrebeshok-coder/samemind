// relation-kinds.mjs — closed read-side vocabulary for typed relations.
// Source: docs/graph-design-note.md §§2–4. Parser (normalizeRelations) stays open;
// this module classifies keys on read. Expand and validate consume these helpers.

function freezeTraversal(kind, directions, { derived = false, symmetric = false } = {}) {
  return Object.freeze({
    kind,
    directions: Object.freeze([...directions]),
    derived,
    symmetric,
  });
}

// Single dictionary: walk order is insertion order. Expand must consume this, not fork in recall.
// Source: graph-design-note.md §4.3 — typed both ways, cites inbound-only derived, related last + symmetric.
export const RELATION_KIND_TRAVERSAL = Object.freeze({
  about: freezeTraversal('about', ['outbound', 'inbound']),
  member_of: freezeTraversal('member_of', ['outbound', 'inbound']),
  agreed_with: freezeTraversal('agreed_with', ['outbound', 'inbound']),
  depends_on: freezeTraversal('depends_on', ['outbound', 'inbound']),
  informs: freezeTraversal('informs', ['outbound', 'inbound']),
  uses: freezeTraversal('uses', ['outbound', 'inbound']),
  cites: freezeTraversal('cites', ['inbound'], { derived: true }),
  related: freezeTraversal('related', ['outbound', 'inbound'], { symmetric: true }),
});

/** Expand walk order from graph-design-note.md §4.3. cites is derived from body links, not relations:. */
export const RELATION_WALK_ORDER = Object.freeze(Object.keys(RELATION_KIND_TRAVERSAL));

/** Traversal spec for a canonical walk kind, or null. Not an alias classifier. */
export function relationKindTraversal(kind) {
  return RELATION_KIND_TRAVERSAL[kind] ?? null;
}

// Stored edge aliases → canonical kind + whether the written key is the reverse of the canon.
const EDGE_ALIASES = Object.freeze({
  about: { kind: 'about', reverse: false },
  covers: { kind: 'about', reverse: false },
  project: { kind: 'about', reverse: false },
  member_of: { kind: 'member_of', reverse: false },
  works_at: { kind: 'member_of', reverse: false },
  part_of: { kind: 'member_of', reverse: false },
  depends_on: { kind: 'depends_on', reverse: false },
  uses: { kind: 'uses', reverse: false },
  agreed_with: { kind: 'agreed_with', reverse: false },
  informs: { kind: 'informs', reverse: false },
  spawned_by: { kind: 'informs', reverse: true },
  led_to: { kind: 'informs', reverse: false },
  decided: { kind: 'informs', reverse: false },
  related: { kind: 'related', reverse: false },
});

// Known non-edge keys. next is a board convention (no validate warning, not expandable).
const BOARD_KEYS = Object.freeze({
  next: { kind: 'next', reverse: false },
});

// Hygiene — top-level supersedes / relations.supersedes. Not a graph edge.
const HYGIENE_KEYS = Object.freeze({
  supersedes: { kind: 'supersedes', reverse: false },
  superseded_by: { kind: 'supersedes', reverse: true },
});

function normalizeRelationKey(rawKey) {
  let key = String(rawKey ?? '').trim().toLowerCase();
  if (key.startsWith('relations.')) key = key.slice('relations.'.length);
  return key;
}

/**
 * Classify a raw relations: (or hygiene) key.
 * @returns {{ class: 'edge'|'hygiene'|'board'|'unknown', kind: string|null, reverse: boolean }}
 */
export function classifyRelationKey(rawKey) {
  const key = normalizeRelationKey(rawKey);
  if (!key) return { class: 'unknown', kind: null, reverse: false };
  const edge = EDGE_ALIASES[key];
  if (edge) return { class: 'edge', kind: edge.kind, reverse: edge.reverse };
  const board = BOARD_KEYS[key];
  if (board) return { class: 'board', kind: board.kind, reverse: board.reverse };
  const hygiene = HYGIENE_KEYS[key];
  if (hygiene) return { class: 'hygiene', kind: hygiene.kind, reverse: hygiene.reverse };
  return { class: 'unknown', kind: null, reverse: false };
}

/** Canonical stored edge kind, or null if the key is not a graph edge. */
export function canonicalRelationKind(rawKey) {
  const c = classifyRelationKey(rawKey);
  return c.class === 'edge' ? c.kind : null;
}

/** True iff expand should walk this relations: key (stored edge; not next / hygiene / unknown). */
export function isExpandableRelationKey(rawKey) {
  return classifyRelationKey(rawKey).class === 'edge';
}

/** Soft-validate warnings for keys outside the dictionary and outside the board allow-list. */
export function unknownRelationKindWarnings(docs) {
  const warns = [];
  for (const d of docs || []) {
    const rel = d.relations || {};
    for (const key of Object.keys(rel)) {
      if (classifyRelationKey(key).class === 'unknown') {
        warns.push(`${d.id} [${key}] — unknown relation kind`);
      }
    }
  }
  return warns;
}
