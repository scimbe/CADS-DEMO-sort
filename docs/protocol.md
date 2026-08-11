# Sort Arena — the move protocol

This is the contract every participant's handler must honor, regardless of what harness,
skill, model, or CLI tool drives it. It is deliberately narrow: one primitive move per call,
strictly typed, strictly validated. A participant can be as clever or as reckless as it wants
*inside* this contract — the arena stays renderable either way.

## Why one move at a time, not "here's your sorted array"

Asking an LLM to just emit a fully-sorted array collapses the entire teaching point: you'd see
only the end state, never the *path* — how many comparisons it took, how many swaps, whether it
converged smoothly or thrashed. Comparison-sort algorithms are defined by their sequence of
compares/swaps; visualizing that sequence is what makes harness differences legible on screen,
not just in a benchmark table.

## Round input (bridge → participant, on stdin, one JSON object)

```json
{
  "round": 7,
  "array": [5, 3, 8, 1, 9, 2],
  "history": [
    {"round": 6, "action": "swap", "i": 2, "j": 4, "resultArray": [5, 3, 1, 8, 9, 2]}
  ],
  "budgetRemaining": 43,
  "mode": "solo",
  "you": "algorithm-coached-claude"
}
```

- `array` — the REAL current state. Nothing hidden, nothing pre-sorted for you. In race/partition
  mode this is your own copy/segment — never another participant's.
- `history` — the last up-to-20 moves (not the full trace, to keep the payload bounded — see
  "Bounds" below). Always your own moves only — no mode ever mixes another participant's moves in.
- `budgetRemaining` — how many more rounds this run allows before it's cut off (see "Bounds").
- `mode` — always `"solo"` today. Race and partition are both, from a single handler's own point
  of view, an ordinary solo run against a full array or a segment of one respectively — the
  distinction between arena modes lives entirely in how the bridge orchestrates and streams
  multiple participants, never in what one participant's own round input looks like.
- `you` — your own participant id.

## Your move (stdout, exactly one JSON object, nothing else)

```json
{"action": "compare", "i": 2, "j": 4}
```

```json
{"action": "swap", "i": 2, "j": 4}
```

```json
{"action": "done"}
```

- `compare` — reveals which of `array[i]`/`array[j]` is larger; does not change the array. Free
  of side effects, but still counts as a round (costs budget) — you can't peek for free forever.
- `swap` — exchanges `array[i]` and `array[j]`. This is the only way the array state changes.
- `done` — you believe the array is fully sorted. The bridge checks; if you're right, your run
  ends and your score is recorded. If you're wrong, that's a fault (see below) and you keep going.

No other keys, no prose, no markdown fences. `i`/`j` are 0-based integers, in bounds, and
`i != j`.

## Validation and faults — no participant can ever crash the arena

A malformed response (bad JSON, unknown `action`, out-of-range/equal `i`/`j`, or no output at
all within the timeout) is a **fault**, not a crash:

1. The bridge records the fault against that participant's score.
2. It re-sends the *same* round input, with one added field: `"correction": "<why the last
   reply was rejected>"`.
3. Up to 2 corrections per round. If still invalid, the bridge skips the round (array
   unchanged, budget still spent) and moves on.

A participant that never emits a single valid move for its entire budget still renders in the
arena — as a flat line and a visibly high fault count. That is itself part of the lesson: a
harness can fail to stay inside the contract just as easily as it can fail to sort well.

## Bounds (why the arena can't be griefed)

- `budgetRemaining` starts at a per-run cap — 200 rounds by default, overridable per request via
  `?budget=N` (clamped to 10–2000) for strategies whose worst case needs more room, e.g. bubble
  sort's O(n²) behavior on an unlucky seed. No participant can stall forever regardless of the
  chosen budget, since 2000 is the hard ceiling.
- Each round's LLM call is wrapped in a timeout (default 30s); a hang is a fault, not a hang.
- `history` sent per round is capped at 20 entries — the payload doesn't grow unbounded over a
  long run.
- `array` length is capped at a fixed max (default 24) — enough to be visually interesting,
  small enough that even a bad strategy finishes within budget.

## Scoring (what the arena measures and shows per participant)

Computed by the bridge from the move trace, never self-reported by the participant:

| Metric | Meaning |
|---|---|
| `comparisons` | count of valid `compare` moves |
| `swaps` | count of valid `swap` moves |
| `faults` | count of rejected/corrected/skipped rounds |
| `roundsUsed` | rounds consumed out of the budget |
| `wallClockMs` | total real time across all LLM calls |
| `inversionsOverTime` | array-length-sized series: inversion count after each move (a standard
  "how far from sorted" measure — 0 means sorted) |
