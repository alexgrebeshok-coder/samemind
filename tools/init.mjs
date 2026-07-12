#!/usr/bin/env node
// init.mjs — samemind init: scaffold a fresh OKF bundle in a target directory.
//   node tools/init.mjs [dir] [--demo]
// No --force: refuses a non-empty target directory, never overwrites anything.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');

const FOLDERS = ['concepts', 'entities', 'projects', 'inbox', 'secret'];

const CONCEPTS_TEMPLATE = `---
type: Concept
title:
description:
visibility: internal
tags: []
timestamp:
source:
---

> Copy this file, drop the \`_\` prefix from the name, fill the frontmatter.
> \`path = identity\`: \`concepts/my-idea.md\` is the concept \`my-idea\`.

# <title>

Body of the concept. Link related nodes: see [another concept](/concepts/example.md).
`;

const CONCEPTS_INDEX = `---
okf_version: "0.1"
---

# Concepts

Ideas, architectures, methods, rules. Typical \`type\` values: \`Concept\`, \`EngineRule\`,
\`Identity\`, \`Reference\`, \`Decision\`, \`Session\`. Start from [\`_template.md\`](_template.md).

Identity layer (docs/identity-layer.md): [\`_identity-template.md\`](_identity-template.md) —
the agent's own mind (one per bundle); [\`_engine-rule-template.md\`](_engine-rule-template.md) —
per-engine role/allowed/forbidden (one per engine). Assemble a compact brief from them:
\`npx samemind brief\`.

Work discipline (docs/work-discipline.md): [\`_decision-template.md\`](_decision-template.md) —
a decision and its context (append-only); [\`_session-template.md\`](_session-template.md) —
a session summary (\`## Done\` / \`## Decided\` / \`## Next\`).

Knowledge cycle (docs/knowledge-cycle.md): [\`_analysis-template.md\`](_analysis-template.md) —
a conclusion from observed facts (\`relations.informs\` → an Idea);
[\`_research-template.md\`](_research-template.md) — a deeper dig (\`spawned_by\` an
Analysis, \`informs\` → an Idea); [\`_idea-template.md\`](_idea-template.md) — a
candidate (\`spark → incubating → adopted/rejected\`, \`## Reflections\` from agents).

List concepts: \`npx samemind query list\`
`;

const ENTITIES_TEMPLATE = `---
type: Entity
title:
description:
visibility: internal
tags: []
timestamp:
source:
---

> People, organizations, systems. Use \`type: User\` for the bundle owner,
> \`type: Entity\` for everyone/everything else.

# <title>

Body. Link to projects and concepts this entity relates to.
`;

const ENTITIES_INDEX = `---
okf_version: "0.1"
---

# Entities

People, organizations, systems. \`type: User\` (owner) or \`type: Entity\`.
Start from [\`_template.md\`](_template.md), or [\`_user-template.md\`](_user-template.md)
for the bundle owner (see docs/identity-layer.md).
`;

const USER_TEMPLATE = `---
type: User
title:
description: Owner of this bundle.
visibility: internal
tags: [user, owner, human]
timestamp:
source:
relations:
  uses: []
  # e.g. /concepts/<agent-identity>.md
---

> Copy this file, drop the \`_\` prefix (→ \`entities/<owner-name>.md\`), fill it in.
> One per bundle: the human (or org) this bundle ultimately serves. See
> docs/identity-layer.md and demo/entities/alex-doe.md for a worked example.
> Put preferences AND hard rules right in the intro below (bullets, before the
> first ## heading) — \`samemind brief\` treats that block as top priority,
> never trimmed. Extra ## sections (hobbies, context, …) are lower priority.

# <owner name>

Short bio — one or two sentences.

- Preference, working style, what they like.
- **Hates:** the short list of things that are non-negotiable no-gos.
`;

