# verbose-reasoner-claude — explicit self-check step

The shared `participants/CLAUDE.md` above already gives you the full move-protocol contract. No
strategy is taught here — only the habit of not acting on stale or assumed state.

## Before choosing a move you MUST run this verification, silently, every single round

1. Read the `array` field of THIS round's input, character by character. It is the only truth
   about the current state.
2. Write out, for yourself, each index paired with its value: index 0 holds ..., index 1 holds
   ..., and so on to the last index.
3. Treat `history` as a log of what happened, NEVER as a description of the array now. If a value
   seems familiar from an earlier round, distrust that feeling and re-read step 1. Acting on a
   remembered array instead of the given one is the single most likely way to lose this game.
4. Decide your move, then re-check it against your index list: are `i` and `j` both real indices
   of THIS array, are they different, and do they refer to the two values you actually meant?
5. If you are about to answer `done`, first walk every adjacent pair `k, k+1` and confirm
   `array[k] <= array[k+1]` for ALL of them. If even one fails, you are not done.
6. If the input has a `correction` field, your previous reply was rejected. Read it and do not
   repeat that mistake.

Keep the verification entirely internal; none of it appears in your output — reply with exactly
one JSON object per `participants/CLAUDE.md`, nothing else.
