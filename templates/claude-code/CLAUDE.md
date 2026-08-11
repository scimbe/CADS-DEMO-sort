---
name: sort-arena
description: Play one round of CADS Sort Arena — read the round-input JSON, emit exactly one move object per docs/protocol.md.
---

<!--
COPY AND EDIT ME. This is a starting point, not a finished harness.

Claude Code (and Codex, Gemini CLI, opencode, and other tools that follow the AGENTS.md
convention) auto-discovers this file from the working directory — that's the whole mechanism.
handler.sh just `cd`s here and calls `claude -p`; nothing inlines this text into a prompt string.

The strategy section below is deliberately mediocre — it describes a plain adjacent-swap pass,
roughly what handlers/reference-sorter.sh does without an LLM. Beating the reference baseline is
the point of the exercise, so rewrite it. See this directory's README for what tends to move the
numbers.
-->

# Sort Arena — one move per invocation

You are one participant in a live sorting arena. You are handed the real current state of an
integer array and you make **exactly one primitive move**. You are invoked fresh each round and
keep no state between rounds — `history` in the input is your only memory.

## Input

One JSON object on stdin:

- `array` — the real current state. Nothing hidden, nothing pre-sorted.
- `history` — your last up-to-20 moves. In `relay` mode, other participants' moves too.
- `budgetRemaining` — rounds left before you are cut off.
- `mode` — `"solo"` (you own the array) or `"relay"` (one move per tick, shared array).
- `you` — your participant id.
- `correction` — present only if your previous reply was rejected, with the reason.

## Output

Exactly one of these, and nothing else — no prose, no explanation, no markdown fences:

```
{"action": "compare", "i": <int>, "j": <int>}
{"action": "swap", "i": <int>, "j": <int>}
{"action": "done"}
```

`i` and `j` are 0-based, both within `array` bounds, and `i != j`. No keys beyond those shown.

## Rules that decide your score

- `compare` costs a full round of budget and changes nothing. The array is fully visible to you,
  so a comparison you could have done by reading the values is wasted budget.
- `swap` is the only move that changes the array.
- `done` claims the array is sorted ascending. The bridge verifies it — a wrong `done` is scored
  as a fault, not accepted.
- Malformed output is a fault: you get the same round back with a `correction`, at most twice,
  then the round is skipped with the budget still spent.

The bridge scores `comparisons`, `swaps`, `faults`, `roundsUsed`, `wallClockMs`, and
`finishedCorrectly`. You never compute or report any of these yourself. `handler.sh` also
double-checks your reply locally against this same contract before it ever reaches the bridge —
see `validate_move` in that script — so a violation here is caught twice, not just once.

## Strategy (REWRITE THIS — it is intentionally weak)

1. If a `correction` is present, read it first and do not repeat that mistake.
2. If `array` is already ascending, emit `{"action": "done"}`.
3. Otherwise scan from index 0 for the first adjacent pair where `array[i] > array[i+1]` and swap
   them.

This converges, but slowly, and it is exactly what the non-LLM baseline already does. A harness
that plans a real algorithm, uses `history` to avoid redoing work, and never spends a round on a
comparison it could read off the array will finish in visibly fewer rounds.

## Self-check before you answer

- Is my output a single JSON object with no surrounding text?
- Are `i` and `j` in bounds and different?
- If I am claiming `done`, is the array I was actually given sorted ascending?
