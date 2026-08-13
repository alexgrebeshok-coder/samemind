#!/usr/bin/env bash
# Publish GitHub releases for samemind v0.9.0 … v0.18.0 from prepared notes.
# Dry-run by default — pass --yes to actually create releases.
#
# Usage:
#   ./PUBLISH.sh           # print plan only
#   ./PUBLISH.sh --yes     # create missing releases (oldest → newest)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

release_title() {
  case "$1" in
    v0.9.0)  echo "graph-aware recall" ;;
    v0.10.0) echo "the memory gets a face" ;;
    v0.11.0) echo "the board fills itself" ;;
    v0.12.0) echo "memory projection in the product" ;;
    v0.13.0) echo "projection as a service" ;;
    v0.14.0) echo "memory keeps itself current, live" ;;
    v0.15.0) echo "honest connection" ;;
    v0.16.0) echo "the switchboard" ;;
    v0.17.0) echo "contract locked, dogfood measurable" ;;
    v0.18.0) echo "memory that speaks first" ;;
    *)       echo "$1" ;;
  esac
}

VERSIONS=(
  v0.9.0
  v0.10.0
  v0.11.0
  v0.12.0
  v0.13.0
  v0.14.0
  v0.15.0
  v0.16.0
  v0.17.0
  v0.18.0
)

DO_PUBLISH=false
if [[ "${1:-}" == "--yes" ]]; then
  DO_PUBLISH=true
elif [[ -n "${1:-}" ]]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: $0 [--yes]" >&2
  exit 1
fi

cd "${REPO_ROOT}"

# Resolve repo for gh (works from local clone)
if ! REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; then
  echo "error: cannot resolve GitHub repo (is gh authenticated?)" >&2
  exit 1
fi

release_exists() {
  local tag="$1"
  gh release view "${tag}" -R "${REPO}" >/dev/null 2>&1
}

tag_exists() {
  local tag="$1"
  git rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1
}

planned=0
skipped_existing=0
skipped_no_tag=0
missing_notes=0

echo "Repository: ${REPO}"
echo "Mode: $([[ "${DO_PUBLISH}" == true ]] && echo PUBLISH || echo PLAN-ONLY)"
echo

for tag in "${VERSIONS[@]}"; do
  notes_file="${SCRIPT_DIR}/${tag}.md"

  if release_exists "${tag}"; then
    echo "SKIP (release exists): ${tag}"
    ((skipped_existing++)) || true
    continue
  fi

  if ! tag_exists "${tag}"; then
    echo "SKIP (no git tag):     ${tag}"
    ((skipped_no_tag++)) || true
    continue
  fi

  if [[ ! -f "${notes_file}" ]]; then
    echo "ERROR (missing notes): ${tag} → expected ${notes_file}" >&2
    ((missing_notes++)) || true
    continue
  fi

  title="$(release_title "${tag}")"
  echo "WOULD CREATE: ${tag} — ${title}"
  echo "  notes: ${notes_file}"
  ((planned++)) || true

  if [[ "${DO_PUBLISH}" == true ]]; then
    gh release create "${tag}" \
      --repo "${REPO}" \
      --title "${tag} — ${title}" \
      --notes-file "${notes_file}"
    echo "  → created"
  fi
  echo
done

echo "---"
echo "Planned/creates: ${planned}"
echo "Skipped (existing release): ${skipped_existing}"
echo "Skipped (no tag): ${skipped_no_tag}"
if [[ "${missing_notes}" -gt 0 ]]; then
  echo "Errors (missing notes): ${missing_notes}" >&2
  exit 1
fi

if [[ "${DO_PUBLISH}" == false && "${planned}" -gt 0 ]]; then
  echo
  echo "Dry run complete. Re-run with --yes to publish."
fi
