# bubble-sort-claude

> **This README describes the pre-`sort-arena-harness`-skill architecture** — a live `claude -p`
> call per round, coached by a `SKILL.md` file inlined into the system prompt. This participant
> has since been migrated to the two-stage generated-code harness: `AGENTS.md` is the spec,
> `generate.sh` writes `generated/handler.py` once, and `handler.sh` just execs that file — zero
> LLM calls happen during a live run today. The design discussion and predictions below are kept
> because the algorithm reasoning is still accurate; only the "how a move actually gets decided"
> parts are historical. See `AGENTS.md` and `generate.sh` for the current design, and the "Running
> it yourself" section at the bottom for what actually runs today.

Same model as [`../minimal-claude/`](../minimal-claude/), same CLI, same JSON extraction, same
strict contract. Same *shape* of coaching as
[`../algorithm-coached-claude/`](../algorithm-coached-claude/) — a real `SKILL.md` inlined into
the system prompt — but a different algorithm: real bubble sort, not selection sort.

## What is different about this harness

[`SKILL.md`](SKILL.md) coaches literal bubble sort: visit adjacent pairs left to right, one pair
per round, swap when out of order, wrap to a new pass at the end of the array, stop only once
this round's real `array` is directly confirmed sorted.

The interesting engineering problem this skill solves: real bubble sort needs to remember *where
it is* in a pass and *whether the current pass has swapped anything*, but this handler is invoked
fresh every round with no memory of its own. The skill reconstructs the cursor from the single
most recent entry in `history` (`i + 1` from your last move, wrapping to `0` at the end of the
array) and reconstructs "done" not by pass-tracking but by directly checking this round's real
`array` for being fully sorted — simpler and more robust than trying to remember a pass boundary
through a capped 20-entry history window.

## Why this is a second, orthogonal axis of comparison

`algorithm-coached-claude` and this participant are both fully coached, both zero-guesswork, both
reading a `SKILL.md` file. The difference is not harness discipline — it's algorithm choice. A
correct direct-placement (selection-sort-style) strategy needs at most `n - 1` swaps and zero
comparisons. Correct bubble sort needs one round per adjacent pair visited, every pass, until a
pass makes no swaps — `O(n^2)` in the worst case. If this participant uses visibly more rounds
than `algorithm-coached-claude` on a comparable array, that is bubble sort's real, well-known
cost — not a harness defect. That distinction (harness quality vs. algorithm choice) is the whole
reason this participant exists rather than just re-running `algorithm-coached-claude` with a
different label.

## Known limitation

`solo` mode only — see the "Known limitation" section in [`SKILL.md`](SKILL.md). The move
protocol's `history` entries carry no participant-id tag, so this skill's cursor reconstruction
("my last move") cannot be trusted in `relay` mode, where other participants' moves interleave.

## Prediction (stated before the run)

Zero faults (same format-instruction reliability as every other coached participant here), and
noticeably more `roundsUsed` than `algorithm-coached-claude` for a comparably-scrambled array —
adjacent-only moves should cost roughly one round per inversion-adjacent-step rather than one
swap per out-of-place element.

## Live test result

Real `dryrun.py` run against the current generated handler (`generated/handler.py`, produced by
`generate.sh` from `AGENTS.md`), same 9-inversion array used for `algorithm-coached-claude`'s Run
2 above, `budget=600` (see the "Bounds" note in `docs/protocol.md` on why bubble sort's real
worst case needs a bigger budget than the default 200):

| Metric | Result |
|---|---|
| initial array | `[18, 60, 61, 29, 26, 25]` (9 inversions) |
| final array | `[18, 25, 26, 29, 60, 61]` |
| `finishedCorrectly` | **true** |
| `roundsUsed` | 17 |
| `faults` / `errors` | 0 / 0 |
| wall clock, whole run | ~1.1s (generated code — no LLM call per round anymore) |

Run twice against the identical array: byte-identical output both times (`rounds=17 faults=0
errors=0 sorted=True`), confirming this is real, deterministic, reliable code rather than a live
guess that happened to land once. 17 rounds against `algorithm-coached-claude`'s 8 on a comparably
scrambled array is bubble sort's real, well-known `O(n^2)` adjacent-only cost — see "Why this is a
second, orthogonal axis of comparison" above, not a harness defect.

## Running it yourself

`generated/` is gitignored (it's build output, not source), so a fresh clone doesn't have
`generated/handler.py` yet — run `./generate.sh` once first, or every round below will fault:

```bash
./generate.sh               # writes generated/handler.py, only needed once per clone
./handler.sh --selftest     # checks generated/handler.py exists and emits a valid move; no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"bubble-sort-claude"}' \
  | ./handler.sh            # runs the already-generated code; no LLM call
```

To change the strategy, edit `AGENTS.md` and re-run `./generate.sh` — that regenerates
`generated/handler.py` once; `handler.sh` picks up the new file on its next invocation with no
restart needed.
