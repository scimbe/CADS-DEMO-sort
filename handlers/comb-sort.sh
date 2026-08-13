#!/usr/bin/env bash
# comb-sort.sh — plain, non-LLM comb-sort participant (CADS-DEMO-sort-docs "Non-adjacent swaps"
# tutorial's own worked example, CADS-DEMO-sort#22).
#
# Ships the real artifact that tutorial was missing: it was validated by hand-writing this exact
# logic in a scratch checkout and running it through dryrun.py, but the file itself was never
# committed here -- a reader following the tutorial had nothing to copy. This is that file.
#
# Real comb sort: compare pairs a shrinking `gap` apart instead of only adjacent pairs, so a
# single swap can fix a violation between far-apart positions in one round instead of walking a
# value there one adjacent step at a time. Deterministic, stateless-per-invocation (this process
# is invoked fresh per round, per docs/protocol.md), no LLM call.
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout.
set -euo pipefail

# Windows ships `python`/`py`, not `python3` -- and `command -v python3` is NOT enough to detect
# that (CADS-DEMO-sort-docs#1): a real, executable Microsoft Store alias stub named `python3`
# sits on PATH in every default Windows install, so `command -v` finds it and reports success --
# it only fails once you actually RUN it. Probe by execution, not presence.
PY=""
for c in python3 python py; do
  if "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "comb-sort: no working python3/python/py found on PATH" >&2; exit 1; }

if [ "${1:-}" = "--selftest" ]; then
  out="$(printf '%s' '{"round":1,"array":[3,1,2],"history":[],"budgetRemaining":10,"mode":"solo","you":"comb-sort"}' | "$0")"
  echo "$out" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m["action"] in ("compare","swap","done"), m' \
    || { echo "SELFTEST FAIL: comb-sort did not emit a valid move" >&2; exit 1; }
  echo "SELFTEST OK: comb-sort emits a valid move for a real round input"
  exit 0
fi

INPUT="$(cat)"

"$PY" - "$INPUT" <<'PY'
import json, sys

SHRINK = 1.3


def initial_gap(n):
    return max(1, int(n / SHRINK))


data = json.loads(sys.argv[1])
array = data["array"]
n = len(array)
history = data.get("history", [])

# Recover the current gap from the MOST RECENT history entry, of EITHER type -- not just the
# last swap. A fault/correction never appends to history, so a retry correctly re-reads whatever
# gap was already in play. An earlier version only looked at the last swap: a round that probed a
# clean gap (no violation -> emit `compare`, not `swap`) left nothing in history to recover that
# gap from, so the next round fell back to the initial-gap formula and re-probed the exact same
# gap forever. Confirmed as a real infinite loop via dryrun.py on 4 of 5 random len=12 seeds
# before this fix -- see CADS-DEMO-sort-docs' "Non-adjacent swaps" tutorial for the full story.
last = history[-1] if history else None
gap = abs(last["j"] - last["i"]) if last is not None else initial_gap(n)

violation = None
for i in range(n - gap):
    if array[i] > array[i + gap]:
        violation = i
        break

if violation is not None:
    print(json.dumps({"action": "swap", "i": violation, "j": violation + gap}))
    sys.exit(0)

# Current gap is clean. At gap=1, "no adjacent violation" IS the definition of sorted -- no
# separate finished-but-not-actually-sorted case to handle.
if gap == 1:
    print(json.dumps({"action": "done"}))
    sys.exit(0)

# Shrink and probe the new gap with a `compare` (free per docs/protocol.md) at its own first
# pair, so THIS move's i/j is what the next round's gap-recovery above reads back, whether or not
# a violation is actually there. That's the fix: the gap now always survives into history via the
# move that probed it, never silently dropped.
next_gap = max(1, int(gap / SHRINK))
print(json.dumps({"action": "compare", "i": 0, "j": next_gap}))
PY
