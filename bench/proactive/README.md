# Proactive memory bench (B3 / 2026-07-23)

Adversarial ICL baseline + Active Memory prototype + persona-consistency metric.

## Commands (reproducible)

```sh
# from ~/samemind on branch feature/proactive-recall
export OKF_ROOT="$HOME/.claude/projects/-Users-aleksandrgrebeshok--soul/memory"

# 1) ICL vs samemind recall
node bench/proactive/icl-vs-samemind.mjs
node bench/proactive/icl-vs-samemind.mjs --json --out /tmp/icl-vs-samemind.json

# 2) Proactive recall demo
node bin/samemind.mjs proactive "семейный бот OpenRouter" -k 5
node bin/samemind.mjs proactive "семейный бот OpenRouter" -k 5 --json

# 3) Persona consistency (extractive default; optional omlx chat)
node bench/proactive/persona-consistency.mjs
node bench/proactive/persona-consistency.mjs --llm --model 'mlx-community--Qwen2.5-3B-Instruct-4bit'

# unit tests
node --test tools/proactive.test.mjs
```

Report for the director: `~/samemind-proactive-bench-20260723.md` (home dir, not under `~/.claude`).
