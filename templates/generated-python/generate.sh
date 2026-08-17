#!/usr/bin/env bash
# templates/generated-python/generate.sh — generic two-stage scaffold, copy this pair into a
# NEW participants/<your-id>/ directory (alongside a real AGENTS.md) rather than editing here.
#
# This is the generic version of what participants/bubble-sort-claude/generate.sh and
# participants/algorithm-coached-claude/generate.sh each hand-wrote for themselves: it derives
# the participant id from the directory name instead of hardcoding a strategy description or id
# string, so copying this pair into a fresh directory needs zero edits before your first
# generate.sh run — only AGENTS.md's contents (your actual strategy) has to exist first.
#
# GOAL/CONTEXT/CONSTRAINTS/OUTPUT framing, per CADS-DEMO-sort-docs/_explanation/instruction-structure.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YOU="$(basename "$HERE")"
LLM="${CT_LLM_CMD:-claude}"
OUT_DIR="$HERE/generated"
OUT_FILE="$OUT_DIR/handler.py"
STAGE_FILE="$OUT_FILE.new"
mkdir -p "$OUT_DIR"

[ -f "$HERE/AGENTS.md" ] || {
  echo "generate.sh: $HERE/AGENTS.md does not exist yet -- write your strategy spec there first" >&2
  exit 1
}
AGENTS_MD="$(cat "$HERE/AGENTS.md")"
# SORT_PROTOCOL_MD (CADS-DEMO-sort#30, "participant dir outside the clone"): by default the
# contract is read from participants/CLAUDE.md relative to this directory -- which only works
# when the participant directory lives INSIDE the repo clone. Point SORT_PROTOCOL_MD at the
# contract file to run this scaffold from anywhere (your own project directory, the repo being
# merely a reference): SORT_PROTOCOL_MD=/path/to/CADS-DEMO-sort/participants/CLAUDE.md
PROTOCOL_MD="$(cat "${SORT_PROTOCOL_MD:-$HERE/../CLAUDE.md}")"

# The QUOTED heredoc delimiter ('TEMPLATE_EOF') is load-bearing, not stylistic: AGENTS.md is
# ordinary markdown, full of single-backtick code spans. An UNQUOTED heredoc here would have bash
# treat every backtick PAIR as command substitution when the placeholders below get expanded into
# it, silently running e.g. `array` as a shell command and corrupting the prompt with garbage
# instead of the real markdown. Quoting the delimiter disables all interpolation in the template;
# the placeholders are substituted afterward via plain string replacement
# (${var//search/replacement}), which never re-interprets the replacement text as shell, however
# many backticks or `$` characters it contains.
TEMPLATE="$(cat <<'TEMPLATE_EOF'
GOAL
Write a single, complete, self-contained Python 3 program that implements the sorting strategy
described below as real, deterministic code — not as instructions for a model to follow live.
The program is invoked fresh once per round by a shell wrapper; it must read one round-input
JSON object from stdin and write exactly one move JSON object to stdout, per the contract.

CONTEXT
Shared move-protocol contract (docs/protocol.md, restated via participants/CLAUDE.md):
__PROTOCOL_MD__

Strategy participant "__YOU__" must implement, stateless-per-invocation — this program is invoked
fresh every round with no memory of past calls beyond what the round-input's own `history` field
carries — reconstruct any notion of "where you are" from that, never from a variable that would
need to persist across invocations:
__AGENTS_MD__

CONSTRAINTS
- You are NOT writing a file and need no tools: your entire stdout IS the program. Output
  ONLY the Python source code, nothing else — no markdown fences, no prose before or
  after, no explanation. The very first character of your output must be Python code.
- The program must use only the Python standard library (json, sys). No third-party imports,
  no network access, no file I/O beyond stdin/stdout.
- It must read the ENTIRE round-input JSON object from stdin (json.load(sys.stdin)), reconstruct
  any state exactly as AGENTS.md describes, and write exactly one JSON object to stdout via
  print(json.dumps(...)) — no trailing extra output, no debug prints.
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
PROMPT="${PROMPT//__YOU__/$YOU}"

