#!/usr/bin/env bash
# participants/verbose-reasoner-claude/handler.sh — explicit self-check step (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# The difference from participants/minimal-claude is a mandatory verification procedure in the
# system prompt: re-read THIS round's array, index it explicitly, re-check the chosen indices,
# and re-check any "done" claim against every adjacent pair. No strategy is taught — only the
# habit of not acting on stale or assumed state. The expected cost is wall-clock time.
#
# No hardcoded-move fallback, on purpose — see participants/minimal-claude/handler.sh.
set -uo pipefail

extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  got="$(printf 'Checked: array is [1,2,3]. Every adjacent pair is in order.\n{"action": "done"}\n' | extract_move_json)"
  printf '%s' "$got" | python3 -c 'import sys,json; m=json.load(sys.stdin); assert m=={"action":"done"}, m' \
    || { echo "SELFTEST FAIL: extraction did not recover a done move after a verification preamble" >&2; exit 1; }
  echo "SELFTEST OK: verbose-reasoner-claude extracts the move after a verification preamble"
  exit 0
fi

LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"

SYS='You are one participant in a sorting arena. The user message is a JSON object with an "array" field holding the current array state; sort it into ascending order.

BEFORE choosing a move you MUST run this verification, silently, every single round:
1. Read the "array" field of THIS round'"'"'s input, character by character. It is the only truth about the current state.
2. Write out, for yourself, each index paired with its value: index 0 holds ..., index 1 holds ..., and so on to the last index.
3. Treat "history" as a log of what happened, NEVER as a description of the array now. If a value seems familiar from an earlier round, distrust that feeling and re-read step 1. Acting on a remembered array instead of the given one is the single most likely way to lose this game.
4. Decide your move, then re-check it against your index list: are i and j both real indices of THIS array, are they different, and do they refer to the two values you actually meant?
5. If you are about to answer "done", first walk every adjacent pair k, k+1 and confirm array[k] <= array[k+1] for ALL of them. If even one fails, you are not done.
6. If the input has a "correction" field, your previous reply was rejected. Read it and do not repeat that mistake.

Then reply with EXACTLY ONE JSON object and nothing else — no prose, no explanation, no markdown fences. Keep the verification entirely internal; none of it appears in your output. The only valid replies are:
{"action":"compare","i":<int>,"j":<int>}
{"action":"swap","i":<int>,"j":<int>}
{"action":"done"}
i and j are 0-based indices into "array", both in range, and different from each other.'

OUT="$($LLM -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)" || OUT=""

MOVE="$(printf '%s' "$OUT" | extract_move_json)"
if [ -n "$MOVE" ]; then
  printf '%s\n' "$MOVE"
fi
exit 0
