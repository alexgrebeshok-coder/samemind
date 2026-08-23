# AGENTS.md

## Cursor Cloud specific instructions

`samemind` is a **zero-dependency Node.js CLI** (the memory-bundle engine + MCP server)
plus an **optional Vite/React dashboard** in `ui/`. Node ≥20 is required (VM ships v22).

### Services / components

- **CLI + MCP server** (`bin/samemind.mjs`, `tools/*.mjs`) — the core product. Has **no runtime
  npm dependencies**, so it needs **no `npm install`** to run or test. Run commands directly, e.g.
  `node bin/samemind.mjs <cmd>` (see `README.md` / `CONTRIBUTING.md` for the command list).
- **UI dashboard** (`ui/`) — a Vite+React SPA whose deps are **dev-only**. It builds to the
  repo-root `dist/`, which `samemind ui` serves at `http://127.0.0.1:7787` (loopback-only, exact
  `Host` header guard). The update script installs `ui/` dev deps; a prebuilt `dist/` is committed.

### Lint / test / build (the single CI gate is the test run)

- Full suite: `node --test tools/*.test.mjs` (~1300 tests, takes ~2 min). This is the only CI gate.
- Bundle conformance ("lint" equivalent): `npm run validate` (own bundle) / `npm run validate:demo`.
- UI checks: `cd ui && npm test` (unit), and `cd ui && npm run build` (runs `tsc --noEmit`
  type-check, then `vite build` → `dist/`).

### Non-obvious gotchas

- The repo's own bundle (`concepts/`, `entities/`, `projects/`) is **intentionally empty** (0
  concepts). To exercise CLI features you need a populated bundle: `node bin/samemind.mjs init
  /tmp/sm-demo --demo`, then pass `--root /tmp/sm-demo` or export `OKF_ROOT=/tmp/sm-demo`.
- `samemind ui` serves the **built `dist/`**, not a live dev server. After editing `ui/src`, you
  must re-run `cd ui && npm run build` for `samemind ui` to reflect changes — or use `cd ui &&
  npm run dev` (Vite dev server with HMR) while developing the UI itself.
- The optional `sqlite-vec` dependency is not installed; semantic recall falls back to **BM25**
  and prints a "sqlite-vec unavailable / semantic off" warning. This is expected, not an error.
- Tests must never touch the repo's real bundle — they use `mkdtemp` fixtures (see `CONTRIBUTING.md`).
