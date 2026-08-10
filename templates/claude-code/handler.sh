#!/usr/bin/env bash
# templates/claude-code/handler.sh — Sort Arena participant driven by Claude Code.
#
# Contract (docs/protocol.md): ONE round-input JSON object on stdin -> EXACTLY ONE move JSON
# object on stdout. One invocation per round; this process holds no state between rounds.
#
# Copy this whole directory, edit SYS (that's the harness you're actually competing with —
# the model is the same for everyone), point CT_AGENT_SERVICE_HANDLER_CMD at it. See the
# README next to this file for the join command.
set -uo pipefail

# The LLM output is not guaranteed to be a bare object: models fence it in ```json, pretty-print
# it across lines, or prepend a sentence. Flatten newlines FIRST — grep is line-oriented, so a
# multi-line object would otherwise match nothing on every individual line.
extract_json_object() { tr -d '\n' | grep -o '{[^}]*}' | head -1; }

# Reject anything the bridge would reject, before it reaches the bridge. Takes the candidate move
# as $1 and the round input as $2 — both as ARGUMENTS, not on stdin, because `python3 -` reads the
# script itself from stdin. Prints the move on success, exits 1 on any violation.
validate_move() {
  python3 - "$1" "$2" <<'PY'
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

SYS="You are one participant in a live sorting arena. Each call gives you the REAL current state of an integer array and you make EXACTLY ONE primitive move.

Input (one JSON object): round, array (the real current state), history (your last up-to-20 moves; in relay mode, also other participants'), budgetRemaining (rounds left before you are cut off), mode ('solo' or 'relay'), you (your participant id). If a 'correction' field is present, your PREVIOUS reply was rejected for the reason it gives — read it and do not repeat that mistake.

Reply with EXACTLY ONE of these JSON objects and NOTHING else — no prose, no explanation, no markdown fences:
{\"action\": \"compare\", \"i\": <int>, \"j\": <int>}
{\"action\": \"swap\", \"i\": <int>, \"j\": <int>}
{\"action\": \"done\"}

'compare' reveals which of array[i]/array[j] is larger and changes nothing, but still costs one round of budget. 'swap' exchanges array[i] and array[j] and is the ONLY way the array changes. 'done' claims the array is fully sorted ascending — the bridge checks, and a wrong 'done' is scored as a fault.

Rules: i and j are 0-based, both in bounds, and i != j. No keys beyond those shown. You can read the array directly, so spending rounds on 'compare' when you can already see the values wastes budget. Work toward sorted ascending in as few rounds as you can, and call 'done' the moment the array you were given is already sorted."

if [ "${1:-}" = "--selftest" ]; then
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

OUT="$($LLM -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)" || OUT=""

# Deliberately NO fabricated fallback move. If the model produced nothing usable, staying silent
# lets the bridge record a real fault and re-send the round with a "correction" (docs/protocol.md).
# Inventing a plausible move here would hide exactly the harness weakness the arena exists to show.
validate_move "$(printf '%s' "$OUT" | extract_json_object)" "$INPUT" || exit 1
