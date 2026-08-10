#!/usr/bin/env bash
# participants/minimal-claude/handler.sh — the "just ask the model" baseline (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# What is deliberately ABSENT here: any strategy coaching, any skill, any self-check step. The
# system prompt states the output format and the goal, nothing more. That absence is the whole
# point — everything the other three participants add is measured against this.
#
# On a reply we cannot extract a move from we print NOTHING and exit 0. That is a real fault the
# bridge records and shows (docs/protocol.md "Validation and faults"). We deliberately do NOT
# fall back to a hardcoded move the way CADS-flappy-demo's physics-handler falls back to default
# physics: a hidden fallback would launder a harness failure into a plausible-looking move and
# destroy the only honest signal this demo has.
set -uo pipefail

# Flatten newlines first — `grep` is line-oriented, so a pretty-printed or ```json-fenced object
# (which the model emits often enough to matter) matches nothing line-by-line. Prefer the LAST
# object that mentions "action", so an echoed example in a preamble never wins over the answer.
extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  sample='Sure, here is my move:
```json
{
  "action": "swap",
  "i": 2,
  "j": 4
}
```'
  got="$(printf '%s' "$sample" | extract_move_json)"
  [ -n "$got" ] || { echo "SELFTEST FAIL: fenced multi-line move yielded an EMPTY match" >&2; exit 1; }
  printf '%s' "$got" | python3 -c 'import sys,json; m=json.load(sys.stdin); assert m["action"]=="swap" and m["i"]==2 and m["j"]==4, m' \
    || { echo "SELFTEST FAIL: extracted text is not the expected move" >&2; exit 1; }
  noise="$(printf 'I think the array is fine.' | extract_move_json)"
  [ -z "$noise" ] || { echo "SELFTEST FAIL: prose-only reply must extract to NOTHING (a real fault), got: $noise" >&2; exit 1; }
  echo "SELFTEST OK: minimal-claude extracts fenced moves and reports prose-only replies as faults"
  exit 0
fi

LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"

SYS='You are one participant in a sorting arena. The user message is a JSON object with an "array" field holding the current array state; sort it into ascending order.

Reply with EXACTLY ONE JSON object and nothing else — no prose, no explanation, no markdown fences. The only valid replies are:
{"action":"compare","i":<int>,"j":<int>}
{"action":"swap","i":<int>,"j":<int>}
{"action":"done"}
i and j are 0-based indices into "array", both in range, and different from each other. "swap" exchanges the two elements. "compare" changes nothing. "done" claims the array is already fully sorted ascending.'

OUT="$($LLM -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)" || OUT=""

MOVE="$(printf '%s' "$OUT" | extract_move_json)"
if [ -n "$MOVE" ]; then
  printf '%s\n' "$MOVE"
fi
exit 0
