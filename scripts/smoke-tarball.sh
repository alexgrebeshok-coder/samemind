#!/usr/bin/env bash
# smoke-tarball.sh — CI-only smoke gate: `npm pack` then install/run the resulting TARBALL
# (not the repo's own source tree) in a throwaway project, the way a real `npm install samemind`
# / `npx samemind` user actually hits it. `node --test` only ever runs against source — it never
# catches a packaging bug (missing `files` entry, a broken `bin` symlink, an entry that only
# resolves via a repo-relative path). That exact class of bug shipped in 0.1.0 and slipped past a
# fully green test suite; this script is the gate that would have caught it.
#
#   bash scripts/smoke-tarball.sh
#
# Any nonzero exit anywhere below fails the script (set -e) — CI wires this in as its own `smoke`
# job, a hard prerequisite for `publish` alongside `test` (see .github/workflows/release.yml).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s ==\n' "$1"; }

step "npm pack (repo → tarball)"
cd "$REPO_ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$WORK")"
TARBALL="$WORK/$TARBALL_NAME"
echo "packed: $TARBALL"

step "install the TARBALL into a fresh project (not the source tree)"
INSTALL_DIR="$WORK/install"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install "$TARBALL" >/dev/null
SAMEMIND="$INSTALL_DIR/node_modules/.bin/samemind"
[ -x "$SAMEMIND" ] || { echo "samemind bin missing after install — packaging is broken" >&2; exit 1; }

BUNDLE="$WORK/bundle"
mkdir -p "$BUNDLE"
cd "$BUNDLE"

step "samemind init --demo"
"$SAMEMIND" init --demo

step "samemind query validate"
"$SAMEMIND" query validate

step "samemind recall (BM25 path — no network, no omlx)"
"$SAMEMIND" recall "test" --mode bm25

step "samemind reconcile (Ф2 proposals — human-gate, must not touch canon)"
RECONCILE_OUT="$("$SAMEMIND" reconcile)"
echo "$RECONCILE_OUT"
echo "$RECONCILE_OUT" | grep -q 'Reconcile proposals' \
  || { echo "reconcile did not print its report — CLI routing regression" >&2; exit 1; }

step "samemind reflect (Ф5 proposals — human-gate, must not touch canon)"
REFLECT_OUT="$("$SAMEMIND" reflect)"
echo "$REFLECT_OUT"
echo "$REFLECT_OUT" | grep -q 'Reflect proposals' \
  || { echo "reflect did not print its report — CLI routing regression" >&2; exit 1; }

step "samemind setup --dry-run --target <fixture with CLAUDE.md>"
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
printf '# fixture project\n' > "$FIXTURE/CLAUDE.md"
"$SAMEMIND" setup --dry-run --target "$FIXTURE"

step "samemind setup --global --dry-run --home <fake home> (never touch the CI runner's real ~/.claude*/~/.samemind)"
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"
"$SAMEMIND" setup --global --dry-run --home "$FAKE_HOME"

step "samemind recall multi-root (OKF_GLOBAL_ROOT fixture — global: prefix must appear)"
GLOBAL_FIXTURE="$WORK/global-bundle"
mkdir -p "$GLOBAL_FIXTURE/concepts"
cat > "$GLOBAL_FIXTURE/index.md" <<'EOF'
---
type: Root
okf_version: "0.1"
---
# global fixture
EOF
cat > "$GLOBAL_FIXTURE/concepts/smoke-global-note.md" <<'EOF'
---
type: Concept
title: Smoke global note
---
Lives only in the global fixture bundle, never in the project bundle.
EOF
RECALL_OUT="$(OKF_GLOBAL_ROOT="$GLOBAL_FIXTURE" "$SAMEMIND" recall "smoke global note" --mode bm25)"
echo "$RECALL_OUT"
echo "$RECALL_OUT" | grep -q 'global:concepts/smoke-global-note' \
  || { echo "multi-root recall did not surface the global: prefix — regression" >&2; exit 1; }

echo
echo "SMOKE OK — tarball installs and runs standalone."
