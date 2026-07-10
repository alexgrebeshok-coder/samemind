# Interop — export / import / gbrain

SameMind speaks **Google OKF v0.1** on the wire: a folder of markdown files with
YAML frontmatter, `path = identity`, and a root `index.md` carrying
`okf_version: "0.1"`. This doc is the contract for sharing a bundle with another
person or tool, and for bridging into [garrytan/gbrain](https://github.com/garrytan/gbrain).

Related code: `tools/export.mjs`, `tools/import.mjs`. CLI:

```sh
npx samemind export <target-dir> [--visibility public|internal] [--dry-run] [--to-gbrain]
npx samemind import <source-dir> [--into inbox|concepts]
```

## What we guarantee

| Guarantee | Detail |
|-----------|--------|
| **No secrets leave** | `secret/`, `mirror/`, and any node with `visibility: secret` (or `mirror`) are **never** exported. There is no flag to override this on the public CLI. |
| **No raw inbox** | `inbox/` is never exported — raw notes are local until curated. |
| **Empty target only** | `export` refuses a non-empty target directory (same contract as `init`). No silent overwrite. |
| **Dry-run is pure** | `--dry-run` prints the include/exclude/warning report and writes **zero** bytes. |
| **Broken links are warnings** | Links/relations pointing at stripped or non-exported nodes are listed on stdout; export still succeeds. |
| **Import never overwrites** | `--into concepts` refuses path collisions file-by-file. `--into inbox` only creates/appends `inbox/import-<date>.md`. |
| **Path safety** | `../`, absolute escapes, and symlink escapes outside the bundle root are rejected. Writes go through `lib/atomic-write.mjs`. |
| **OKF marker on export** | Root `index.md` is written/normalized with `okf_version: "0.1"`. |

We do **not** guarantee bit-identical round-trips through gbrain mode, full typed
`relations` fidelity outside SameMind, or that a foreign OKF pack uses our
discipline dictionaries (`Plan`/`Task` status) — foreign packs are accepted with a
non-conformant report, not rejected wholesale.

## Google OKF compatibility

- Spec shape: markdown + frontmatter, root index with `okf_version: "0.1"`.
- SameMind extensions (compatible supersets; ignored by plain OKF readers):
  - `relations:` typed edges (`works_at`, `depends_on`, …)
  - `supersedes:` hygiene pointer
  - work-discipline types (`Plan`, `Task`, `Decision`, `Session`) and `status`
  - `visibility: public | internal | secret | mirror`
- A bundle produced by `samemind export` (without `--to-gbrain`) is a valid OKF
  folder: drop it next to any OKF-aware tool, or `samemind import` it elsewhere.

Upstream OKF references live with the Google/community OKF v0.1 materials; this
repo tracks the wire shape, not a vendored copy of their SPEC.

## Export scenarios

### Share an internal pack (default)

```sh
npx samemind export ./share-pack
# ≡ --visibility internal → public + internal concepts
```

Includes concepts/entities/projects (and any other non-reserved top-level) whose
`visibility` ranks at or below `internal`. Strips `secret/`, `mirror/`, `inbox/`.
Copies root `index.md` (with `okf_version: "0.1"`) and `log.md`.

### Public-only pack

```sh
npx samemind export ./public-pack --visibility public
```

Only nodes with `visibility: public`. Useful for open knowledge packs and demos.

### Preview without writing

```sh
npx samemind export ./would-be --dry-run --visibility public
```

Report sections: `included`, `excluded` (with reason), `warnings` (broken links).

### Visibility rank

```
public (0)  <  internal (1)  <  secret (2)  <  mirror (3)
```

Export keeps a node when `rank(node.visibility) ≤ rank(--visibility)`.
Default threshold is `internal`. Top-level `secret/`, `mirror/`, `inbox/` are
hard-excluded regardless of frontmatter.

## Import scenarios

### Curated path (default) — inbox

```sh
npx samemind import ./foreign-okf
# ≡ --into inbox
```

1. Walk the source (skipping `secret/`, `mirror/`, `inbox/`, tooling dirs).
2. Validate each `.md`: parseable frontmatter + non-empty `type`.
3. Report **non-conformant** files (no frontmatter / no `type`) without failing the run.
4. Write (or append) `inbox/import-<YYYY-MM-DD>.md`: one `##` block per concept with
   id, **source** path citation, type, and a fenced copy of the original markdown.

Nothing is promoted into the canon automatically — a human or curating agent
moves blocks into `concepts/` / `entities/` / `projects/` when ready.

### Direct tree copy — concepts

```sh
npx samemind import ./foreign-okf --into concepts
```

Copies each valid concept to the same relative path under the live bundle, adding:

```yaml
source: import:<source-dir-basename>
```

If `concepts/foo.md` already exists → that file is **refused** (reported), others
still import. No deletes, no overwrites.

## gbrain bridge (`--to-gbrain`)

```sh
npx samemind export ./gbrain-pages --to-gbrain
```

Maps each exported SameMind concept onto a page shaped for
[garrytan/gbrain](https://github.com/garrytan/gbrain) (“compiled truth + timeline”):

| SameMind | gbrain page |
|----------|-------------|
| `type` | frontmatter `type` (preserved) |
| `title` | frontmatter `title` (preserved) |
| `tags` | frontmatter `tags` (preserved) |
| body | `## Compiled truth` section |
| `timestamp` + `source` | `## Timeline` → one bullet `timestamp · source` |
| `relations` + body links | trailing `Related: [label](/path.md), …` |

Relative paths of files are kept (`concepts/nova.md` stays `concepts/nova.md`) so
a directory of pages can be dropped into a gbrain workspace.

### What is lost in gbrain mode

- **`visibility`** — not emitted (gbrain pages are assumed shareable).
- **`description`** — not in the gbrain frontmatter subset we write.
- **Typed `relations`** — edge types (`works_at`, `depends_on`, …) collapse into a
  flat `Related:` list of links; type labels are dropped.
- **`supersedes`**, discipline fields (`status`, `blocked_reason`, `agreed_on`, …),
  and any other SameMind-only frontmatter keys.
- **Body structure** — original headings are nested under `## Compiled truth`; a
  second export→gbrain pass is not a faithful inverse of import.
- **`index.md` / `log.md`** — still copied as OKF root files; they are not rewritten
  into the gbrain page shape.

Round-trip recommendation: keep a normal (non-gbrain) export as the OKF source of
truth; treat `--to-gbrain` as a one-way publish adapter.

## Security notes

- Export is a **visibility strip**, not encryption. Secret material that was
  mistakenly marked `internal` will leave with the pack — curate first.
- Import into `concepts` trusts the source tree layout. Only run it on packs you
  trust; prefer `--into inbox` for untrusted knowledge packs (wave / community).
- Neither command deletes files. Collision = skip + report.