const IDENTITY_TEMPLATE = `---
type: Identity
title:
description: The AI agent this bundle belongs to — voice, values, boundaries.
visibility: internal
tags: [agent, identity]
timestamp:
source:
relations:
  uses: []
  # e.g. [/concepts/engine-claude-code.md, /concepts/engine-openclaw.md]
---

> Copy this file, drop the \`_\` prefix (→ \`concepts/<agent-name>.md\`), fill it in.
> One per bundle: the agent whose mind this bundle *is*. See docs/identity-layer.md
> and demo/concepts/nova.md for the full spec + a worked example.
> \`samemind brief\` reads the ## headings below by (fuzzy) name — keep them,
> add more if you like, but don't rename Voice/Values/Boundaries away.

# <agent name>

One or two sentences: who this agent is, same mind across every engine it runs on.

## Voice

- How it talks. Tone, register, what it never says.

## Values

- What it optimizes for when there's no explicit instruction.

## Boundaries

- Hard limits — things it never does without explicit confirmation.

## Hierarchy under conflict

1. Safety
2. Owner's intent
3. Style
`;

const ENGINE_RULE_TEMPLATE = `---
type: EngineRule
title: Engine — <engine-id>
description: How <agent name> behaves on the <engine-id> engine — <one-line role>.
visibility: internal
tags: [engine, rule]
timestamp:
source:
engine: <engine-id>
relations:
  part_of: /concepts/<agent-identity>.md
---

> Copy this file to \`concepts/engine-<engine-id>.md\` (drop the leading \`_\`,
> name the file after the engine id), fill it in. One per engine the agent
> runs on. \`samemind brief --engine <id>\` matches by the \`engine:\` field
> above first, falling back to the \`engine-<id>.md\` filename convention.
> See docs/identity-layer.md.

# Engine: <engine-id>

One sentence: the role this engine plays (terminal dev / chat orchestrator / batch coder / …).

- Allowed: what it does here.
- Forbidden: what it does not do here (or only with confirmation).
- Style: tone/format specific to this engine.
`;

const DECISION_TEMPLATE = `---
type: Decision
title:
description:
visibility: internal
agreed_on:                       # ISO date the decision was made (YYYY-MM-DD)
tags: [decision]
timestamp:
source:
relations:
  agreed_with: []
  # e.g. agreed_with: /entities/<person>.md
  about:
  # e.g. about: /projects/<name>.md
  supersedes: []
  # filled only when reversing a prior decision: supersedes: /concepts/<old-decision>.md
---

> Copy this file, drop the \`_\` prefix (→ \`concepts/<decision-name>.md\`), fill it in.
> A Decision is a point on the timeline — no \`status\` field. To change a decision,
> write a NEW Decision with \`relations.supersedes\` pointing at the old one; never
> rewrite the old node. See docs/work-discipline.md and demo/concepts/decision-lumen-local-first.md.

# <decision name>

One line: the decision itself, stated as a position ("we will …", "we will not …").

## Context

Why this call, what alternatives were weighed, what would change it.
`;

const SESSION_TEMPLATE = `---
type: Session
title:
description:
visibility: internal
engine:                          # the engine this session ran on (e.g. claude-code)
date:                            # ISO date of the session (YYYY-MM-DD)
tags: [session]
timestamp:
source:
relations:
  decided: []
  # decisions reached this session: /concepts/<decision>.md
  next: []
  # tasks queued as "next": /projects/<task>.md
---

> Copy this file, drop the \`_\` prefix (→ \`concepts/<session-name>.md\`), fill it in.
> Write one at the END of a session, never rewrite it (point-in-time). The closing
> artifact of any non-trivial session. See docs/work-discipline.md and demo/concepts/session-*.md.

# <session name>

One line: the span of work this session covered.

## Done

- What was finished or shipped this session.

## Decided

- Decisions reached (link the Decision nodes if any were written).

## Next

- What the next session should pick up.
`;

const ANALYSIS_TEMPLATE = `---
type: Analysis
title:
description:
visibility: internal
period:                           # date range the facts below were observed over (YYYY-MM-DD/YYYY-MM-DD)
tags: [analysis]
timestamp:
source:
relations:
  informs: []
  # e.g. informs: /concepts/<idea>.md — the Idea(s) this analysis feeds
---

> Copy this file, drop the \`_\` prefix (→ concepts/<analysis-name>.md), fill it in.
> An Analysis is a conclusion drawn from observed facts — no \`status\` field, a
> point-in-time write-up like a Decision/Session. Point \`relations.informs\` at
> the Idea(s) it feeds. See docs/knowledge-cycle.md and
> demo/concepts/analysis-mirror-staleness.md.

# <analysis name>

## Facts observed

- Concrete, dated observations — not interpretation yet.

## Pattern

What the facts above have in common; the shape of the problem.

## Implications

What this means going forward — the seed of an Idea (or several).
`;

