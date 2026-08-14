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
    """Parse the ledger, tolerating a bad line rather than crashing (a status page must degrade,
    never crash). Returns (entries, n_unparseable) so the dashboard can surface the count."""
    if not LEDGER.exists():
        return [], 0
    entries, bad = [], 0
    for line in LEDGER.read_text().splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            bad += 1
    return entries, bad


def latest_per_component(entries):
    # Pick the entry with the max ISO-8601 UTC ts per component (lexicographic == chronological
    # for `...Z` timestamps), tie-broken by file order -- NOT plain file order, because a
    # --backfilled entry recording a PAST deploy can be appended after a newer one and must not
    # then masquerade as currently-deployed.
    latest = {}
    for i, e in enumerate(entries):
        comp = e.get("component", "?")
        ts = e.get("ts", "")
        prev = latest.get(comp)
        if prev is None or (ts, i) > (prev.get("ts", ""), prev.get("_idx", -1)):
            e = dict(e, _idx=i)
            latest[comp] = e
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
        if code != 0:
            # Finding 1: a gh failure must NOT look like an empty queue -- especially not for the
            # operator's awaiting-approval queue. Report the failure honestly.
            rows[label] = [f"(query failed: gh exit {code})"]
        else:
            rows[label] = out.splitlines() if out else []
    return rows


def _cell(v):
    # Finding 5: a raw newline or pipe in a field value corrupts the markdown table. Keep cells
    # single-line and pipe-safe.
    return str(v).replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def main():
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries, bad_lines = ledger_entries()
    latest = latest_per_component(entries)
    lines = [
        "# Status -- sort arena (generated, do not hand-edit)",
        "",
        f"Generated: `{now}` by `ops/generate-status.py` from the deployment ledger, "
        f"live probes, and the `state:` label family. Stale timestamps mean nobody ran the "
        f"generator, not that nothing happened -- check the ledger's own tail when in doubt.",
        "",
    ]
    if bad_lines:
        lines += [f"> ⚠ {bad_lines} unparseable ledger line(s) skipped -- run `ops/ledger-lint` (or eyeball the tail).", ""]
    lines += [
        "## Components (last ledger entry per component)",
        "",
        "| Component | Artifact | When | Verification |",
        "|---|---|---|---|",
    ]
    for comp, e in sorted(latest.items()):
        lines.append(
            f"| {_cell(comp)} | {_cell(e.get('artifact', '?'))} | {_cell(e.get('ts', '?'))} | {_cell(e.get('verification', '?'))[:100]} |"
        )
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
