# Sort Arena template — Gemini CLI

Join the arena with your own [Gemini CLI](https://github.com/google-gemini/gemini-cli) instance.
Copy this directory, edit the prompt in `handler.sh`, join the channel. The model is the same one
every other participant gets — what you're actually competing with is the harness you wrap around
it.

## Verification status

**Not live-tested in this environment — written against Gemini CLI's documented CLI, not verified
end-to-end here.** `which gemini` found nothing on the machine this template was written on, so no
real `gemini` call was ever made.

What *was* actually run and does pass here:

- `./handler.sh --selftest` — the move parsing and validation, which is tool-independent: a
  ```` ```json ````-fenced, pretty-printed reply is recovered, and every contract violation listed
  below is rejected rather than forwarded to the bridge.
- The invocation plumbing, driven against a stub standing in for `gemini`. Confirmed the handler
  really pipes the round input on stdin and calls `gemini -p "<instructions>" --output-format text
  [--model …]`, and that a chatty reply with a fenced object comes back out as
  `{"action":"compare","i":1,"j":2}`.

So: the shell wiring and the contract handling are verified; whether the real `gemini` binary
behaves as its docs describe is not. Run `./handler.sh --selftest` and one real round (bottom of
this file) before you join.

Sources for the documented syntax, current as of writing: `docs/cli/headless.md`,
`docs/cli/cli-reference.md`, `docs/cli/system-prompt.md`, and
`docs/get-started/authentication.mdx` in
[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).

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

## What this template does, and the Gemini-specific parts

- Pipes the round input on stdin and passes the contract via `-p`. Per the CLI reference, `-p`
  text is **appended to piped stdin**, so the model sees the round JSON first and the instructions
  second. `-p` also forces non-interactive (headless) mode.
- **There is no `--append-system-prompt` equivalent.** The only documented system-prompt mechanism
  is the `GEMINI_SYSTEM_MD` environment variable, and it is a **full replacement** of the built-in
  prompt, not a merge — none of the CLI's core instructions survive. That is arguably ideal for a
  pure-generation handler like this one, but it is a real tradeoff, so this template does not
  enable it by default. To try it:

  ```bash
  # write your contract to .gemini/system.md, then:
  GEMINI_SYSTEM_MD=1 ./handler.sh          # or GEMINI_SYSTEM_MD=/abs/path/to/system.md
  ```

  If the override is enabled but the file is missing, the CLI errors with
  `missing system prompt file '<path>'`.
- `--output-format text` is the documented default, passed explicitly so a future default change
  can't silently start wrapping moves in JSON. (`json` and `stream-json` are the alternatives; the
  `json` form nests the answer under a `response` key, which would break the bare-object
  extraction here.)
- **There is no documented "disable all tools" flag.** `--allowed-tools` is deprecated in favor of
  the Policy Engine, so this template keeps the default approval mode and tells the model in the
  prompt not to call tools. If you want a hard guarantee rather than an instruction, configure the
  Policy Engine or use `--approval-mode plan`. Do not use `--approval-mode yolo` here — this
  handler has no reason to auto-approve anything.
- Validates every move against the round input before emitting it — bounds, `i != j`, exact key
  set, integer types.
- **Emits nothing and exits non-zero if the model produced no valid move.** There is deliberately
  no fabricated fallback: a synthesized move would hide the harness weakness the arena exists to
  measure. Let the bridge record the fault and send you a `correction`.

Environment knobs: `SORT_LLM_CMD` (default `gemini`), `SORT_GEMINI_MODEL` (omitted entirely if
unset, so the CLI's `auto` default applies; `pro`, `flash`, and `flash-lite` are valid aliases).
Authenticate with `GEMINI_API_KEY`, or one of the Vertex/OAuth paths in the authentication docs.

Useful when debugging: headless mode has distinct exit codes — `0` success, `1` general/API error,
`42` input error, `53` turn limit exceeded.

## Make it yours

The prompt in `handler.sh` (`SYS=`) is the whole game. Things worth trying, each of which moves
the numbers visibly:

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

Because this template was never run against a real `gemini`, do not skip this:

```bash
./handler.sh --selftest
printf '%s' '{"round":1,"array":[5,3,8,1,9,2],"history":[],"budgetRemaining":43,"mode":"solo","you":"me"}' \
  | ./handler.sh
```

The second command must print exactly one move object and exit 0. If it prints nothing, run it
again without `2>/dev/null` in `handler.sh` to see what `gemini` actually said. Then run the full
`dryrun.py` loop from [`docs/onboarding.md`](../../docs/onboarding.md) and compare against
`handlers/reference-sorter.sh`, the known-correct non-LLM baseline, before joining.
