#!/usr/bin/env bash
# recall-memory.sh — search Claude Code's working memory via samemind's BM25/semantic recall
# (tools/okf-recall.mjs). Thin wrapper: sets OKF_ROOT to the memory bundle and execs it.
#
#   recall-memory "why is recall slow"                              # default bundle
#   OKF_ROOT=/path/to/other/bundle recall-memory "query" -k 10       # override the bundle
#
# Default bundle: Claude Code's auto-memory for the ~/.soul project (see MEMORY.md there).
# Any okf-recall.mjs flag works (-k N, --mode bm25|semantic|auto, --include-mirror, …).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${OKF_ROOT:=$HOME/.claude/projects/-Users-aleksandrgrebeshok--soul/memory}"
export OKF_ROOT
exec node "$HERE/../tools/okf-recall.mjs" "$@"
