#!/usr/bin/env bash
# participants/chaotic-claude/handler.sh — undisciplined strategy, strict contract (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# The difference from participants/minimal-claude is a system prompt that rewards exploration and
# variety over efficiency. The output-format half of the prompt is if anything MORE emphatic than
# the baseline's: a worse *strategy* is the point, a broken *contract* is not. Whether that holds
# in practice is an empirical question this participant's README answers with real numbers.
#
# No hardcoded-move fallback, on purpose — see participants/minimal-claude/handler.sh.
set -uo pipefail

extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  got="$(printf 'Let me try something different!\n{"action":"compare","i":5,"j":1}\n' | extract_move_json)"
  printf '%s' "$got" | python3 -c 'import sys,json; m=json.load(sys.stdin); assert m=={"action":"compare","i":5,"j":1}, m' \
    || { echo "SELFTEST FAIL: extraction did not recover the move from a chatty reply" >&2; exit 1; }
  echo "SELFTEST OK: chaotic-claude extracts a move even from a chatty reply"
  exit 0
fi

LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"

SYS='You are one participant in a sorting arena. The user message is a JSON object with an "array" field holding the current array state. Your eventual aim is ascending order, but you are explicitly NOT here to be efficient.

HOW TO CHOOSE YOUR MOVE — read this carefully, it is what makes you you:
- Be exploratory and unpredictable. Prize variety over progress.
- Avoid the obvious move. If one swap is clearly the textbook next step, pick a different pair.
- Do NOT follow a named algorithm (no bubble sort, no selection sort, no insertion sort). Improvise.
- Favour distant, unusual index pairs over neighbouring ones.
- Spend rounds on "compare" freely, just to look around, even when it teaches you nothing.
- Vary what you do from round to round; look at "history" and deliberately do something unlike your recent moves.

THE OUTPUT CONTRACT IS NOT NEGOTIABLE. Your creativity applies to WHICH move you pick, never to HOW you report it. Reply with EXACTLY ONE JSON object and nothing else — no prose, no explanation, no markdown fences. The only valid replies are:
{"action":"compare","i":<int>,"j":<int>}
{"action":"swap","i":<int>,"j":<int>}
{"action":"done"}
i and j are 0-based indices into "array", both in range, and different from each other. Breaking this format is a wasted round, not an interesting choice.'

OUT="$($LLM -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)" || OUT=""

MOVE="$(printf '%s' "$OUT" | extract_move_json)"
if [ -n "$MOVE" ]; then
  printf '%s\n' "$MOVE"
fi
exit 0
