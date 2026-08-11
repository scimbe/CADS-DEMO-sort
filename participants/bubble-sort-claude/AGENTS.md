# bubble-sort-claude — real bubble sort, adapted to a stateless one-move-per-call harness

The shared `participants/CLAUDE.md` above already gives you the full move-protocol contract.
This file adds a coached strategy on top of it: literal bubble sort.

## What makes this bubble sort specifically

Bubble sort is defined by ONE thing other strategies deliberately skip: it visits every adjacent
pair in order, left to right, one pair per step, and only ever compares or swaps neighbours. You
are invoked fresh every round with no memory of your own — reconstruct both the cursor position
and the termination condition from what the round input actually gives you.

- **Where you are (`k`, the next pair to visit):** look at the single most recent entry in
  `history` (the last one — it is always present, however long `history` is capped). Take its
  `i`. Your next cursor is `i + 1`, unless `i + 1` was already the last comparable pair
  (`i + 1 >= len(array) - 1`), in which case a full pass just finished and the cursor resets to
  `k = 0`, i.e. your next move is `i=0, j=1`. If `history` is empty (the first round), start at
  `k = 0`.
- **Whether you're done:** do NOT try to remember "did this pass have a swap." Instead look
  directly at THIS round's real `array`: if `array[m] <= array[m+1]` for every `m` from `0` to
  `len(array)-2`, the array is sorted right now — emit `done`. This is simpler and more robust
  than tracking a pass boundary through a capped 20-entry history window.

## The algorithm, restated as one round's decision

1. Check `array` directly for being fully non-decreasing. If yes: emit `{"action":"done"}`. Stop.
2. Otherwise compute `k` per the reconstruction rule above.
3. Look at `array[k]` and `array[k+1]` directly (you can already see both values):
   - If `array[k] > array[k+1]`: emit `{"action":"swap","i":k,"j":k+1}`.
   - Else (already in order): emit `{"action":"compare","i":k,"j":k+1}`.
4. Never skip a position, never move the cursor by more than one, never jump to a non-adjacent
   pair. `i` and `j` in every move you emit this round must satisfy `j == i + 1`.

Step 3's `compare` branch is not wasted the way it would be in a direct-placement strategy — it
is the honest translation of what real bubble sort does at a pair that needs no swap: it still
visits it, still spends a step on it, and moves on.

## Why this costs more rounds than a direct-placement strategy, on purpose

A direct-placement (selection-sort-style) coached harness needs at most `n - 1` swaps and zero
comparisons, because it's allowed to jump elements directly into place. Bubble sort, done
correctly, needs one round per adjacent pair visited, every pass, until a full pass needs zero
swaps — worst case `O(n^2)` rounds for a reversed array. If this participant's `roundsUsed` is
much higher than `algorithm-coached-claude`'s for the same array, that is the correct, expected,
and pedagogically useful result — the arena is comparing algorithms, not just harness discipline.

## Known limitation — solo mode only

The cursor-reconstruction rule reads "the single most recent entry in `history`" and assumes it
was your own last move. In `solo` mode that is always true. In `relay` mode, other participants'
moves interleave and the move protocol's `history` entries carry no participant-id tag — do not
use this strategy in `relay` mode without first solving that.

## Discipline rules

- Never emit `done` from a guess. Only after directly checking every adjacent pair in this
  round's real `array`.
- `i` and `j` must be adjacent (`j == i + 1`) in every single move — that is what makes this
  bubble sort and not some other pairwise strategy.

## Worked example

`array = [5, 3, 8, 1, 9, 2]`, `history = []` (first round).

- Array is not sorted. `history` is empty → `k = 0`.
- `array[0]=5`, `array[1]=3` → `5 > 3` → emit `{"action":"swap","i":0,"j":1}` → `[3,5,8,1,9,2]`.
- Next round, `history`'s last entry has `i=0`. `k = 0+1 = 1` (not yet at `len-2=4`, so no wrap).
- `array[1]=5`, `array[2]=8` → in order → emit `{"action":"compare","i":1,"j":2}` (unchanged).
- Next round: last entry `i=1` → `k=2`. `array[2]=8`, `array[3]=1` → `8>1` → `swap(2,3)` →
  `[3,5,1,8,9,2]`. And so on, one adjacent pair per round, wrapping to a new pass at `k=0` once
  `k` would exceed `len(array)-2`, until the direct sortedness check in step 1 says `done`.
