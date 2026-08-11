#!/usr/bin/env bash
# participants/minimal-claude/handler.sh — the "just ask the model" baseline (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# Context comes from participants/CLAUDE.md (shared protocol contract, one directory up) plus
# this directory's own AGENTS.md/CLAUDE.md (strategy — here, deliberately nothing extra), via
# Claude Code's native project-file auto-discovery: `cd` into this directory, no hand-built
# --append-system-prompt string. Discovery walks up to the git repo root and stops there
# (verified: CADS-DEMO-sort#11) — nothing outside this repo can leak into a participant's context.
#
# On a reply we cannot extract a move from we print NOTHING and exit 0. That is a real fault the
# bridge records and shows (docs/protocol.md "Validation and faults"). We deliberately do NOT
# fall back to a hardcoded move: a hidden fallback would launder a harness failure into a
# plausible-looking move and destroy the only honest signal this demo has.
set -uo pipefail

# Windows ships `python`/`py`, not `python3` -- and `command -v python3` is NOT enough to detect
# that (CADS-DEMO-sort-docs#1, second round): a real, executable Microsoft Store alias stub named
# `python3` sits on PATH in every default Windows install, so `command -v` finds it and reports
# success -- it only fails once you actually RUN it. Probe by execution, not presence.
PY=""
for c in python3 python py; do
  if "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "handler: no working python3/python/py found on PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Flatten newlines first — `grep` is line-oriented, so a pretty-printed or ```json-fenced object
# (which the model emits often enough to matter) matches nothing line-by-line. Prefer the LAST
# object that mentions "action", so an echoed example in a preamble never wins over the answer.
extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$HERE/AGENTS.md" ] || { echo "SELFTEST FAIL: AGENTS.md missing at $HERE" >&2; exit 1; }
  [ -L "$HERE/CLAUDE.md" ] || { echo "SELFTEST FAIL: CLAUDE.md is not the expected AGENTS.md symlink at $HERE" >&2; exit 1; }
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
  printf '%s' "$got" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m["action"]=="swap" and m["i"]==2 and m["j"]==4, m' \
    || { echo "SELFTEST FAIL: extracted text is not the expected move" >&2; exit 1; }
  noise="$(printf 'I think the array is fine.' | extract_move_json)"
  [ -z "$noise" ] || { echo "SELFTEST FAIL: prose-only reply must extract to NOTHING (a real fault), got: $noise" >&2; exit 1; }
  echo "SELFTEST OK: minimal-claude has AGENTS.md/CLAUDE.md and extracts fenced moves"
  exit 0
fi

LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"

OUT="$(cd "$HERE" && "$LLM" -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" 2>/dev/null)" || OUT=""

MOVE="$(printf '%s' "$OUT" | extract_move_json)"
if [ -n "$MOVE" ]; then
  printf '%s\n' "$MOVE"
fi
exit 0
