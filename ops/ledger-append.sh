#!/usr/bin/env bash
# ops/ledger-append.sh -- append one validated entry to the deployment ledger (CADS-DEMO-sort#24, R1.2).
#
# The ledger is the machine-written, append-only record every deploying party MUST write to at
# deploy time. It exists so the operator (and every other party) can see what is actually running
# where without reading issue-comment prose -- two live incidents motivated it on 2026-08-14
# alone: an OIDC approval capability silently dying across redeploys, and a Caddy container
# serving week-old configs off stale single-file bind mounts while `git pull` + `caddy reload`
# both reported success. A content hash per entry is what catches that second class.
#
# Usage:
#   ops/ledger-append.sh --party sort-maintainer --component bridge \
#     --artifact "sort-demo-bridge:v0413-localfix @ 6f23c0e" \
#     --trigger "local-handler envelope regression (sort#9)" \
#     --verification "POST /run/reference-sorter -> finishedCorrectly=true" \
#     --rollback "sort-demo-bridge:v049-loginauto" \
#     [--config-hash <sha256 of the effective config/served artifact>] [--backfilled]
#
# Every field except --config-hash/--backfilled is required -- an entry you can't fill is a
# deploy you don't understand well enough to make yet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$HERE/deployment-ledger.ndjson"

party="" component="" artifact="" trigger="" verification="" rollback="" config_hash="" backfilled="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --party) party="$2"; shift 2 ;;
    --component) component="$2"; shift 2 ;;
    --artifact) artifact="$2"; shift 2 ;;
    --trigger) trigger="$2"; shift 2 ;;
    --verification) verification="$2"; shift 2 ;;
    --rollback) rollback="$2"; shift 2 ;;
    --config-hash) config_hash="$2"; shift 2 ;;
    --backfilled) backfilled="true"; shift ;;
    *) echo "ledger-append: unknown argument $1" >&2; exit 2 ;;
  esac
done

for req in party component artifact trigger verification rollback; do
  if [ -z "${!req}" ]; then
    echo "ledger-append: --$req is required (an entry you can't fill is a deploy you don't understand yet)" >&2
    exit 2
  fi
done

# JSON-encode via python3 so arbitrary quoting in field values can never corrupt the ledger --
# a ledger you can't parse is worse than no ledger.
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
party="$party" component="$component" artifact="$artifact" trigger="$trigger" \
verification="$verification" rollback="$rollback" config_hash="$config_hash" backfilled="$backfilled" \
python3 - "$LEDGER" <<'PY'
import json, os, sys
entry = {
    "ts": os.environ["ts"],
    "party": os.environ["party"],
    "component": os.environ["component"],
    "artifact": os.environ["artifact"],
    "trigger": os.environ["trigger"],
    "verification": os.environ["verification"],
    "rollback": os.environ["rollback"],
}
if os.environ["config_hash"]:
    entry["config_hash"] = os.environ["config_hash"]
if os.environ["backfilled"] == "true":
    entry["backfilled"] = True
path = sys.argv[1]
# Guard against concatenating onto a line that lacks its trailing newline (a prior truncated
# write / hand edit): otherwise the next append produces `{...}{...}` on one physical line, which
# the generator can't parse. Prepend a newline only when the file is non-empty and doesn't end in
# one -- never corrupt the ledger, the whole point of this helper.
prefix = ""
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path, "rb") as f:
        f.seek(-1, os.SEEK_END)
        if f.read(1) != b"\n":
            prefix = "\n"
with open(path, "a") as f:
    f.write(prefix + json.dumps(entry, ensure_ascii=False) + "\n")
print(f"ledger-append: recorded {entry['component']} -> {entry['artifact']}")
PY

# Finding 4: keep STATUS.md in lockstep with the ledger -- regenerate it after every append so
# the committed snapshot never lags the data it summarizes. Best-effort: a generator failure must
# not fail the append that already succeeded.
if [ -x "$HERE/generate-status.py" ] || [ -f "$HERE/generate-status.py" ]; then
  python3 "$HERE/generate-status.py" >/dev/null 2>&1 || echo "ledger-append: note -- STATUS.md regen failed; run ops/generate-status.py by hand" >&2
fi
