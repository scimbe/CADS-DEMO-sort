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

Your participant directory is YOUR project — by default it lives **outside** this repo clone
(so `git pull` never collides with your work; CADS-DEMO-sort#30). The directory's basename is
your participant id. Only two things ever come from the repo: the move contract
(`SORT_PROTOCOL_MD`) and `dryrun.py`.

```bash
# 1. copy the trio into a NEW participant directory (never edit the template in place)
REPO="$(pwd)"                                  # path of this clone
mkdir -p ../<your-id>/generated && cd ../<your-id>
cp "$REPO"/templates/generated-python/{generate.sh,handler.sh,reference-handler.py} .
export SORT_PROTOCOL_MD="$REPO/participants/CLAUDE.md"   # generate.sh reads the contract from here

# 2. INSTANT first success — a working baseline before any model call (CADS-DEMO-sort#30):
cp reference-handler.py generated/handler.py
./handler.sh --selftest                       # passes right now
python3 "$REPO/dryrun.py" ./handler.sh --len 8 --seed 42   # sorts right now (18 rounds, faults=0)

# 3. write the one file that is genuinely yours: the strategy spec
$EDITOR AGENTS.md                             # plain language; see the tutorials for working examples

# 4. generate your own strategy + verify (documented end to end in docs/onboarding.md)
./generate.sh                                 # $CT_LLM_CMD (default: claude) REPLACES the baseline with your strategy;
                                              # output is py_compile-checked and STAGED — a failed draw never touches
                                              # your existing handler; one automatic retry on garbage
./handler.sh --selftest
python3 "$REPO/dryrun.py" ./handler.sh --len 8 --seed 42   # run twice, must match
```

(Working inside the clone under `participants/<your-id>/` still works exactly as before — skip
the `SORT_PROTOCOL_MD` export, it defaults to `../CLAUDE.md`.)

What goes **next to** the copied pair:

| File | Who writes it | Purpose |
|---|---|---|
| `AGENTS.md` | **you** | the strategy spec `generate.sh` feeds to the model — the only required input |
| `reference-handler.py` | ships with the template | working baseline (adjacent-inversion bubble step, contract-verified incl. `correction`) — copy to `generated/handler.py` for an instant first success |
| `generated/handler.py` | the model, via `generate.sh` | your actual competitor; regenerate any time `AGENTS.md` changes |

`generated/` is gitignored repo-wide (generated code is rebuilt, not committed).

## Guided path

If you drive Claude Code, the repo's `sort-arena-harness` skill walks you through exactly this
flow (it copies this very pair for you). Other agent CLIs can follow the same skill file by being
pointed at `.claude/skills/sort-arena-harness/SKILL.md` — or do the steps above by hand; they end
in the same place.
