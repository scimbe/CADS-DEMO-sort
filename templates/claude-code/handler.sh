#!/usr/bin/env bash
# templates/claude-code/handler.sh — Sort Arena participant driven by Claude Code.
#
# Contract (docs/protocol.md): ONE round-input JSON object on stdin -> EXACTLY ONE move JSON
# object on stdout. One invocation per round; this process holds no state between rounds.
#
# Copy this whole directory, edit AGENTS.md (that's the harness you're actually competing with —
# the model is the same for everyone), point CT_AGENT_SERVICE_HANDLER_CMD at it. See the README
# next to this file for the join command.
#
# Context comes from AGENTS.md in this same directory (CLAUDE.md is a symlink to it) via Claude
# Code's native project-file auto-discovery — `cd` here, no hand-built --append-system-prompt
# string. Codex, Gemini CLI, and opencode read the same AGENTS.md convention, so this file is the
# one thing to edit regardless of which CLI you actually run.
set -uo pipefail

# Windows ships `python`/`py`, not `python3` -- `python3` there is a Microsoft Store alias stub
# that does nothing useful (CADS-DEMO-sort-docs#1). Resolve once, fail clearly if neither exists.
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "handler: no python3 or python found on PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The LLM output is not guaranteed to be a bare object: models fence it in ```json, pretty-print
# it across lines, or prepend a sentence. Flatten newlines FIRST — grep is line-oriented, so a
# multi-line object would otherwise match nothing on every individual line.
extract_json_object() { tr -d '\n' | grep -o '{[^}]*}' | head -1; }

# Reject anything the bridge would reject, before it reaches the bridge. Takes the candidate move
# as $1 and the round input as $2 — both as ARGUMENTS, not on stdin, because `"$PY" -` reads the
# script itself from stdin. Prints the move on success, exits 1 on any violation.
validate_move() {
  "$PY" - "$1" "$2" <<'PY'
import json, sys

try:
    move = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
if not isinstance(move, dict):
    sys.exit(1)

n = len(json.loads(sys.argv[2])["array"])
action = move.get("action")

if action == "done":
    if set(move) != {"action"}:
        sys.exit(1)
elif action in ("compare", "swap"):
    if set(move) != {"action", "i", "j"}:
        sys.exit(1)
    i, j = move["i"], move["j"]
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (i, j)):
        sys.exit(1)
    if i == j or not (0 <= i < n) or not (0 <= j < n):
        sys.exit(1)
else:
    sys.exit(1)

print(json.dumps(move, separators=(",", ":")))
PY
}

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$HERE/AGENTS.md" ] || { echo "SELFTEST FAIL: AGENTS.md missing at $HERE" >&2; exit 1; }
  [ -L "$HERE/CLAUDE.md" ] || { echo "SELFTEST FAIL: CLAUDE.md is not the expected AGENTS.md symlink at $HERE" >&2; exit 1; }
  round='{"round":1,"array":[5,3,8,1],"history":[],"budgetRemaining":10,"mode":"solo","you":"t"}'
  fenced='```json
{
  "action": "swap",
  "i": 0,
  "j": 1
}
```'
  got="$(validate_move "$(printf '%s' "$fenced" | extract_json_object)" "$round")" \
    || { echo "SELFTEST FAIL: fenced multi-line move was not recovered and validated" >&2; exit 1; }
  [ "$got" = '{"action":"swap","i":0,"j":1}' ] \
    || { echo "SELFTEST FAIL: unexpected extraction result: $got" >&2; exit 1; }
  for bad in '{"action":"swap","i":0,"j":0}' '{"action":"swap","i":0,"j":9}' \
             '{"action":"sort","i":0,"j":1}' '{"action":"done","i":0}' '{"action":"swap","i":0}' \
             '{"action":"swap","i":0,"j":true}' 'not json at all' ''; do
    if validate_move "$bad" "$round" >/dev/null 2>&1; then
      echo "SELFTEST FAIL: validator accepted an invalid move: $bad" >&2; exit 1
    fi
  done
  echo "SELFTEST OK: fenced/multi-line moves are recovered, and every contract violation is rejected"
  exit 0
fi

LLM="${SORT_LLM_CMD:-claude}"
INPUT="$(cat)"

OUT="$(cd "$HERE" && "$LLM" -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" 2>/dev/null)" || OUT=""

# Deliberately NO fabricated fallback move. If the model produced nothing usable, staying silent
# lets the bridge record a real fault and re-send the round with a "correction" (docs/protocol.md).
# Inventing a plausible move here would hide exactly the harness weakness the arena exists to show.
validate_move "$(printf '%s' "$OUT" | extract_json_object)" "$INPUT" || exit 1