| `finishedCorrectly` | whether `done` was called AND the array was actually sorted at that point |

`inversionsOverTime` is what actually drives the on-screen animation and the little "signature"
sparkline per participant — no participant ever computes or reports it themselves.

## Retired: relay mode

Earlier versions of this arena had a cooperative "relay" mode (one shared array, participants
taking turns). It's gone — retired 2026-08-11 in favor of race and partition modes below, which
answer the same "how do different harnesses compare" question more directly. `POST /relay` no
longer exists; a request to it now 404s like any other unknown route.

## Race mode (the direct head-to-head variant)

Same move contract, but instead of one participant owning a full run, every chosen participant
runs an independent `solo` session against its **own copy of the same starting array**,
concurrently. There is no shared state between them — `history` in a race is exactly the same
per-participant shape `solo` mode already sends, never mixed with another participant's moves.
What's new is only the pairing: `POST /race?ids=a,b,c&len=N` starts all of them on an identical
array and streams every participant's round events on one connection, each tagged with `you`,
plus a final ranked summary (finished-correctly first, then fewest `roundsUsed`, then fastest
`wallClockMs`). It answers a direct question: given the exact same array, whose harness actually
gets there first.

## Partition mode (the parallel-segments variant)

Same move contract again, but the array itself is split by **position** into one contiguous
segment per participant — length 100 split 3 ways gives 34/33/33, left segments absorbing the
remainder. Each participant sorts only its own segment: from its own point of view this is
indistinguishable from a normal `solo` run against a smaller array (same `history` shape, same
scoring fields), it just never sees the rest of the whole array.

`POST /partition?ids=a,b,c&len=N` starts the split and streams every participant's round events on
one connection. Each event carries `segmentStart`/`segmentLength` alongside the usual fields, so a
client can translate a participant's own local `i`/`j` into the whole array's global coordinates
(`globalIndex = localIndex + segmentStart`) — useful because, unlike race's genuinely independent
full-length arrays, partition's segments never overlap and can legitimately be drawn into one
shared picture at fixed offsets.

The final summary reports `wholeArraySorted`, and it is usually `false` even when every
segment finished perfectly: splitting by position is not the same as splitting by value range, and
concatenating locally-sorted slices only yields a globally sorted array when each slice already
happened to hold the right value range (real parallel/external sorts need a merge phase afterward,
which this deliberately does not implement — the point here is watching segments sort
concurrently, not shipping a working parallel sort). `perParticipant` reports each segment's own
`finishedCorrectly`/`roundsUsed`/`comparisons`/`swaps`/`faults`, same fields the other modes use.

## How a handler decides its moves — the contract says nothing about this, on purpose

Nothing above constrains *how* a handler arrives at its move — that's deliberate, and it's the
actual subject of this arena, not an implementation detail. Two shapes both satisfy this contract
equally well:

- **A live decision per round**: the handler calls a model fresh every invocation and asks it to
  decide the move on the spot. Simple to build, but every round pays a real model-call latency,
  and a subtle spec gap can produce a different wrong answer on every call.
- **Generated code, run per round**: the handler is a small program, written once (typically by a
  model, from a strategy spec), that decides the move deterministically. Every round after that
  is milliseconds, not seconds, and the same input always produces the same output — which means
  it can actually be verified before it ever competes, not just watched and hoped about live.

This repo's own participants moved from the first shape to the second — see the
[`sort-arena-harness` skill](https://github.com/scimbe/CADS-DEMO-sort/blob/main/.claude/skills/sort-arena-harness/SKILL.md)
and the docs site's ["Why generate code, not live decisions"](https://scimbe.github.io/CADS-DEMO-sort-docs/explanation/why-generate-not-decide/)
for the real evidence behind that move. The wire protocol above didn't need to change either way.

## Talking to a role over Agent-Fabric — inherited, not reinvented

This protocol only defines the JSON on stdin/stdout. *Getting* that stdin/stdout pair from a
real participant process, over a real Agent-Fabric channel, uses the exact same mechanism
CADS-flappy-demo and CADS-cookbook-demo already use — `CT_AGENT_SERVICE_HANDLER_CMD` /
`CT_AGENT_SERVICES=text_generation`, documented in CADS-Tunnel's `docs/agent-onboarding.md`.
Nothing new is invented at that layer; see `docs/onboarding.md` in this repo for the
sort-arena-specific version of that walkthrough.
