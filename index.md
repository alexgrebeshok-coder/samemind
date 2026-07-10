---
okf_version: "0.1"
---

# samemind — universal memory bundle

One mind across every engine you run. This directory is the canonical **OKF bundle**:
plain markdown, path = identity, links `[title](/path.md)`, frontmatter classifies each node.

How it works — see [README](/README.md). `/secret` and `/mirror` are gitignored (local-only).

## Folders

- `concepts/` — ideas, architectures, methods, rules (`type: Concept`, `EngineRule`, `Identity`, …)
- `entities/` — people, organizations, systems (`type: User`, `Entity`)
- `projects/` — products and initiatives (`type: Project`)
- `inbox/` — raw notes pending curation → promote into the canon above
- `secret/` — sensitive entries (gitignored; included only with `--include-secret`)
- `mirror/` — live-memory mirrors from each engine (gitignored; `--include-mirror`)

A worked example lives in [`demo/`](/demo/index.md). Validate your bundle:

```sh
node tools/okf-query.mjs validate          # this bundle
OKF_ROOT=demo node tools/okf-query.mjs validate   # the demo bundle
```
