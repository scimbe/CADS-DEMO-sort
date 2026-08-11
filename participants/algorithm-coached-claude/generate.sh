#!/usr/bin/env bash
# participants/algorithm-coached-claude/generate.sh — writes generated/handler.py ONCE.
#
# Same two-stage harness as bubble-sort-claude/generate.sh: the LLM writes this participant's
# selection-sort-by-direct-placement strategy as real, deterministic code, once, instead of
# deciding moves live every round. See that file for the fuller header comment on why.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="${CT_LLM_CMD:-claude}"
OUT_DIR="$HERE/generated"
OUT_FILE="$OUT_DIR/handler.py"
mkdir -p "$OUT_DIR"

AGENTS_MD="$(cat "$HERE/AGENTS.md")"
PROTOCOL_MD="$(cat "$HERE/../CLAUDE.md")"

# The QUOTED heredoc delimiter ('TEMPLATE_EOF') is load-bearing, not stylistic: AGENTS.md is
# ordinary markdown, full of single-backtick code spans (`array`, `p`, `m`, ...). An UNQUOTED
# heredoc here would have bash treat every backtick PAIR as command substitution when the
# placeholders below get expanded into it, silently running e.g. `array` as a shell command and
# corrupting the prompt with garbage/empty text instead of the real markdown -- exactly the kind
# of harness unreliability this whole two-stage design exists to catch. Quoting the delimiter
# disables all interpolation in the template; the two placeholders are substituted afterward via
# plain string replacement (${var//search/replacement}), which never re-interprets the
# replacement text as shell, however many backticks or `$` characters it contains.
TEMPLATE="$(cat <<'TEMPLATE_EOF'
GOAL
Write a single, complete, self-contained Python 3 program that implements the sorting strategy
described below as real, deterministic code — not as instructions for a model to follow live.
The program is invoked fresh once per round by a shell wrapper; it must read one round-input
JSON object from stdin and write exactly one move JSON object to stdout, per the contract.

CONTEXT
Shared move-protocol contract (docs/protocol.md, restated via participants/CLAUDE.md):
__PROTOCOL_MD__

Strategy this participant must implement (selection sort by direct placement, stateless-per-invocation):
__AGENTS_MD__

CONSTRAINTS
- Output ONLY the Python source code, nothing else — no markdown fences, no prose before or
  after, no explanation. The very first character of your output must be Python code.
- The program must use only the Python standard library (json, sys). No third-party imports,
  no network access, no file I/O beyond stdin/stdout.
- It must read the ENTIRE round-input JSON object from stdin (json.load(sys.stdin)) and write
  exactly one JSON object to stdout via print(json.dumps(...)) — no trailing extra output, no
  debug prints. This strategy needs nothing from history -- it recomputes everything directly
  from the array every round, exactly as AGENTS.md describes.
- It must be deterministic: the same round-input JSON must always produce the same move JSON.
- It must never crash on well-formed input described by the contract — always emit a valid
  {"action": "compare"|"swap"|"done", ...} object.
- Do not hardcode the array or any array-specific logic — the program must work for any array
  the contract describes, of any length within the protocol's bounds.

OUTPUT
Emit the complete contents of generated/handler.py as raw Python source, and nothing else.
TEMPLATE_EOF
)"
PROMPT="${TEMPLATE//__PROTOCOL_MD__/$PROTOCOL_MD}"
PROMPT="${PROMPT//__AGENTS_MD__/$AGENTS_MD}"

RAW="$("$LLM" -p "$PROMPT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" 2>/dev/null)" || {
  echo "generate.sh: claude -p failed" >&2
  exit 1
}

CODE="$(printf '%s\n' "$RAW" | sed -e '/^```/d')"

printf '%s\n' "$CODE" > "$OUT_FILE"
chmod +x "$OUT_FILE"

echo "generate.sh: wrote $OUT_FILE ($(wc -l < "$OUT_FILE") lines)"
echo "generate.sh: verify with: $HERE/handler.sh --selftest"
