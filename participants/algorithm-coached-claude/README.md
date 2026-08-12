# algorithm-coached-claude

> **This README describes the pre-`sort-arena-harness`-skill architecture** — a live `claude -p`
> call per round, coached by a `SKILL.md` file inlined into the system prompt. This participant
> has since been migrated to the two-stage generated-code harness: `AGENTS.md` is the spec,
> `generate.sh` writes `generated/handler.py` once, and `handler.sh` just execs that file — zero
> LLM calls happen during a live run today. The experiment writeup below (duplicate-value bug,
> the oscillation, the confound check) is kept as real project history and the algorithm reasoning
> is still accurate; only the "how a move actually gets decided" parts are historical. See
> `AGENTS.md` and `generate.sh` for the current design, and "Running it yourself" at the bottom
> for what actually runs today.

Same model as [`../minimal-claude/`](../minimal-claude/), same CLI, same JSON extraction, same
strict contract. One thing added: a real Claude Skill file, [`SKILL.md`](SKILL.md), that teaches
a specific efficient strategy.

## What is different about this harness

`SKILL.md` coaches selection-sort-by-direct-placement and two supporting insights:

1. Maintain a sorted prefix; each round find the first index `p` that is not yet final and the
   index `m` of the minimum of the remaining suffix, and swap them. One swap makes one position
   final, however far apart they are — instead of one swap per inversion.
2. A `compare` move is worthless here. `compare` reveals which of two elements is larger, but the
   round input already hands you the entire array. Spending a round on it costs budget and buys
   nothing.

### How the skill is actually loaded — plainly

A Claude Code skill is not invocable from `claude -p` the way it is inside an interactive
session. So `handler.sh` **reads `SKILL.md` off disk at call time and inlines its full text into
`--append-system-prompt`**, between explicit BEGIN/END SKILL markers.

This is not "skill invocation" and we are not going to call it that. For a non-interactive
one-shot call it achieves the same *effect* — the model has the skill's instructions in context
when it chooses its move — and it keeps the pedagogical property that matters: the strategy lives
in a versioned, readable, editable file that a workshop participant can open, change, and re-run,
not buried in a shell string.

## Prediction (stated before the run)

Fewer comparisons and fewer swaps than `minimal-claude` to reach sorted, and a low fault rate.

## Live test result

Two real runs against `bridge/server.js`, `len=6`, `SORT_BUDGET=20`, default `claude` CLI
(Claude Code 2.1.222). Two runs because the bridge randomizes the array per run and the first
draw was unusually easy — see "the confound" below.

| Metric | Run 1 | Run 2 |
|---|---|---|
| initial array | `[16, 46, 23, 84, 46, 77]` (3 inversions) | `[18, 60, 61, 29, 26, 25]` (9 inversions) |
| final array | `[16, 23, 46, 46, 77, 84]` | `[18, 25, 26, 29, 60, 61]` |
| `finishedCorrectly` | **true** | **true** |
| `comparisons` | **0** | **0** |
| `swaps` | 6 | 7 |
| `faults` | 1 | 0 |
| `roundsUsed` | 8 | 8 |
| `wallClockMs` | 92 482 (median 7 482 ms/round) | 63 551 (median 7 731 ms/round) |
| `inversionsOverTime` | `[3, 2, 3, 2, 2, 1, 0]` | `[9, 4, 7, 4, 7, 4, 1, 0]` |

### The confound, and why the result survives it

Run 1 drew a 3-inversion array while `minimal-claude` drew a 10-inversion one, so "8 rounds beats
20 rounds" proved little on its own. Run 2 was done specifically to check this: it drew **9**
inversions — comparable to `minimal-claude`'s 10 and equal to `verbose-reasoner-claude`'s 9 — and
still finished correctly in **8 rounds with 0 comparisons and 0 faults**. The coaching effect is
real, not an artifact of an easy draw.

### Verdict: comparisons decisively confirmed, swaps refuted, faults not supported

**Confirmed, strongly — comparisons.** Zero, in both runs, 16 rounds total. `minimal-claude` spent
2 rounds on comparisons and `chaotic-claude` spent 15. The single sentence "you can already see
every value, so `compare` teaches you nothing" removed an entire category of wasted round. This
was the cleanest, most reproducible effect measured anywhere in this directory.

**Confirmed — reaching sorted at all.** 8 rounds, twice, versus `minimal-claude` never finishing
within 20.

**Refuted — swaps.** 6 and 7 swaps, versus `minimal-claude`'s 5. Taken literally the prediction is
wrong. But the comparison is not meaningful in the direction it looks: `minimal-claude`'s 5 swaps
left the array *unsorted*, one inversion short. Counting swaps against a participant that never
finished rewards giving up early. Rounds-to-sorted is the honest measure, and there the coached
harness wins outright. The prediction should have been stated as swaps-per-inversion-removed.

**Not supported — "low fault rate."** Run 1 had 1 fault versus `minimal-claude`'s 0, so the
coached harness was, on that run, the *less* contract-compliant of the two. The fault is worth
looking at: the model emitted a swap with `i == j`, which `validateMove` rejects. `SKILL.md`
explicitly warns that `p` and `m` can never coincide if `p` is derived correctly — the model
derived `p` wrong on an array containing duplicate values (`46` twice) and walked straight into
the case the skill told it was impossible. Run 2, on a duplicate-free array, had 0 faults.
One run each is far too little to call this a duplicates effect, but it is the obvious next
experiment for a workshop group to run.

### The oscillation

Run 2's `inversionsOverTime` is not monotone: `9 → 4 → 7 → 4 → 7 → 4 → 1 → 0`. Rounds 2–5 emitted
`swap(0,3)` four times in a row, toggling the array between two states before breaking out. The
handler is invoked fresh every round and holds no state, so a model that mis-derives `p` the same
way twice will re-emit the same move and undo itself. Coaching improved the strategy; it did not
make the participant immune to re-deriving a wrong answer consistently. That the run still
finished in 8 rounds *despite* burning 4 of them on an oscillation says something about how much
headroom the direct-placement strategy has.

## Running it yourself

`generated/` is gitignored (it's build output, not source), so a fresh clone doesn't have
`generated/handler.py` yet — run `./generate.sh` once first, or every round below will fault:

```bash
./generate.sh               # writes generated/handler.py, only needed once per clone
./handler.sh --selftest     # checks generated/handler.py exists and emits a valid move; no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"algorithm-coached-claude"}' \
  | ./handler.sh            # runs the already-generated code; no LLM call
```

To change the strategy, edit `AGENTS.md` and re-run `./generate.sh` — that regenerates
`generated/handler.py` once; `handler.sh` picks up the new file on its next invocation with no
restart needed.
