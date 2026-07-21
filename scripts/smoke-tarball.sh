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

step "samemind setup --dry-run --target <fixture with CLAUDE.md>"
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
printf '# fixture project\n' > "$FIXTURE/CLAUDE.md"
"$SAMEMIND" setup --dry-run --target "$FIXTURE"

echo
echo "SMOKE OK — tarball installs and runs standalone."
