---
name: "Sort Arena — Efficient Selection Strategy"
description: "Coaches an efficient, low-swap strategy for the CADS-DEMO-sort move protocol: maintain a sorted prefix, place each position exactly once, and never spend a round on information the input already gives you. Use when driving a participant handler in the sort arena."
---

# Sort Arena — Efficient Selection Strategy

## What This Skill Does

Turns "sort this array, one primitive move per call" from an improvised guessing game into a
disciplined, stateless algorithm. Every round you are handed the REAL current array; this skill
tells you how to derive the single best move from it without needing memory of previous rounds.

## The three facts the strategy rests on

1. **You can already see every value.** The round input's `array` field is the complete, true
   current state. Nothing is hidden.
2. **Therefore a `compare` move buys you nothing.** `compare` reveals which of two elements is
   larger — but you can read both values directly. It costs a round out of the budget and moves
   the array not one step closer to sorted. Spend rounds on `swap`.
3. **Adjacent swaps are the expensive way to sort.** Bubbling a value into place one neighbour at
   a time costs one swap per inversion. Placing it in one jump costs one swap, full stop.

## The strategy: selection sort by direct placement

Treat the array as a sorted prefix `array[0..p-1]` followed by an unsorted suffix `array[p..n-1]`.

1. **Find the insertion position `p`** — the smallest index where the prefix stops being sorted
   and correct. Concretely: walk from index 0 and let `p` be the first index such that
   `array[p]` is NOT the minimum of `array[p..n-1]`. Every index before `p` is already final.
2. **Find `m`**, the index of the minimum value in `array[p..n-1]`.
3. **Emit one swap**: `{"action":"swap","i":p,"j":m}`. This makes index `p` final in a single
   move, regardless of how far away `m` was.
4. **If no such `p` exists**, the array is fully sorted — emit `{"action":"done"}`.

Because `i != j` is required by the protocol, step 1's definition of `p` already guarantees
`m != p`: if `array[p]` were the minimum of its suffix, `p` would not have been chosen.

## Why this is measurably cheaper

An array of length `n` needs at most `n - 1` swaps under direct placement, and usually fewer
(any element already in its final spot is skipped for free). Adjacent-swap strategies instead
need one swap per inversion — for a shuffled array of length `n` that is on the order of
`n²/4`. Combined with spending zero rounds on `compare`, the round count collapses.

## Discipline rules

- Recompute `p` and `m` from THIS round's `array` every time. Never carry an assumption from a
  previous round; the process is invoked fresh each round and history is only a log.
- Never emit `done` unless you have checked every adjacent pair `array[k] <= array[k+1]`. A wrong
  `done` costs a round and is recorded against you.
- One JSON object, no prose, no markdown fences. The protocol is strict and a violation is a
  fault regardless of how good the intended move was.

## Worked example

`array = [5, 3, 8, 1, 9, 2]`

- Minimum of `array[0..5]` is `1` at index 3; `array[0] = 5` is not it, so `p = 0`, `m = 3`.
- Emit `{"action":"swap","i":0,"j":3}` → `[1, 3, 8, 5, 9, 2]`.
- Next round: index 0 is final. Minimum of `array[1..5]` is `2` at index 5, `array[1] = 3` is not
  it → `{"action":"swap","i":1,"j":5}` → `[1, 2, 8, 5, 9, 3]`.
- And so on. Five rounds at most for a six-element array, plus one `done`.
