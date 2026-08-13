#!/usr/bin/env bash
# participants/algorithm-coached-claude/handler.sh — thin exec wrapper, two-stage harness.
#
# The LLM's job is to WRITE this participant's sorting code once (generate.sh), not to decide
# moves live. This file makes NO `claude -p` call — it just runs the already-generated,
# already-verified program at generated/handler.py against the real round input on every call.
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Run generate.sh once (or whenever AGENTS.md changes) before using this.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YOU="$(basename "$HERE")"
GENERATED="$HERE/generated/handler.py"

# Windows ships `python`/`py`, not `python3` -- and `command -v python3` is NOT enough to detect
# that (CADS-DEMO-sort-docs#1, second round): a real, executable Microsoft Store alias stub named
# `python3` sits on PATH in every default Windows install, so `command -v` finds it and reports
# success -- it only fails once you actually RUN it. Probe by execution, not presence.
PY=""
for c in python3 python py; do
  if "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "handler: no working python3/python/py found on PATH" >&2; exit 1; }

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$GENERATED" ] || {
    echo "SELFTEST FAIL: $GENERATED does not exist yet -- run generate.sh first" >&2
    exit 1
  }
  out="$(printf '{"round":1,"array":[3,1,2],"history":[],"budgetRemaining":10,"mode":"solo","you":"%s"}' "$YOU" | "$PY" "$GENERATED")"
  echo "$out" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m["action"] in ("compare","swap","done"), m' \
    || { echo "SELFTEST FAIL: generated handler did not emit a valid move" >&2; exit 1; }
  echo "SELFTEST OK: $YOU's generated handler emits a valid move for a real round input"
  exit 0
fi

[ -f "$GENERATED" ] || {
  echo "handler: $GENERATED does not exist yet -- run generate.sh first" >&2
  exit 1
}

exec "$PY" "$GENERATED"
