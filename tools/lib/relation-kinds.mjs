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

function freezeAlias(kind, reverse) {
  return Object.freeze({ kind, reverse });
}

/** Own-key map: insertion order, no Object.prototype. Frozen after fill. */
function freezeOwnMap(src) {
  const map = Object.create(null);
  for (const key of Object.keys(src)) map[key] = src[key];
  return Object.freeze(map);
}

function ownGet(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// Single dictionary: walk order is insertion order. Expand must consume this, not fork in recall.
// Source: graph-design-note.md §4.3 — typed both ways, cites inbound-only derived, related last + symmetric.
export const RELATION_KIND_TRAVERSAL = freezeOwnMap({
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
  return ownGet(RELATION_KIND_TRAVERSAL, kind) ?? null;
}

// Stored edge aliases → canonical kind + whether the written key is the reverse of the canon.
const EDGE_ALIASES = freezeOwnMap({
  about: freezeAlias('about', false),
  covers: freezeAlias('about', false),
  project: freezeAlias('about', false),
  member_of: freezeAlias('member_of', false),
  works_at: freezeAlias('member_of', false),
  part_of: freezeAlias('member_of', false),
  depends_on: freezeAlias('depends_on', false),
  uses: freezeAlias('uses', false),
  agreed_with: freezeAlias('agreed_with', false),
  informs: freezeAlias('informs', false),
  spawned_by: freezeAlias('informs', true),
  led_to: freezeAlias('informs', false),
  decided: freezeAlias('informs', false),
  related: freezeAlias('related', false),
});

// Known non-edge keys. next is a board convention (no validate warning, not expandable).
const BOARD_KEYS = freezeOwnMap({
  next: freezeAlias('next', false),
});

// Hygiene — top-level supersedes / relations.supersedes. Not a graph edge.
const HYGIENE_KEYS = freezeOwnMap({
  supersedes: freezeAlias('supersedes', false),
  superseded_by: freezeAlias('supersedes', true),
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
  const edge = ownGet(EDGE_ALIASES, key);
  if (edge) return { class: 'edge', kind: edge.kind, reverse: edge.reverse };
  const board = ownGet(BOARD_KEYS, key);
  if (board) return { class: 'board', kind: board.kind, reverse: board.reverse };
  const hygiene = ownGet(HYGIENE_KEYS, key);
  if (hygiene) return { class: 'hygiene', kind: hygiene.kind, reverse: hygiene.reverse };
  return { class: 'unknown', kind: null, reverse: false };
}

/**
 * Orient a written `from --rawKey--> to` for expand: apply alias reverse, return
 * the canonical pair and walk direction. Reverse aliases flip the pair (writer is
 * the canonical target → inbound). Non-edge keys return null.
 * @returns {{ from: string, to: string, kind: string, direction: 'outbound'|'inbound' } | null}
 */
export function orientRelation(fromId, rawKey, toId) {
  const c = classifyRelationKey(rawKey);
  if (c.class !== 'edge' || c.kind == null) return null;
  if (c.reverse) return { from: toId, to: fromId, kind: c.kind, direction: 'inbound' };
  return { from: fromId, to: toId, kind: c.kind, direction: 'outbound' };
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
