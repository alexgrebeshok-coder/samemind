#!/usr/bin/env bash
# clean-room.sh — CI gate: install the packed tarball, start MCP from that install (not the repo
# tree), drive real JSON-RPC (initialize → tools/list → memory_health), then recall/handoff/doctor.
# smoke-tarball.sh proves the CLI routes; this proves the product promise — an agent gets memory.
#
#   bash scripts/clean-room.sh
#
# Never touches the runner's real ~/.claude.json, ~/.cursor/, ~/.codex/ — only a temp HOME fixture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
START_TS="$(date +%s)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s ==\n' "$1"; }
fail() { echo "clean-room FAIL: $1" >&2; exit 1; }

step "npm pack (repo → tarball)"
cd "$REPO_ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$WORK")"
TARBALL="$WORK/$TARBALL_NAME"
echo "packed: $TARBALL"

step "install tarball into an isolated npm project"
INSTALL_DIR="$WORK/install"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install "$TARBALL" >/dev/null
SAMEMIND="$INSTALL_DIR/node_modules/.bin/samemind"
[ -x "$SAMEMIND" ] || fail "samemind bin missing after install — packaging broken"
echo "installed: $SAMEMIND"

BUNDLE="$WORK/bundle"
mkdir -p "$BUNDLE"

step "samemind init --demo (fresh bundle in temp dir)"
cd "$BUNDLE"
"$SAMEMIND" init --demo

step "fixture MCP client config in a fake HOME (never the real ~/.cursor)"
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME/.cursor"
BUNDLE_REAL="$(cd "$BUNDLE" && pwd -P)"
SAMEMIND_REAL="$(cd "$(dirname "$SAMEMIND")" && pwd -P)/$(basename "$SAMEMIND")"
# shellcheck disable=SC2016
node --input-type=module -e "
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[1];
const bundle = process.argv[2];
const command = process.argv[3];
mkdirSync(join(home, '.cursor'), { recursive: true });
writeFileSync(join(home, '.cursor/mcp.json'), JSON.stringify({
  mcpServers: {
    samemind: {
      command,
      args: ['serve'],
      env: { OKF_ROOT: bundle },
    },
  },
}, null, 2) + '\n');
" "$FAKE_HOME" "$BUNDLE_REAL" "$SAMEMIND_REAL"
echo "wrote $FAKE_HOME/.cursor/mcp.json → serve + OKF_ROOT=$BUNDLE_REAL"

step "MCP proof-of-life from installed package (JSON-RPC stdio via mcp-probe)"
PROBE_OUT="$WORK/probe-out.json"
node --input-type=module -e "
import { realpathSync, writeFileSync } from 'node:fs';
import { probeMcpServer, PROBE_STATUS, liveProbeCount } from '${REPO_ROOT}/tools/lib/mcp-probe.mjs';

const command = process.argv[1];
const bundle = process.argv[2];
const outPath = process.argv[3];

const r = await probeMcpServer({
  command,
  args: ['serve'],
  env: { OKF_ROOT: bundle },
  timeoutMs: 20000,
});

if (r.status !== PROBE_STATUS.OK) {
  console.error('probe status:', r.status);
  if (r.spawnError) console.error('spawnError:', r.spawnError);
  if (r.exitCode != null) console.error('exitCode:', r.exitCode);
  if (r.stderrTail) console.error('stderr tail:', r.stderrTail);
  if (r.missingCore?.length) console.error('missingCore:', r.missingCore);
  process.exit(1);
}

const need = ['memory_search', 'memory_get', 'memory_health'];
for (const t of need) {
  if (!r.tools.includes(t)) {
    console.error('tools/list missing', t, '— got', r.tools);
    process.exit(1);
  }
}

let expectedRoot;
let actualRoot;
try {
  expectedRoot = realpathSync(bundle);
  actualRoot = r.health?.root ? realpathSync(r.health.root) : null;
} catch (e) {
  console.error('realpath failed:', e.message);
  process.exit(1);
}
if (actualRoot !== expectedRoot) {
  console.error('health.root mismatch: expected', expectedRoot, 'got', actualRoot);
  process.exit(1);
}
if (!(Number(r.health?.concepts) > 0)) {
  console.error('health.concepts must be > 0, got', r.health?.concepts);
  process.exit(1);
}
if (liveProbeCount() !== 0) {
  console.error('orphan probe children:', liveProbeCount());
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify({ tools: r.tools, health: r.health, durationMs: r.durationMs }));
console.log('MCP ok — tools:', r.tools.length, 'concepts:', r.health.concepts, 'probeMs:', r.durationMs);
" "$SAMEMIND_REAL" "$BUNDLE_REAL" "$PROBE_OUT" || fail "MCP JSON-RPC probe failed (see stderr above)"
cat "$PROBE_OUT"

step "samemind recall (BM25 — continuity on the demo bundle)"
RECALL_OUT="$(cd "$BUNDLE" && "$SAMEMIND" recall "memory" --mode bm25)"
echo "$RECALL_OUT"
echo "$RECALL_OUT" | grep -q '/' \
  || fail "recall returned no bundle path citations — demo corpus not readable"

step "samemind handoff (work-state brief — continuity)"
HANDOFF_OUT="$(cd "$BUNDLE" && "$SAMEMIND" handoff --json)"
echo "$HANDOFF_OUT"
echo "$HANDOFF_OUT" | grep -q '"kind"[[:space:]]*:[[:space:]]*"handoff"' \
  || fail "handoff --json did not emit kind:handoff"
echo "$HANDOFF_OUT" | grep -q '"contract"[[:space:]]*:[[:space:]]*1' \
  || fail "handoff --json did not emit contract:1"

step "samemind doctor --json --no-probe --root <bundle> (packaged CLI contract)"
# HOME=$FAKE_HOME is load-bearing, not decoration: doctor defaults to os.homedir() and would
# otherwise read the runner's real ~/.cursor, ~/.gemini, ~/.codex. That made this step's output
# depend on whoever ran it — a clean-room that reads the developer's machine is not a clean room.
DOCTOR_OUT="$(cd "$BUNDLE" && HOME="$FAKE_HOME" "$SAMEMIND" doctor --json --no-probe --root "$BUNDLE")" \
  || fail "doctor exited non-zero on demo bundle"
echo "$DOCTOR_OUT"
echo "$DOCTOR_OUT" | grep -q '"kind"[[:space:]]*:[[:space:]]*"doctor"' \
  || fail "doctor --json did not emit kind:doctor"
echo "$DOCTOR_OUT" | grep -q '"contract"[[:space:]]*:[[:space:]]*1' \
  || fail "doctor --json did not emit contract:1"
# Isolation is a claim, so assert it: no real-home path may appear anywhere in the report.
echo "$DOCTOR_OUT" | grep -q "$HOME/\.cursor\|$HOME/\.gemini\|$HOME/\.codex\|$HOME/\.claude\.json" \
  && fail "doctor read the runner's REAL engine configs — clean-room isolation is broken"

END_TS="$(date +%s)"
ELAPSED=$((END_TS - START_TS))

echo
echo "CLEAN-ROOM OK — tarball MCP serves memory (root + concepts), recall/handoff/doctor pass (${ELAPSED}s)."
