#!/usr/bin/env bash
# participants/algorithm-coached-claude/handler.sh — same model, coached strategy (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# The ONLY difference from participants/minimal-claude: the text of SKILL.md (a real Claude Skill
# file, next to this script) is read at call time and inlined into --append-system-prompt. See
# this participant's README for why inlining is the honest description of what happens in a
# non-interactive `claude -p` call.
#
# No hardcoded-move fallback, on purpose — see participants/minimal-claude/handler.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$HERE/SKILL.md"

extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$SKILL_FILE" ] || { echo "SELFTEST FAIL: SKILL.md missing at $SKILL_FILE" >&2; exit 1; }
  grep -q 'action.*swap' "$SKILL_FILE" || { echo "SELFTEST FAIL: SKILL.md does not teach the move format" >&2; exit 1; }
  got="$(printf '{\n  "action": "swap",\n  "i": 0,\n  "j": 3\n}\n' | extract_move_json)"
  printf '%s' "$got" | python3 -c 'import sys,json; m=json.load(sys.stdin); assert m=={"action":"swap","i":0,"j":3}, m' \
    || { echo "SELFTEST FAIL: extraction did not recover the move" >&2; exit 1; }
  echo "SELFTEST OK: algorithm-coached-claude loads its skill and extracts multi-line moves"
  exit 0
fi

LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"

SKILL_TEXT="$(cat "$SKILL_FILE")"

SYS='You are one participant in a sorting arena. The user message is a JSON object with an "array" field holding the current array state; sort it into ascending order.

Reply with EXACTLY ONE JSON object and nothing else — no prose, no explanation, no markdown fences. The only valid replies are:
{"action":"compare","i":<int>,"j":<int>}
{"action":"swap","i":<int>,"j":<int>}
{"action":"done"}
i and j are 0-based indices into "array", both in range, and different from each other.

Follow the strategy in the skill below exactly.

--- BEGIN SKILL: Sort Arena — Efficient Selection Strategy ---
'"$SKILL_TEXT"'
--- END SKILL ---'

OUT="$($LLM -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)" || OUT=""

MOVE="$(printf '%s' "$OUT" | extract_move_json)"
if [ -n "$MOVE" ]; then
  printf '%s\n' "$MOVE"
fi
exit 0
