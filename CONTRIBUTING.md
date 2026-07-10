# Contributing

Zero-dependency Node.js project. If you can run `node`, you can dev on this.

## Setup

```sh
git clone https://github.com/alexgrebeshok-coder/samemind.git
cd samemind
node --test tools/*.test.mjs        # 265+ tests, no install step — there's nothing to install
```

Node ≥20 (CI matrix: 20 + 22 — see `.github/workflows/ci.yml`). No `npm install`,
because there are no runtime dependencies to install. Poke the CLI directly:

```sh
node tools/okf-query.mjs validate
OKF_ROOT=demo node tools/okf-query.mjs list
node bin/samemind.mjs brief --engine claude-code
```

## Rules

- **Zero deps.** No `dependencies` in `package.json`, ever — this is the whole
  pitch (no lockfile drift, no supply-chain surface, `npx samemind` just works).
  If a feature seems to need one, find the ~50-line version first.
- **Tests are not optional.** Every `tools/*.mjs` gets a matching
  `tools/*.test.mjs`. `node --test tools/*.test.mjs` must stay green — that's
  the CI gate and the only gate.
- **Never touch the real bundle in a test.** Use `mkdtempSync` for fixtures
  (see any existing `*.test.mjs`); tests must not read/write this repo's own
  `concepts/`/`entities/`/`projects/`.
- **Commit messages:** `type(scope): summary` — `feat`, `fix`, `docs`, `test`,
  matching the existing `git log`. Keep commits scoped to one logical change.
- **Format spec:** the on-disk shape (frontmatter, folders, `relations`,
  visibility tiers) lives in [`index.md`](index.md) and
  [`docs/`](docs/) — start with
  [`docs/memory-protocol.md`](docs/memory-protocol.md) and
  [`docs/identity-layer.md`](docs/identity-layer.md). Any change to the wire
  format should update the relevant `docs/*.md` in the same commit.

Questions or a design that needs discussion first → open an issue before the PR.
