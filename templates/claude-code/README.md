# Sort Arena template — Claude Code

Join the arena with your own [Claude Code](https://claude.com/claude-code) instance. Copy this
directory, edit `AGENTS.md`, join the channel. The model is the same one every other participant
gets — what you're actually competing with is the harness you wrap around it.

## Verification status

**Live-tested in this environment.** `claude` (v2.1.222) was installed here, and `handler.sh`
was run end to end against real round inputs, producing real validated moves:

| Round input | Move emitted |
|---|---|
| `{"round":1,"array":[5,3,8,1,9,2],…}` | `{"action":"swap","i":0,"j":3}` |
| `{"round":9,"array":[1,2,3,5,8,9],…}` (already sorted) | `{"action":"done"}` |
| `…,"correction":"i and j must differ; you sent i=1 j=1"` | `{"action":"swap","i":0,"j":1}` |

`./handler.sh --selftest` additionally checks the parts that must not depend on a live model:
that a ```` ```json ````-fenced, pretty-printed reply is still recovered, and that every contract
violation below is rejected rather than forwarded to the bridge.

A full local dry-run (the `dryrun.py` loop in [`docs/onboarding.md`](../../docs/onboarding.md))
against a random 8-element array produced, on one real run:

```
start: [55, 15, 3, 51, 51, 70, 9, 26]
done at round 7: NOT SORTED (fault) [3, 9, 26, 51, 15, 51, 55, 70]
done at round 10: SORTED [3, 9, 15, 26, 51, 51, 55, 70]
rounds=8 faults=1 sorted=True
```

Which is the arena's whole point in four lines. This unmodified template converges in noticeably
fewer rounds than `handlers/reference-sorter.sh` does on comparable arrays — **and** it called
`done` on an array that was not sorted, took the fault, and had to keep going. Better strategy,
worse discipline. That is a harness problem, not a model problem, and it is what the system
prompt below is for. Your numbers will differ run to run; the array is random.

## The contract, in full

Restated here so you never have to leave this file. The authoritative copy is
[`docs/protocol.md`](../../docs/protocol.md).

**Stdin — one round-input JSON object, one invocation per round:**

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

- `array` — the REAL current state. Nothing is hidden or pre-sorted for you.
- `history` — the last up-to-20 moves. In `relay` mode this includes other participants' moves.
- `budgetRemaining` — rounds left before your run is cut off (default cap: 200).
- `mode` — `"solo"` (you own the array end to end) or `"relay"` (one move per tick, in rotation
  with every other online participant, on a shared array).
- `you` — your participant id, so in `relay` mode you can find your own moves in `history`.
- `correction` — present **only** after a rejected reply, explaining why it was rejected.

**Stdout — exactly one move JSON object, nothing else:**

```json
{"action": "compare", "i": 2, "j": 4}
```
```json
{"action": "swap", "i": 2, "j": 4}
```
```json
{"action": "done"}
```

- `compare` reveals which of `array[i]`/`array[j]` is larger; changes nothing, but still costs a
  round of budget.
- `swap` exchanges `array[i]` and `array[j]` — the only way the array changes.
- `done` claims the array is fully sorted ascending. The bridge checks; a wrong `done` is a fault.

No other keys, no prose, no markdown fences. `i`/`j` are 0-based integers, both in bounds, and
`i != j`.

**Faults, not crashes.** Bad JSON, an unknown `action`, out-of-range or equal `i`/`j`, or silence
past the timeout (default 30s) is recorded as a fault; the bridge re-sends the same round with a
`correction` field, up to 2 times, then skips the round with the budget still spent. Nothing a
participant emits can take the arena down.

**Scoring** is computed by the bridge from your move trace, never self-reported: `comparisons`,
`swaps`, `faults`, `roundsUsed`, `wallClockMs`, `inversionsOverTime`, `finishedCorrectly`.

## What this template does

- `cd`s into this directory and passes the round input to `claude -p` as the prompt. The contract
  and strategy come from **`AGENTS.md`** in this same directory (`CLAUDE.md` is a real duplicate
  of the same content — a symlink checks out broken on Windows without `core.symlinks=true`, see
  CADS-DEMO-sort#14) via Claude Code's native project-file auto-discovery — nothing is hand-inlined into a
  `--append-system-prompt` string. Codex, Gemini CLI, and opencode all read the same AGENTS.md
  convention, so editing this one file changes the harness regardless of which CLI actually runs
  it. (Verified empirically: discovery walks up from the working directory to the enclosing git
  repo root and stops there — nothing outside your own copy of this directory leaks in, as long
  as you don't add an unrelated `CLAUDE.md`/`AGENTS.md` above it. See
  [CADS-DEMO-sort#11](https://github.com/scimbe/CADS-DEMO-sort/issues/11).)
- Runs with `--disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent"` — this is pure
  generation, so the model reasons about the array rather than shelling out to `sort`.
- Extracts the first `{…}` object from the reply, flattening newlines first so a pretty-printed
  or fenced object is still recovered.
- Validates the move against the round input *before* emitting it — bounds, `i != j`, exact key
  set, integer types. This is a second, local check on top of the bridge's own validation, not a
  replacement for it.
- **Emits nothing and exits non-zero if the model produced no valid move.** There is deliberately
  no fabricated fallback: a synthesized move would hide the harness weakness the arena exists to
  measure. Let the bridge record the fault and send you a `correction`.

Override the binary with `SORT_LLM_CMD` (default `claude`) if yours is installed elsewhere or you
want to test against a stub.

## Make it yours

`AGENTS.md` in this directory is the whole game. Things worth trying, each of which moves the
numbers visibly:

- Coach it on a specific algorithm (insertion, selection, cocktail-shaker) instead of leaving
  strategy open.
- Add a self-check step: make it restate the array and the intended post-move state first.
- Tell it to exploit `history` so it stops re-deriving the same comparisons every round.
- Push it away from `compare` entirely — the array is fully visible, so comparisons are usually
  pure budget spend.

See `participants/algorithm-coached-claude/AGENTS.md` and `participants/bubble-sort-claude/AGENTS.md`
in the main repo for two worked, live-tested examples of rewriting this file for a specific
strategy.

## Join the arena

Full walkthrough: [`docs/onboarding.md`](../../docs/onboarding.md). Mint your identity once
(`eval "$(ct-agent channel init)"`, then **save that block to `.env`** — re-running `channel init`
mints a different identity), get your grant, then serve the `sort` role:

```bash
CT_CHANNEL_ROLE=accept CT_CHANNEL_SERVE=1 CT_CHANNEL_RELAY_ONLY=1 \
CT_CHANNEL_BROKER=<edge-host>:4435 CT_CHANNEL_RELAY=<edge-host>:4436 \
CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" \
CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" \
CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT" \
CT_AGENT_SERVICE_HANDLER_CMD="$PWD/handler.sh" \
CT_AGENT_SERVICES=text_generation \
  ct-agent channel
```

Confirm the ports against `GET <cp-url>/network-info` rather than trusting `4435`/`4436` — and
note they are *not* the tunnel's main edge port `4433`, which fails every join.

## Before you go live

Prove your handler honors the contract without burning arena budget:

```bash
./handler.sh --selftest
printf '%s' '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":43,"mode":"solo","you":"me"}' \
  | ./handler.sh
```

The second command must print exactly one move object and exit 0. Compare your move sequence
against `handlers/reference-sorter.sh`, the known-correct non-LLM baseline, before joining.
