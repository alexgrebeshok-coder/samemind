// detect-engines.mjs — scans a target directory for engine instruction files/dirs already
// present, so a future `setup` command (U-B) knows which engines to offer install/MCP-registration
// for. Reuses install.mjs's fileOwnerMap() (samemind's own file → owning-engine-ids table) instead
// of re-declaring the CLAUDE.md/AGENTS.md/GEMINI.md/… mapping here.
//
// One wrinkle: some ENGINE_FILES entries point at samemind's OWN nested rules file (e.g.
// `.roo/rules/samemind.md`, `.cursor/rules/samemind.md`) — checking for that exact file would only
// ever be true after `samemind install` already ran there, which is circular for "is this engine
// used in this project at all". For those, the containing top-level folder (`.roo/`, `.cursor/`)
// is the general signal instead. Flat/shared files (CLAUDE.md, AGENTS.md, GEMINI.md, .clinerules,
// .goosehints, .github/copilot-instructions.md) are checked at their exact path — same as
// fileOwnerMap already declares.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileOwnerMap } from '../install.mjs';

function checkPathFor(rel) {
  return rel.endsWith('/samemind.md') ? rel.split('/')[0] : rel;
}

/** Engine ids whose instruction file/dir is present under `target`. Sorted, deduped; [] if none. */
export function detectEngines(target) {
  const found = new Set();
  for (const [rel, ids] of fileOwnerMap()) {
    if (existsSync(join(target, checkPathFor(rel)))) {
      for (const id of ids) found.add(id);
    }
  }
  return [...found].sort();
}
