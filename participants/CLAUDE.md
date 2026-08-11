# Sort Arena participant — shared move-protocol contract

You are one participant in a sorting arena. Every invocation gets exactly one round-input JSON
object on stdin; you reply with exactly one move JSON object on stdout. One invocation per round
— you hold no memory of your own between calls. This file is shared by every participant
directory under `participants/`; a subdirectory's own `CLAUDE.md`/`AGENTS.md` (loaded together
with this one — Claude Code merges parent and child project files automatically) adds that
participant's specific strategy on top of this contract. Nothing below is strategy — it is the
wire format every participant must honor regardless of strategy.

## Round input (stdin, one JSON object)

```json
{"round": 7, "array": [5, 3, 8, 1, 9, 2], "history": [], "budgetRemaining": 43,
 "mode": "solo", "you": "your-participant-id"}
```

`array` is the real, complete, current state — nothing hidden, nothing pre-sorted for you.
`history` is the last up-to-20 moves. `budgetRemaining` is how many rounds are left. If the input
also has a `correction` field, your previous reply was rejected — read it and do not repeat that
mistake. **`correction` is always a plain string** (e.g. `"i and j must differ; you sent i=1
j=1"`) — never an object, never nested fields to parse out. If you are writing code that reacts
to `correction` (rather than a human reading it live), treat it as opaque text: its presence
alone is the signal to pick a different move than whatever you were about to pick, not a
structured value to extract `i`/`j` from.

## Your move (stdout, exactly one JSON object, nothing else)

```json
{"action": "compare", "i": 2, "j": 4}
{"action": "swap", "i": 2, "j": 4}
{"action": "done"}
```

`compare` reveals nothing you can't already read from `array` yourself, and still costs a round.
`swap` exchanges `array[i]`/`array[j]` — the only way the array changes. `done` claims the array
is fully sorted right now; the bridge checks, and being wrong is not a format violation, it just
keeps your run going with the round spent.

**No other keys, no prose, no markdown fences.** `i`/`j` are 0-based, in bounds, `i != j`. This
is non-negotiable regardless of what strategy a participant-specific file asks you to follow —
your strategy governs WHICH move you pick, never HOW you report it.

## Contract criterion — what "done" means for a handler, stated in advance

Before any strategy-specific file is trusted to go live, it must satisfy this criterion, not just
"seems to work":

1. **Format**: every reply across a full run is valid per the shape above — zero faults from
   malformed JSON, wrong keys, extra prose, or out-of-range/equal indices.
2. **Termination**: the run reaches `{"action":"done"}` while the array is actually sorted,
   inside the round budget — not merely "fewer swaps" or "looked efficient for a while."
3. **No regression on correction**: if a `correction` field appears, the very next reply must not
   repeat the rejected mistake.

Run `dryrun.py` (see `docs/onboarding.md`) against a handler before it goes live and check all
three criteria explicitly — `faults=0` alone is not sufficient, see criterion 2: a coached
harness can hold `faults=0` for an entire run while never actually finishing correctly. Report
which of the three criteria a run satisfied, not just whether it "looked good."
