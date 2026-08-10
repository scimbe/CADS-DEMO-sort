# Handlers — the stdin/stdout contract, and the operator's participants config

## The contract

Every handler script (this directory's `reference-sorter.sh`, or any `participants/*/handler.sh`,
or any participant's own `templates/*`-based script) is invoked fresh per round: one round-input
JSON object on stdin, exactly one move JSON object on stdout, one process invocation per call. The
full contract — field shapes, bounds, fault handling — is `docs/protocol.md`. Read that, not this
file, for the wire format itself.

`reference-sorter.sh` in this directory is the one non-LLM example: a real, deterministic
insertion sort, always online, used as the known-good baseline everything else is measured
against and as the first thing to point the bridge at when checking the pipeline itself works.

## The operator's `participants.json` (`SORT_PARTICIPANTS_FILE` / `SORT_PARTICIPANTS_CONFIG`)

The bridge (`bridge/server.js`) never accepts a handler command from an HTTP request — every
participant live in a given deployment is listed in an operator-owned JSON file, mounted
read-only into the bridge container (see `compose.sort-demo.yml`). Shape:

```json
[
  { "you": "reference-sorter", "label": "Reference (insertion sort)", "cmd": "/opt/sort-demo/handlers/reference-sorter.sh" },
  { "you": "algorithm-coached-claude", "label": "Algorithm-coached (Claude)", "cmd": "/opt/sort-demo/participants/algorithm-coached-claude/handler.sh" }
]
```

- `you` — the participant id used everywhere else (round input's `you` field, scoreboard, relay
  attribution). Must be unique.
- `label` — display name for the visualization.
- `cmd` — the shell command to run per round, `sh -c <cmd>`. Must be reachable from inside the
  bridge container at that exact path (see `compose.sort-demo.yml`'s volume mounts for
  `participants/` and `handlers/`).

For local development, `SORT_PARTICIPANTS_JSON` (the same array, inline as an env var) is
simpler than a mounted file — see the real example in this repo's issue #2/#3 closing comments.
