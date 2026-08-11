#!/usr/bin/env bash
# participants/chaotic-claude/handler.sh — undisciplined strategy, strict contract (CADS-DEMO-sort#5).
#
# Contract: one round-input JSON object on stdin -> exactly one move JSON object on stdout,
# per docs/protocol.md. Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
#
# Context comes from participants/CLAUDE.md (shared protocol contract) plus this directory's own
# AGENTS.md/CLAUDE.md (strategy — exploratory, undisciplined, on purpose), via Claude Code's
# native project-file auto-discovery. See participants/minimal-claude/handler.sh for the same
# pattern with commentary on why (CADS-DEMO-sort#11).
#
# No hardcoded-move fallback, on purpose — see participants/minimal-claude/handler.sh.
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

extract_move_json() {
  local flat
  flat="$(tr -d '\n')"
  printf '%s' "$flat" | grep -o '{[^{}]*"action"[^{}]*}' | tail -1
}

if [ "${1:-}" = "--selftest" ]; then
  [ -f "$HERE/AGENTS.md" ] || { echo "SELFTEST FAIL: AGENTS.md missing at $HERE" >&2; exit 1; }
  [ -L "$HERE/CLAUDE.md" ] || { echo "SELFTEST FAIL: CLAUDE.md is not the expected AGENTS.md symlink at $HERE" >&2; exit 1; }
  got="$(printf 'Let me try something different!\n{"action":"compare","i":5,"j":1}\n' | extract_move_json)"
  printf '%s' "$got" | "$PY" -c 'import sys,json; m=json.load(sys.stdin); assert m=={"action":"compare","i":5,"j":1}, m' \
    || { echo "SELFTEST FAIL: extraction did not recover the move from a chatty reply" >&2; exit 1; }
  echo "SELFTEST OK: chaotic-claude has AGENTS.md/CLAUDE.md and extracts a move from a chatty reply"
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
