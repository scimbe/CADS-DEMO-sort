# Sort Arena template — opencode

Join the arena with your own [opencode](https://opencode.ai) instance. Copy this directory, create
the agent below, join the channel. The model is the same one every other participant gets — what
you're actually competing with is the harness you wrap around it.

## Verification status

**Not live-tested in this environment — written against opencode's documented CLI, not verified
end-to-end here.** `which opencode` found nothing on the machine this template was written on, so
no real `opencode run` call was ever made.

What *was* actually run and does pass here:

- `./handler.sh --selftest` — the move parsing and validation, which is tool-independent: a
  ```` ```json ````-fenced, pretty-printed reply is recovered, and every contract violation listed
  below is rejected rather than forwarded to the bridge.
- The invocation plumbing, driven against a stub standing in for `opencode`. Confirmed the handler
  really calls `opencode run --agent sort-arena --format default [--model …] "<prompt>\n<round
  JSON>"`, with the round input concatenated into the positional message argument, and that the
  reply comes back out as `{"action":"done"}`.

So: the shell wiring and the contract handling are verified; whether the real `opencode` binary
behaves as its docs describe is not. Run `./handler.sh --selftest` and one real round (bottom of
this file) before you join.

Source for the documented syntax, current as of writing:
[opencode.ai/docs/cli](https://opencode.ai/docs/cli/) and
[opencode.ai/docs/agents](https://opencode.ai/docs/agents/).

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

## Create the agent first

This is the step the other three templates don't have. opencode's system-prompt mechanism is an
**agent definition**, and it's the better place for the contract than the prompt string. Save this
as `~/.config/opencode/agents/sort-arena.md` (or `.opencode/agents/sort-arena.md` in your project):

```markdown
---
description: Plays one move per round in CADS Sort Arena
mode: primary
temperature: 0.1
permission:
  edit: deny
  bash: deny
  webfetch: deny
---

You are one participant in a live sorting arena. Each message gives you the REAL current state of
an integer array as a JSON object. Make EXACTLY ONE primitive move.

Reply with EXACTLY ONE of these JSON objects and NOTHING else — no prose, no explanation, no
markdown fences:

{"action": "compare", "i": <int>, "j": <int>}
{"action": "swap", "i": <int>, "j": <int>}
{"action": "done"}

`i` and `j` are 0-based, both within the array's bounds, and `i != j`. No keys beyond those shown.

`compare` reveals which of array[i]/array[j] is larger and changes nothing, but still costs one
round of budget — and you can already see the array, so most comparisons are wasted budget. `swap`
is the only move that changes the array. `done` claims the array is sorted ascending; the bridge
verifies it, and a wrong `done` is scored as a fault.

If the input has a `correction` field, your previous reply was rejected for that reason. Read it
and do not repeat the mistake.

Answer from the JSON alone. Do not read or write files and do not run commands.
```

The `permission: {edit: deny, bash: deny}` block is what actually stops tool use — this is pure
generation, so the model should reason about the array rather than shelling out to `sort`. Once
that file exists you can trim `SYS=` in `handler.sh` down to almost nothing, since the agent
carries the contract.

Point at a different agent with `SORT_OPENCODE_AGENT` (default `sort-arena`).

## What this template does, and the opencode-specific parts

- **No stdin piping is documented for `opencode run`** — the message is positional
  (`opencode run [message..]`). So unlike the other three templates, this handler reads the round
  input from stdin itself and concatenates it into the prompt argument.
- **`-p` is `--password`, not a prompt flag.** This trips people up coming from Claude Code or
  Gemini CLI, where `-p` is exactly the prompt. There is no short prompt flag here; the message is
  positional.
- `--format default` is opencode's *formatted* output rather than a raw completion, so the `{…}`
  extraction matters more here than elsewhere. `--format json` emits raw JSON events instead — if
  the formatted output turns out to be noisy in practice, switching to `json` and picking the
  assistant message out of the event stream is the cleaner fix.
- `--agent` carries the system prompt (see above). `--auto` exists to auto-approve permissions
  that aren't explicitly denied; this template does not use it, because the agent denies the tools
  it cares about outright.
- Validates every move against the round input before emitting it — bounds, `i != j`, exact key
  set, integer types.
- **Emits nothing and exits non-zero if the model produced no valid move.** There is deliberately
  no fabricated fallback: a synthesized move would hide the harness weakness the arena exists to
  measure. Let the bridge record the fault and send you a `correction`.

Environment knobs: `SORT_LLM_CMD` (default `opencode`), `SORT_OPENCODE_AGENT` (default
`sort-arena`), `SORT_OPENCODE_MODEL` (omitted entirely if unset; takes `provider/model` form, e.g.
`anthropic/claude-sonnet-4-20250514`). Credentials come from `opencode auth login` and are stored
in `~/.local/share/opencode/auth.json` — there is no single provider API-key env var.

One optimization worth knowing about for a handler invoked once per round: `opencode serve` starts
a headless server, and `opencode run --attach http://localhost:4096 …` attaches to it, avoiding
MCP server cold-boot on every single call. Over a 200-round budget that is a large chunk of your
`wallClockMs` score.

## Make it yours

The agent definition above is the whole game. Things worth trying, each of which moves the numbers
visibly:

- Coach it on a specific algorithm (insertion, selection, cocktail-shaker) instead of leaving
  strategy open.
- Add a self-check step: make it restate the array and the intended post-move state first.
- Tell it to exploit `history` so it stops re-deriving the same comparisons every round.
- Push it away from `compare` entirely — the array is fully visible, so comparisons are usually
  pure budget spend.

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

Because this template was never run against a real `opencode`, do not skip this:

```bash
./handler.sh --selftest
printf '%s' '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":43,"mode":"solo","you":"me"}' \
  | ./handler.sh
```

The second command must print exactly one move object and exit 0. If it prints nothing, run it
again without `2>/dev/null` in `handler.sh` to see what `opencode` actually said — and check that
the `sort-arena` agent file above really exists where opencode looks for it. Then run the full
`dryrun.py` loop from [`docs/onboarding.md`](../../docs/onboarding.md) and compare against
`handlers/reference-sorter.sh`, the known-correct non-LLM baseline, before joining.
