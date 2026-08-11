# bubble-sort-claude

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

<!-- filled in after the real dryrun.py run against handler.sh — see run log -->

## Running it yourself

```bash
./handler.sh --selftest    # checks SKILL.md is present and loadable, plus extraction; no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"bubble-sort-claude"}' \
  | ./handler.sh           # one real LLM call
```

Edit `SKILL.md` and re-run — the handler re-reads the file on every invocation.
