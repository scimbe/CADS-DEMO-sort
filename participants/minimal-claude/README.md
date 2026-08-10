# minimal-claude

The "just ask the model" baseline. Every other participant in this directory is the same model
with something added; this one is what you get with nothing added.

## What is different about this harness

Nothing, deliberately. `handler.sh` pipes the round input straight to `claude -p` with a system
prompt that contains **only** the output format and the one-line goal ("sort it ascending").

Specifically absent:

- no strategy coaching of any kind — no algorithm named, no efficiency advice
- no skill file
- no self-check or verification step
- single-shot per round: one LLM call, one move, no retry logic of our own (the bridge's
  correction protocol still applies, as it does for everyone)

The only non-trivial machinery is JSON extraction: the reply is flattened and the last `{...}`
object containing `"action"` is taken, so a ```json fence or a chatty preamble still yields a
usable move. If nothing extracts, the handler prints **nothing** and the bridge records a real
fault. It does *not* fall back to a default move — hiding a harness failure behind a plausible
move would destroy the only honest signal this demo has.

## Prediction (stated before the run)

Mediocre but functional. More comparisons than an algorithm-coached harness, and few faults —
the format instruction alone should be enough for Claude to stay inside the contract most of the
time.

## Live test result

Real run against `bridge/server.js` (real HTTP, real process spawn per round), `len=6`,
`SORT_BUDGET=20`, `CT_LLM_CMD` unset so the default `claude` CLI (Claude Code 2.1.222) was used.

| Metric | Value |
|---|---|
| initial array | `[17, 22, 62, 27, 12, 4]` (10 inversions) |
| final array | `[4, 17, 12, 22, 27, 62]` (1 inversion) |
| `finishedCorrectly` | **false** |
| `comparisons` | 2 |
| `swaps` | 5 |
| `faults` | **0** |
| `roundsUsed` | 20 (the entire budget) |
| `wallClockMs` | 158 624 (median 7 573 ms per round) |
| `inversionsOverTime` | `[10, 5, 4, 3, 2, 1]` |

### Verdict: half confirmed, half refuted — and the refutation is the interesting part

**Confirmed:** the fault prediction, emphatically. Zero faults in 20 rounds. The bare format
instruction really is enough to keep Claude inside a strict JSON contract.

**Refuted:** "functional." It never finished. And the way it failed was not the way anyone
predicted.

Rounds 1–7 went fine: inversions fell 10 → 5 → 4 → 3 → 2 → 1, real monotone progress. Then, at
`[4, 17, 12, 22, 27, 62]` — one inversion short of sorted, `17 > 12` at indices 1 and 2 — it
emitted `{"action":"done"}`. The bridge checked, found the array unsorted, and per
`docs/protocol.md` let the run continue. It then emitted `done` again. And again. **Thirteen
consecutive false `done` claims**, rounds 8 through 20, burning the entire remaining budget on
an array it could see in full, in every single round, with the inversion sitting at index 1.

The pedagogically sharp detail: **none of that was a fault.** A well-formed `done` is a valid
reply; being wrong about it is not a protocol violation. So this participant's scoreboard reads
`faults: 0` — a perfect contract-compliance record — next to `finishedCorrectly: false`. The
baseline harness's failure mode is not malformed output. It is confident, unverified,
indefinitely repeated self-assessment.

That is exactly the gap [`../verbose-reasoner-claude/`](../verbose-reasoner-claude/) adds a step
to close, and its run closes it: same model, one `done`, correct.

## Running it yourself

```bash
./handler.sh --selftest    # extraction logic only, no LLM call
echo '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":19,"mode":"solo","you":"minimal-claude"}' \
  | ./handler.sh           # one real LLM call
```