const RESEARCH_TEMPLATE = `---
type: Research
title:
description:
visibility: internal
tags: [research]
timestamp:
source:
relations:
  spawned_by: []
  # e.g. spawned_by: /concepts/<analysis>.md — the Analysis whose pattern triggered this dig
  informs: []
  # e.g. informs: /concepts/<idea>.md — the Idea(s) this research feeds
---

> Copy this file, drop the \`_\` prefix (→ concepts/<research-name>.md), fill it in.
> Research is a deeper dig into one question — no \`status\` field, point-in-time
> like a Decision/Session. \`source\` holds the citations (URLs or bundle paths,
> scalar or list). Set \`relations.spawned_by\` if an Analysis's pattern prompted
> this dig. See docs/knowledge-cycle.md and
> demo/concepts/research-mirror-sync-mechanism.md.

# <research name>

## Question

The single question this research answers.

## Findings

- Finding, with its source (a URL, a paper, a bundle path) right next to it.

## Verdict

The answer, stated as a position — and what it feeds into (an Idea, a Decision).
`;

const IDEA_TEMPLATE = `---
type: Idea
title:
description:
visibility: internal
status: spark                     # spark | incubating | adopted | rejected
rejected_reason:                  # REQUIRED (non-empty) when status is rejected
tags: [idea]
timestamp:
source:
relations:
  led_to: []
  # filled once adopted: led_to: /projects/<plan>.md — the Plan this idea became
---

> Copy this file, drop the \`_\` prefix (→ concepts/<idea-name>.md), fill it in.
> An Idea starts as a \`spark\`, matures in \`## Reflections\` (agents append dated
> notes here when they curate a reflection out of the inbox — see
> docs/memory-protocol.md), then either \`adopted\` (set \`relations.led_to\` to
> the Plan it becomes) or \`rejected\` (\`rejected_reason\` REQUIRED). See
> docs/knowledge-cycle.md and demo/concepts/idea-cron-sync-adapters.md.

# <idea name>

## Essence

One or two sentences: what this idea is.

## Why now

The fact, pattern, or gap (often from an Analysis/Research node's
\`relations.informs\`) that makes this worth considering now.

## Reflections

- (agents append dated notes here during inbox curation — see docs/memory-protocol.md)
`;

const PROJECTS_TEMPLATE = `---
type: Project
title:
description:
visibility: internal
tags: []
timestamp:
source:
---

# <title>

Body. Status, goal, next step, blockers. Link entities and concepts involved.
`;

const PLAN_TEMPLATE = `---
type: Plan
title:
description:
visibility: internal
status: draft                     # draft | agreed | in-progress | done | superseded
agreed_on:                        # ISO date the current status was agreed (YYYY-MM-DD)
tags: [plan]
timestamp:
source:
relations:
  agreed_with: []
  # e.g. agreed_with: /entities/<person>.md
  covers:
  # e.g. covers: /projects/<name>.md   — the initiative this plan is for
  supersedes: []
  # filled only when replacing a prior plan: supersedes: /projects/<old-plan>.md
---

> Copy this file, drop the \`_\` prefix (→ \`projects/<plan-name>.md\`), fill it in.
> A Plan is a *coordinated* course of action. Body: ## Stages then ## Risks. When the
> plan changes, write a NEW Plan with \`relations.supersedes\` and mark this one
> \`status: superseded\` — Plans are append-only history. See docs/work-discipline.md
> and demo/projects/plan-lumen-sync.md.

# <plan name>

One line: what this plan achieves and who it was agreed with.

## Stages

1. First stage — concrete and verifiable.

## Risks

- Risk, and the mitigation that keeps it from derailing the plan.
`;

const TASK_TEMPLATE = `---
type: Task
title:
description:
visibility: internal
status: backlog                   # backlog | in-progress | done | blocked
blocked_reason:                   # REQUIRED (non-empty) when status is blocked
tags: [task]
timestamp:
source:
relations:
  project:
  # e.g. project: /projects/<name>.md   — the initiative this task belongs to
---

> Copy this file, drop the \`_\` prefix (→ \`projects/<task-name>.md\`), fill it in.
> A Task is the ONE discipline type you edit in place — \`status\` is its current
> state, not history. \`status: blocked\` requires a non-empty \`blocked_reason\`
> (what blocks it, what unblocks it). See docs/work-discipline.md and
> demo/projects/task-*.md.

# <task name>

What "done" looks like for this task — verifiable, one or two sentences.
`;

