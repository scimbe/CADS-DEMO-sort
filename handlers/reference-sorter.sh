#!/usr/bin/env bash
# reference-sorter.sh — plain, non-LLM reference participant (CADS-DEMO-sort#5).
#
# Real insertion sort, one comparison or swap per invocation, strictly conforming to
# docs/protocol.md. Always online, always correct, always the same every run — the known-good
# baseline every LLM-driven participant is measured against, and the first thing to point the
# bridge at when checking that the pipeline itself works before any model is involved.
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout.
# Strategy: classic insertion sort expressed as compare-then-maybe-swap over adjacent pairs
# scanned from the front each round (deliberately simple and stateless between calls — this
# process is invoked fresh per round, per docs/protocol.md's "one invocation per call").
set -euo pipefail

# Windows ships `python` (or the `py` launcher), not `python3` -- `python3` there is a Microsoft
# Store alias stub that does nothing useful (CADS-DEMO-sort-docs#1). Resolve once, fail clearly
# if neither exists, rather than let a bare `python3: command not found` be the only signal.
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "reference-sorter: no python3 or python found on PATH" >&2; exit 1; }

if [ "${1:-}" = "--selftest" ]; then
  out="$(printf '%s' '{"round":1,"array":[3,1,2],"history":[],"budgetRemaining":10,"mode":"solo","you":"reference-sorter"}' | "$0")"
  echo "$out" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m["action"] in ("compare","swap","done"), m' \
    || { echo "SELFTEST FAIL: reference-sorter did not emit a valid move" >&2; exit 1; }
  echo "SELFTEST OK: reference-sorter emits a valid move for a real round input"
  exit 0
fi

INPUT="$(cat)"

"$PY" - "$INPUT" <<'PY'
import json, sys

data = json.loads(sys.argv[1])
array = data["array"]

# Find the first adjacent out-of-order pair, scanning from the front. This is a real,
# recognizable insertion-sort-shaped pass: each round fixes exactly one inversion nearest the
# start, so the trace is a clean, legible bubble toward sortedness (a deliberately simple and
# EXPLAINABLE baseline, not the fastest possible strategy).
for idx in range(len(array) - 1):
    if array[idx] > array[idx + 1]:
        print(json.dumps({"action": "swap", "i": idx, "j": idx + 1}))
        sys.exit(0)

print(json.dumps({"action": "done"}))
PY
