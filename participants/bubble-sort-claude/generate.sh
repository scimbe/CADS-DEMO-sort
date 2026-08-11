#!/usr/bin/env bash
# participants/bubble-sort-claude/generate.sh — writes generated/handler.py ONCE.
#
# This is the two-stage harness (CADS-DEMO-sort redesign): the LLM's job is to WRITE the
# sorting code, not to decide moves live at inference time. Run this once (at onboarding, or
# whenever AGENTS.md changes) to produce a real, self-contained, deterministic Python program at
# generated/handler.py. handler.sh then just execs that file on every round — no `claude -p`
# call happens during a live run anymore.
#
# GOAL/CONTEXT/CONSTRAINTS/OUTPUT framing, per CADS-DEMO-sort-docs/_explanation/instruction-structure.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="${CT_LLM_CMD:-claude}"
OUT_DIR="$HERE/generated"
OUT_FILE="$OUT_DIR/handler.py"
mkdir -p "$OUT_DIR"

AGENTS_MD="$(cat "$HERE/AGENTS.md")"
PROTOCOL_MD="$(cat "$HERE/../CLAUDE.md")"

PROMPT="$(cat <<PROMPT_EOF
GOAL
Write a single, complete, self-contained Python 3 program that implements the sorting strategy
described below as real, deterministic code — not as instructions for a model to follow live.
The program is invoked fresh once per round by a shell wrapper; it must read one round-input
JSON object from stdin and write exactly one move JSON object to stdout, per the contract.

CONTEXT
Shared move-protocol contract (docs/protocol.md, restated via participants/CLAUDE.md):
${PROTOCOL_MD}

Strategy this participant must implement (bubble sort, coached, stateless-per-invocation):
${AGENTS_MD}

CONSTRAINTS
- Output ONLY the Python source code, nothing else — no markdown fences, no prose before or
  after, no explanation. The very first character of your output must be Python code.
- The program must use only the Python standard library (json, sys). No third-party imports,
  no network access, no file I/O beyond stdin/stdout.
- It must read the ENTIRE round-input JSON object from stdin (json.load(sys.stdin)), reconstruct
  the cursor from history exactly as AGENTS.md describes, and write exactly one JSON object to
  stdout via print(json.dumps(...)) — no trailing extra output, no debug prints.
- It must be deterministic: the same round-input JSON must always produce the same move JSON.
- It must never crash on well-formed input described by the contract — always emit a valid
  {"action": "compare"|"swap"|"done", ...} object.
- Do not hardcode the array or any array-specific logic — the program must work for any array
  the contract describes, of any length within the protocol's bounds.

OUTPUT
Emit the complete contents of generated/handler.py as raw Python source, and nothing else.
PROMPT_EOF
)"

RAW="$("$LLM" -p "$PROMPT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" 2>/dev/null)" || {
  echo "generate.sh: claude -p failed" >&2
  exit 1
}

# Strip a markdown fence if the model added one anyway, despite the CONSTRAINTS above --
# defensive, not load-bearing: real-world LLM output sometimes wraps code in ```python...```
# even when told not to.
CODE="$(printf '%s\n' "$RAW" | sed -e '/^```/d')"

printf '%s\n' "$CODE" > "$OUT_FILE"
chmod +x "$OUT_FILE"

echo "generate.sh: wrote $OUT_FILE ($(wc -l < "$OUT_FILE") lines)"
echo "generate.sh: verify with: $HERE/handler.sh --selftest"