const PROJECTS_INDEX = `---
okf_version: "0.1"
---

# Projects

Products and initiatives (\`type: Project\`). Start from [\`_template.md\`](_template.md).

Work discipline (docs/work-discipline.md): [\`_plan-template.md\`](_plan-template.md) —
an agreed course of action (\`## Stages\` / \`## Risks\`, append-only via \`supersedes\`);
[\`_task-template.md\`](_task-template.md) — a unit of work edited in place
(\`status\` lifecycle; \`blocked\` needs a \`blocked_reason\`).
`;

const INBOX_INDEX = `---
okf_version: "0.1"
---

# Inbox

Raw notes waiting to be curated into the canon. Drop loose \`.md\` files here, then
promote what matters into \`concepts/\`, \`entities/\`, or \`projects/\` once reviewed.
`;

const SECRET_TEMPLATE = `---
type: Concept
title:
description:
visibility: secret
tags: []
timestamp:
source:
---

> \`visibility: secret\` keeps this node out of default queries and out of git
> (the \`/secret/\` folder is gitignored). It appears only with \`--include-secret\`.

# <title>

Sensitive body.
`;

const GITIGNORE = `# local-only tiers — never commit real content
# keep folder templates so the bundle is usable out of the box
/secret/**
!/secret/
!/secret/_template.md
/mirror/**

# generated artifacts
tools/.index/
inbox/_consolidation-report.md

# node
node_modules/

# os / editor noise
.DS_Store
*.log
`;

const DASHBOARD_PLACEHOLDER = `# Dashboard

_Empty — this is a placeholder._ Generate the kanban from work-discipline state (Plan / Task /
Decision / Session — see docs/work-discipline.md) and the knowledge-cycle Ideas section
(Analysis / Research / Idea — see docs/knowledge-cycle.md):

\`\`\`sh
npx samemind board --write        # write it into this DASHBOARD.md (committed to git)
npx samemind board                # same, to stdout
npx samemind board --project /projects/<name>.md   # only one project's tasks
\`\`\`
`;

function rootIndexMd(bundleName) {
  return `---
okf_version: "0.1"
---

# ${bundleName} — universal memory bundle

One mind across every engine you run. This directory is your OKF bundle:
plain markdown, path = identity, links \`[title](/path.md)\`, frontmatter classifies each node.

## Folders

- \`concepts/\` — ideas, architectures, methods, rules (\`type: Concept\`, \`EngineRule\`, \`Identity\`, …)
- \`entities/\` — people, organizations, systems (\`type: User\`, \`Entity\`)
- \`projects/\` — products and initiatives (\`type: Project\`)
- \`inbox/\` — raw notes pending curation → promote into the canon above
- \`secret/\` — sensitive entries (gitignored; included only with \`--include-secret\`)
- \`mirror/\` — live-memory mirrors from each engine (gitignored; \`--include-mirror\`)

Validate your bundle:

\`\`\`sh
npx samemind query validate
\`\`\`
`;
}

function rootLogMd(today) {
  return `---
okf_version: "0.1"
---

# Log

Append-only timeline of meaningful changes to the bundle. One entry per line, newest first.
This is for humans and curating agents — the graph itself is the source of truth.

- \`${today}\` — bundle initialized (samemind init).
`;
}

/** Copies demo/{concepts,entities,projects}/*.md (skipping index.md/_template.md) into dir. */
function copyDemoContent(dir, packageRoot) {
  const demoRoot = join(packageRoot, 'demo');
  let count = 0;
  for (const folder of ['concepts', 'entities', 'projects']) {
    const src = join(demoRoot, folder);
    if (!existsSync(src)) continue;
    for (const name of readdirSync(src)) {
      if (!name.endsWith('.md') || name.startsWith('_') || name === 'index.md') continue;
      const content = readFileSync(join(src, name), 'utf8');
      writeFileSync(join(dir, folder, name), content, 'utf8');
      count++;
    }
  }
  return count;
}

