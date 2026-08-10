# verbose-reasoner-claude

Same model, same CLI, same JSON extraction, same strict contract as
[`../minimal-claude/`](../minimal-claude/). One thing added: a mandatory self-check step before
every move.

## What is different about this harness

The system prompt adds a six-step verification the model must run silently each round:

1. Read **this** round's `array` field character by character — it is the only truth about the
   current state.
2. Write out each index paired with its value.
3. Treat `history` as a log of what happened, never as a description of the array now. *"If a
   value seems familiar from an earlier round, distrust that feeling and re-read step 1."*
4. Re-check the chosen `i` and `j` against that index list: both real indices, different from
   each other, pointing at the values actually intended.
5. Before answering `done`, walk **every** adjacent pair and confirm `array[k] <= array[k+1]`.
6. If the input carries a `correction` field, read it and do not repeat that mistake.

No strategy is taught — no algorithm, no efficiency advice, nothing about `compare` being
redundant. The only thing added is the habit of not acting on stale or assumed state. All
verification stays internal; the output is still exactly one JSON object.

## Prediction (stated before the run)

Fewer faults and higher correctness than `minimal-claude`, but **slower** — measurably more
wall-clock time per move. A genuine trade-off, not simply "better."

## Live test result

Real run against `bridge/server.js`, `len=6`, `SORT_BUDGET=20`, default `claude` CLI
(Claude Code 2.1.222).

| Metric | Value | `minimal-claude` for comparison |
|---|---|---|
| initial array | `[49, 57, 58, 5, 54, 12]` (9 inversions) | `[17, 22, 62, 27, 12, 4]` (10 inversions) |
| final array | `[5, 12, 49, 54, 57, 58]` | `[4, 17, 12, 22, 27, 62]` |
| `finishedCorrectly` | **true** | false |
| `comparisons` | 1 | 2 |
| `swaps` | 7 | 5 |
| `faults` | 0 | 0 |
| `roundsUsed` | **9** | 20 (budget exhausted) |
| `wallClockMs` | 69 479 | 158 624 |
| median ms per round | **7 543** | 7 573 |
| `inversionsOverTime` | `[9, 8, 7, 6, 5, 4, 3, 0]` | `[10, 5, 4, 3, 2, 1]` |

The two runs drew comparable arrays — 9 inversions against 10 — so this is the closest to a
controlled comparison anywhere in this directory.

### Verdict: correctness confirmed, the trade-off refuted

**Confirmed — correctness, and precisely at the predicted mechanism.** It finished, correctly, in
9 rounds. More pointedly: it emitted `{"action":"done"}` **exactly once**, at round 9, and the
bridge confirmed the array was genuinely sorted. `minimal-claude`, on a comparable array, emitted
`done` **thirteen times** and was wrong every time, burning 13 of its 20 rounds on unverified
completion claims.

Step 5 of the self-check — walk every adjacent pair before claiming done — is aimed at exactly
that failure, and it worked. Same model, same task, same contract; one added paragraph turned a
run that never finished into one that finished cleanly.

**Refuted — "but slower."** This is the interesting miss. Median wall clock per round was
**7 543 ms against the baseline's 7 573 ms** — a 30 ms difference on ~7.5 s calls, i.e.
indistinguishable, and if anything nominally *faster*. Total wall clock was less than half the
baseline's (69 s vs 159 s), because finishing in 9 rounds instead of grinding through 20 dominates
everything else.

Why the prediction was wrong: it assumed "more reasoning" converts into "more time." At a
six-element array the verification is a handful of tokens of internal reasoning against a
per-call cost dominated by process spawn, CLI startup, and network round-trip. The self-check
never got large enough to show up. The prediction is not obviously wrong in general — at
`MAX_ARRAY_LEN` (24) the step-5 walk is four times longer — it was wrong *at this scale*, and the
run does not license any claim about larger arrays. Re-running at `len=24` is the obvious
follow-up and would make a good workshop exercise.

So the intended lesson — "this one is not simply better, it buys correctness with time" — did not
survive contact with a real measurement. At this array size it was better on **both** axes. The
honest version of the lesson is narrower and, arguably, more useful: *a verification step is
nearly free when the thing being verified is small, and the failure it prevents is expensive.*

**One more honest note:** 7 swaps to clear 9 inversions, with a monotone
`9 → 8 → 7 → 6 → 5 → 4 → 3 → 0` descent, is decent but not the tight direct-placement pattern
[`../algorithm-coached-claude/`](../algorithm-coached-claude/) produces. Six of its seven swaps
removed exactly one inversion each — an adjacent-swap-shaped trace — before a final swap cleared
three at once. Verification made it *reliable*; it did not make it *efficient*. Those are
genuinely different axes, which is what this participant was built to show, even though it
demonstrated it on a different pair of axes than predicted.

## Running it yourself

```bash
./handler.sh --selftest    # extraction logic only, no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"verbose-reasoner-claude"}' \
  | ./handler.sh           # one real LLM call
```