# Tester feedback (CADS-DEMO-sort-docs): "what exactly does the model get sent" was answerable only
# by reading this file's own TEMPLATE_EOF block by hand and mentally substituting your AGENTS.md in.
# Write the fully assembled prompt out so it's one `cat` away instead -- purely diagnostic, never
# read back in by this script.
printf '%s\n' "$PROMPT" > "$OUT_DIR/.last-prompt.txt"

# Same execution-probe as handler.sh: `command -v python3` finds Windows' Store alias stub, so
# probe by actually running it (CADS-DEMO-sort-docs#1, second round).
PY=""
for c in python3 python py; do
  if "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "generate.sh: no working python3/python/py found on PATH" >&2; exit 1; }

# Validate-and-retry (CADS-DEMO-sort#30): measured over 8 real generations, 2/5 outputs were
# unusable for the SAME reason -- the model appended English prose after valid Python, which the
# fence-stripping sed below cannot catch, and the user only found out at --selftest, after
# burning up to 125s on the failed attempt. `py_compile` catches that class in milliseconds, so
# a failed draw costs one automatic regeneration instead of a user-visible broken artifact.
# Bounded at 2 attempts: a second identical failure means something is genuinely wrong with the
# prompt/model and a human should look, not a loop.
MAX_ATTEMPTS=2
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  RAW="$("$LLM" -p "$PROMPT" --output-format text \
    --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" 2>/dev/null)" || {
    echo "generate.sh: LLM call failed (attempt $attempt/$MAX_ATTEMPTS)" >&2
    [ "$attempt" -lt "$MAX_ATTEMPTS" ] && continue
    exit 1
  }

  # Strip a markdown fence if the model added one anyway, despite the CONSTRAINTS above --
  # defensive, not load-bearing: real-world LLM output sometimes wraps code in ```python...```
  # even when told not to.
  CODE="$(printf '%s\n' "$RAW" | sed -e '/^```/d')"

  # Stage the draft; only a compile-clean draft ever replaces $OUT_FILE (CADS-DEMO-sort#30,
  # intern's patch, applied as supplied: the previous version wrote the draft straight over the
  # target, so a doubly-failed generation DESTROYED the participant's previously-working handler
  # -- worse than never generating. Reproduced deterministically with a prose-emitting stub;
  # with staging, the same stub leaves handler.py byte-identical and still passing --selftest.)
  printf '%s\n' "$CODE" > "$STAGE_FILE"
  chmod +x "$STAGE_FILE"

  if "$PY" -m py_compile "$STAGE_FILE" 2>"$OUT_DIR/.compile-err"; then
    rm -f "$OUT_DIR/.compile-err"
    mv "$STAGE_FILE" "$OUT_FILE"
    echo "generate.sh: wrote $OUT_FILE ($(wc -l < "$OUT_FILE") lines, compiles clean, attempt $attempt/$MAX_ATTEMPTS)"
    echo "generate.sh: verify with: $HERE/handler.sh --selftest"
    echo "generate.sh: curious what was actually sent? cat $OUT_DIR/.last-prompt.txt"
    exit 0
  fi
  echo "generate.sh: attempt $attempt/$MAX_ATTEMPTS produced code that does not compile:" >&2
  sed 's/^/generate.sh:   /' "$OUT_DIR/.compile-err" >&2
  [ "$attempt" -lt "$MAX_ATTEMPTS" ] && echo "generate.sh: regenerating..." >&2
done

# Both attempts failed: keep the last broken draft for inspection under a name handler.sh will
# never execute. The participant's existing handler (if any) was never touched.
mv "$STAGE_FILE" "$OUT_FILE.rejected"
echo "generate.sh: FAILED after $MAX_ATTEMPTS attempts -- last output kept at $OUT_FILE.rejected" >&2
if [ -f "$OUT_FILE" ]; then
  echo "generate.sh: your previous handler is untouched and still runnable." >&2
else
  echo "generate.sh: tip: the shipped reference-handler.py is a working baseline while you retry:" >&2
  echo "generate.sh:   cp \"$HERE/reference-handler.py\" \"$OUT_FILE\"" >&2
fi
exit 1
