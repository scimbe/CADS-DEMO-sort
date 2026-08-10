# chaotic-claude

Same model, same CLI, same JSON extraction, same strict contract as
[`../minimal-claude/`](../minimal-claude/). One thing changed: the system prompt actively rewards
undisciplined move selection.

## What is different about this harness

The strategy half of the system prompt tells the model to be exploratory and unpredictable, to
avoid the obvious move, to *not* follow any named sorting algorithm, to prefer distant unusual
index pairs over neighbouring ones, to spend rounds on `compare` freely "just to look around,"
and to deliberately do something unlike its recent moves in `history`.

The contract half is, if anything, **more** emphatic than the baseline's, ending with: *"Your
creativity applies to WHICH move you pick, never to HOW you report it. Breaking this format is a
wasted round, not an interesting choice."*

That split is the entire design. A participant that produces garbage on stdout teaches nothing
except that the bridge does not crash — which `docs/protocol.md` already guarantees and
`bridge/server.test.js` already proves. A participant that stays perfectly inside the contract
while sorting *badly* is the one that makes "the harness is the variable" visible on screen.

## Prediction (stated before the run)

Measurably more comparisons and swaps than `minimal-claude` to reach the same sortedness, and
possibly a failure to finish within budget. Some increase in faults would be a legitimate and
honest side effect of a less careful model response — to be reported, not suppressed — but a
broken contract is not the goal.

## Live test result

Real run against `bridge/server.js`, `len=6`, `SORT_BUDGET=20`, default `claude` CLI
(Claude Code 2.1.222).

| Metric | Value |
|---|---|
| initial array | `[33, 28, 65, 28, 98, 40]` (5 inversions) |
| final array | `[28, 40, 33, 28, 98, 65]` (4 inversions) |
| `finishedCorrectly` | **false** |
| `comparisons` | **15** |
| `swaps` | 5 |
| `faults` | **0** |
| `roundsUsed` | 20 (the entire budget) |
| `wallClockMs` | 150 857 (median 7 438 ms per round) |
| `inversionsOverTime` | `[5, 7, 10, 8, 5, 4]` |

### Verdict: confirmed, on every axis that was predicted

**Confirmed — comparisons.** 15 of 20 rounds went to `compare`. `minimal-claude` spent 2;
`algorithm-coached-claude` spent 0 across two runs. Three quarters of this participant's entire
budget was spent looking at values that were already printed in full in its own input, every
round. This is the single most legible number in the whole directory, and it is produced purely
by prompt wording — same model, same script, same everything else.

**Confirmed — failure to finish.** All 20 rounds consumed, still 4 inversions away.

**Confirmed, and better than predicted — it actively went backwards.** `inversionsOverTime` reads
`5 → 7 → 10 → 8 → 5 → 4`. Its first two swaps *doubled* the distance from sorted, taking a
5-inversion array to 10. It spent the remaining 15 rounds clawing back to 4 — worse than the
array it was handed. The prediction said "more work to reach the same sortedness"; the reality was
"never reached it, and made it worse first." That shape is exactly what makes this participant
worth watching in the animation: `algorithm-coached-claude`'s trace falls to zero, this one
climbs, wanders, and stalls above its own starting point.

**Confirmed — the contract held.** **Zero faults in 20 rounds.** This is the result that
validates the design. Told in the same breath to be reckless about strategy and rigid about
format, the model separated the two cleanly and never once violated the protocol. The "worse
strategy, not broken contract" split is achievable in practice and not merely in intent — and the
predicted possibility of incidental faults simply did not materialise.

**Worth noting:** its swap count (5) is identical to `minimal-claude`'s (5), and its median
per-round wall clock (7 438 ms) is the *fastest* of all four participants. Judged on swaps or on
speed alone, this participant looks fine. It is only `comparisons`, `roundsUsed` and
`inversionsOverTime` together that show it is the worst of the four. A good argument for why the
arena scores several things at once instead of picking one headline number.

## Running it yourself

```bash
./handler.sh --selftest    # extraction logic only, no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"chaotic-claude"}' \
  | ./handler.sh           # one real LLM call
```
