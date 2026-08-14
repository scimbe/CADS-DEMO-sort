#!/usr/bin/env python3
"""ops/generate-status.py -- generate STATUS.md, the operator's one-page view (RFC #24, R1.1).

Never hand-edit STATUS.md: this script is its only writer, composing three sources that already
exist rather than inventing a fourth system of record:

  1. the deployment ledger (ops/deployment-ledger.ndjson) -- what is deployed, was it verified
  2. live behavioral probes -- is it actually up NOW (best-effort; a probe that can't run from
     the current machine reports "not probed", never a guess)
  3. GitHub issue states (the `state:` label family) -- what is in flight, what awaits the
     operator

Usage:  python3 ops/generate-status.py          # writes ops/STATUS.md
        python3 ops/generate-status.py --stdout  # print instead of write

Requires: python3 stdlib; `gh` CLI (optional -- section degrades to a note without it);
network for the public probe (optional, same degradation).
"""
import datetime
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
LEDGER = HERE / "deployment-ledger.ndjson"
OUT = HERE / "STATUS.md"
REPO = "scimbe/CADS-DEMO-sort"
PUBLIC_PROBE = "https://sort.bunsenbrenner.org/participants"
STATE_LABELS = [
    "state: awaiting-user-approval",  # first: this section IS the operator's queue
    "state: fix-proposed",
    "state: deployed",
    "state: investigating",
    "state: verified",
]


def sh(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception as e:  # noqa: BLE001 -- a status page must degrade, never crash
        return -1, str(e)


def ledger_entries():
    if not LEDGER.exists():
        return []
    return [json.loads(line) for line in LEDGER.read_text().splitlines() if line.strip()]


def latest_per_component(entries):
    latest = {}
    for e in entries:
        latest[e["component"]] = e  # file is append-only chronological
    return latest


def public_probe():
    if not shutil.which("curl"):
        return "not probed (no curl on this machine)"
    code, out = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", PUBLIC_PROBE])
    if code != 0:
        return f"probe failed to run ({out})"
    return f"HTTP {out}" + (" -- OK" if out == "200" else " -- NOT OK")


def issue_rows():
    if not shutil.which("gh"):
        return None
    rows = {}
    for label in STATE_LABELS:
        code, out = sh(
            ["gh", "issue", "list", "--repo", REPO, "--state", "open", "--label", label,
             "--json", "number,title", "--jq", '.[] | "#\\(.number) \\(.title[0:70])"'],
            timeout=30,
        )
        rows[label] = out.splitlines() if code == 0 and out else []
    return rows


def main():
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries = ledger_entries()
    latest = latest_per_component(entries)
    lines = [
        "# Status -- sort arena (generated, do not hand-edit)",
        "",
        f"Generated: `{now}` by `ops/generate-status.py` from the deployment ledger, "
        f"live probes, and the `state:` label family. Stale timestamps mean nobody ran the "
        f"generator, not that nothing happened -- check the ledger's own tail when in doubt.",
        "",
        "## Components (last ledger entry per component)",
        "",
        "| Component | Artifact | When | Verification |",
        "|---|---|---|---|",
    ]
    for comp, e in sorted(latest.items()):
        lines.append(f"| {comp} | {e['artifact']} | {e['ts']} | {e['verification'][:100]} |")
    lines += [
        "",
        "## Live probe",
        "",
        f"- `{PUBLIC_PROBE}`: {public_probe()}",
        "",
        "## Issues by state",
        "",
    ]
    rows = issue_rows()
    if rows is None:
        lines.append("_gh CLI not available on this machine -- see the label search links in #24._")
    else:
        for label in STATE_LABELS:
            items = rows[label]
            marker = " **<-- the operator's queue**" if label == "state: awaiting-user-approval" and items else ""
            lines.append(f"### `{label}`{marker}")
            lines += [f"- {i}" for i in items] or ["- (none)"]
            lines.append("")
    text = "\n".join(lines).rstrip() + "\n"
    if "--stdout" in sys.argv:
        print(text)
    else:
        OUT.write_text(text)
        print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
