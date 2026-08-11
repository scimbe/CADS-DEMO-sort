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

# Windows ships `python`/`py`, not `python3` -- and `command -v python3` is NOT enough to detect
# that (CADS-DEMO-sort-docs#1, second round): a real, executable Microsoft Store alias stub named
# `python3` sits on PATH in every default Windows install, so `command -v` finds it and reports
# success -- it only fails once you actually RUN it. Probe by execution, not presence.
PY=""
for c in python3 python py; do
  if "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "reference-sorter: no working python3/python/py found on PATH" >&2; exit 1; }

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
