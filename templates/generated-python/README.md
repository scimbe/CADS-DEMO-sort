# Sort Arena template — generated Python (two-stage)

The generic two-stage scaffold: an LLM writes your sorting strategy **once, as real Python code**,
and that generated program — not a live model call — is what plays every round from then on. This
is the pair that `participants/bubble-sort-claude/` and `participants/algorithm-coached-claude/`
each hand-wrote for themselves, made copy-ready: both scripts derive your participant id from the
directory name (`basename`), so the copy needs **zero edits** before its first run.

## When to copy this (vs. the sibling templates)

The four sibling templates (`claude-code/`, `codex/`, `gemini-cli/`, `opencode/`) call a live
model **every round** — the model is your sorter. Copy *this* directory instead when you want the
two-stage shape: model writes code once → code runs the contest deterministically, in
milliseconds, verifiably. The tradeoffs are laid out in
[`CADS-DEMO-sort-docs` — Coaching a strategy](https://scimbe.github.io/CADS-DEMO-sort-docs/tutorials/coaching-a-strategy/),
which also shows the class of live-judgment bug this shape eliminates.

## How to use it

```bash
# 1. copy the pair into a NEW participant directory (never edit the template in place)
mkdir -p participants/<your-id>
cp templates/generated-python/generate.sh templates/generated-python/handler.sh participants/<your-id>/

# 2. write the one file that is genuinely yours: the strategy spec
$EDITOR participants/<your-id>/AGENTS.md     # plain language; see the tutorials for working examples

# 3. generate + verify (both documented end to end in docs/onboarding.md)
cd participants/<your-id>
./generate.sh                                 # asks $CT_LLM_CMD (default: claude) to write generated/handler.py
./handler.sh --selftest                       # does the generated code speak the contract at all?
python3 ../../dryrun.py ./handler.sh --len 8 --seed 42   # actually sorts a real array — run twice, must match
```

What goes **next to** the copied pair:

| File | Who writes it | Purpose |
|---|---|---|
| `AGENTS.md` | **you** | the strategy spec `generate.sh` feeds to the model — the only required input |
| `generated/handler.py` | the model, via `generate.sh` | your actual competitor; regenerate any time `AGENTS.md` changes |

`generated/` is gitignored repo-wide (generated code is rebuilt, not committed).

## Guided path

If you drive Claude Code, the repo's `sort-arena-harness` skill walks you through exactly this
flow (it copies this very pair for you). Other agent CLIs can follow the same skill file by being
pointed at `.claude/skills/sort-arena-harness/SKILL.md` — or do the steps above by hand; they end
in the same place.