function initGit(dir) {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'git not found in PATH — skipping git init (structure created without it)' };
  }
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'samemind: initial bundle'], { cwd: dir, stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `git init/commit did not complete (${e.message.split('\n')[0]}) — files are in place, commit manually` };
  }
}

/**
 * Scaffolds a fresh OKF bundle into targetDir.
 * Refuses (returns {ok:false}) if targetDir exists and is non-empty — never overwrites.
 */
export function runInit({ targetDir = '.', demo = false, packageRoot = PACKAGE_ROOT } = {}) {
  const dir = resolve(targetDir);

  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      return { ok: false, reason: `"${dir}" exists and is not a directory` };
    }
    const entries = readdirSync(dir);
    if (entries.length > 0) {
      return {
        ok: false,
        reason: `directory "${dir}" is not empty (${entries.length} entries) — samemind init only works on an empty directory, nothing created or overwritten`,
      };
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  for (const folder of FOLDERS) mkdirSync(join(dir, folder), { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const bundleName = basename(dir) || 'memory';

  writeFileSync(join(dir, 'index.md'), rootIndexMd(bundleName), 'utf8');
  writeFileSync(join(dir, 'log.md'), rootLogMd(today), 'utf8');
  writeFileSync(join(dir, 'DASHBOARD.md'), DASHBOARD_PLACEHOLDER, 'utf8');
  writeFileSync(join(dir, '.gitignore'), GITIGNORE, 'utf8');

  writeFileSync(join(dir, 'concepts', '_template.md'), CONCEPTS_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_identity-template.md'), IDENTITY_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_engine-rule-template.md'), ENGINE_RULE_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_decision-template.md'), DECISION_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_session-template.md'), SESSION_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_analysis-template.md'), ANALYSIS_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_research-template.md'), RESEARCH_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', '_idea-template.md'), IDEA_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'concepts', 'index.md'), CONCEPTS_INDEX, 'utf8');
  writeFileSync(join(dir, 'entities', '_template.md'), ENTITIES_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'entities', '_user-template.md'), USER_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'entities', 'index.md'), ENTITIES_INDEX, 'utf8');
  writeFileSync(join(dir, 'projects', '_template.md'), PROJECTS_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'projects', '_plan-template.md'), PLAN_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'projects', '_task-template.md'), TASK_TEMPLATE, 'utf8');
  writeFileSync(join(dir, 'projects', 'index.md'), PROJECTS_INDEX, 'utf8');
  writeFileSync(join(dir, 'inbox', 'index.md'), INBOX_INDEX, 'utf8');
  writeFileSync(join(dir, 'secret', '_template.md'), SECRET_TEMPLATE, 'utf8');

  const demoCopied = demo ? copyDemoContent(dir, packageRoot) : 0;
  const git = initGit(dir);

  return { ok: true, dir, demoCopied, git };
}

function parseArgs(argv) {
  const demo = argv.includes('--demo');
  const positional = argv.filter(a => !a.startsWith('--'));
  return { targetDir: positional[0] || '.', demo };
}

function printNextSteps() {
  console.log('');
  console.log('Next steps:');
  console.log('  1. add a concept — copy concepts/_template.md → concepts/<name>.md and fill it in');
  console.log('  2. personality layer (who\'s the agent / who\'s the owner / engine role) — concepts/_identity-template.md,');
  console.log('     entities/_user-template.md, concepts/_engine-rule-template.md (docs/identity-layer.md)');
  console.log('  3. npx samemind query list — see what\'s already in the bundle');
  console.log('  4. npx samemind brief — compact brief (identity+owner+engine) for engine instructions');
  console.log('  5. npx samemind board --write — work-discipline kanban into DASHBOARD.md');
  console.log('  6. npx samemind serve — MCP stdio server (claude mcp add samemind -- npx samemind serve)');
}

async function main() {
  const { targetDir, demo } = parseArgs(process.argv.slice(2));
  const result = runInit({ targetDir, demo });
  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    process.exit(1);
  }
  console.log(`✓ bundle created: ${result.dir}`);
  if (demo) console.log(`  --demo: copied ${result.demoCopied} demo concepts`);
  if (result.git.ok) console.log('  git init + initial commit done');
  else console.log(`  ⚠ ${result.git.reason}`);
  printNextSteps();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
