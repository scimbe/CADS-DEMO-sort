#!/usr/bin/env bash
# participants/bubble-sort-claude/handler.sh — same model, coached bubble sort specifically.
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# Context comes from participants/CLAUDE.md (shared protocol contract) plus this directory's own
# AGENTS.md/CLAUDE.md (strategy — real bubble sort, adjacent-pair passes, cursor reconstructed
# each round from the single most recent move in history), via Claude Code's native project-file
# auto-discovery. See participants/minimal-claude/handler.sh for the same pattern with commentary
# on why (CADS-DEMO-sort#11).
#
# No hardcoded-move fallback, on purpose — see participants/minimal-claude/handler.sh.
set -uo pipefail

# Windows ships `python`/`py`, not `python3` -- `python3` there is a Microsoft Store alias stub
# that does nothing useful (CADS-DEMO-sort-docs#1). Resolve once, fail clearly if neither exists.
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "handler: no python3 or python found on PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$HERE/AGENTS.md" ] || { echo "SELFTEST FAIL: AGENTS.md missing at $HERE" >&2; exit 1; }
  [ -L "$HERE/CLAUDE.md" ] || { echo "SELFTEST FAIL: CLAUDE.md is not the expected AGENTS.md symlink at $HERE" >&2; exit 1; }
  grep -q 'action.*swap' "$HERE/AGENTS.md" || { echo "SELFTEST FAIL: AGENTS.md does not teach the move format" >&2; exit 1; }
  got="$(printf '{\n  "action": "swap",\n  "i": 0,\n  "j": 1\n}\n' | extract_move_json)"
  printf '%s' "$got" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m=={"action":"swap","i":0,"j":1}, m' \
    || { echo "SELFTEST FAIL: extraction did not recover the move" >&2; exit 1; }
  echo "SELFTEST OK: bubble-sort-claude has AGENTS.md/CLAUDE.md and extracts multi-line moves"
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
