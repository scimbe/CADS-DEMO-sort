#!/usr/bin/env python3
"""dryrun.py — run a Sort Arena handler locally, exactly the way the bridge would.

Why this exists: `docs/protocol.md` and `participants/CLAUDE.md` both require that a handler is
verified against the contract criteria BEFORE it joins a channel, and the arena's own scoring
lives in `bridge/server.lib.js`. This script is a faithful, dependency-free port of that file's
round loop (`validateMove` / `parseHandlerOutput` / `runRound` / `runSoloRun`), so a local pass
here means the same thing a live run would. It has been reinvented at least twice already by
naive-user validation runs of the docs (see CADS-DEMO-sort-docs' tutorials) because it did not
exist as a real repo file -- this is the fix for that, not a third throwaway copy.

If this script and `bridge/server.lib.js` ever disagree about round semantics, server.lib.js is
what actually scores you and this file is the bug -- the constants and logic below are copied
from it deliberately, not re-derived.

Usage
-----
    # full run against a random 8-element array
    ./dryrun.py ./participants/<id>/handler.sh --len 8

    # reproducible run (same array every time -- use this for the determinism check: run it
    # twice with the same --seed/--array and diff the output)
    ./dryrun.py ./participants/<id>/handler.sh --seed 42 --len 8
    ./dryrun.py ./participants/<id>/handler.sh --array 18,60,61,29,26,25 --budget 600

    # correction check: same round, with and without `correction` attached; the move must differ
    # if your strategy is meant to react to it (see the check's own note if it doesn't)
    ./dryrun.py ./participants/<id>/handler.sh --correction-check
    ./dryrun.py ./participants/<id>/handler.sh --correction-check --array 18,60,61,29,26,25

Exit status is 0 only when the run satisfies the contract criteria in `participants/CLAUDE.md`
(format faults 0, terminated with a correct `done` inside budget), so this is safe to use as a
gate in a script.
"""

import argparse
import json
import random
import subprocess
import sys
import time

print = __import__("functools").partial(print, flush=True)  # a real LLM round takes seconds;
# unbuffered output is the difference between "running" and "frozen" while you watch it.

# --- Constants, copied from bridge/server.lib.js -----------------------------------------------
DEFAULT_BUDGET = 200
DEFAULT_TIMEOUT_MS = 30_000
HISTORY_CAP = 20
MAX_ARRAY_LEN = 24
MAX_CORRECTIONS = 2


# --- Pure core, ported from bridge/server.lib.js ------------------------------------------------

def count_inversions(array):
    """Pairs i<j with array[i] > array[j] -- the arena's "how far from sorted" measure."""
    inv = 0
    for i in range(len(array)):
        for j in range(i + 1, len(array)):
            if array[i] > array[j]:
                inv += 1
    return inv


def is_sorted(array):
    return all(array[i - 1] <= array[i] for i in range(1, len(array)))


def validate_move(raw, array_length):
    """Mirrors validateMove in bridge/server.lib.js exactly -- the entire defense against a
    malformed reply. `raw` may be anything, including not a dict, since it comes straight from
    parsing untrusted stdout."""
    if not isinstance(raw, dict):
        return False, "reply is not a JSON object"
    action = raw.get("action")
    if action == "done":
        return True, {"action": "done"}
    if action not in ("compare", "swap"):
        return False, f'unknown action "{action}" -- must be "compare", "swap", or "done"'
    i, j = raw.get("i"), raw.get("j")
    if not isinstance(i, int) or isinstance(i, bool) or not isinstance(j, int) or isinstance(j, bool):
        return False, "i and j must be integers"
    if i < 0 or i >= array_length or j < 0 or j >= array_length:
        return False, f"i and j must be in range [0, {array_length - 1}]"
    if i == j:
        return False, "i and j must differ"
    return True, {"action": action, "i": i, "j": j}


def apply_move(array, move):
    if move["action"] != "swap":
        return list(array)
    nxt = list(array)
    nxt[move["i"]], nxt[move["j"]] = nxt[move["j"]], nxt[move["i"]]
    return nxt


def build_round_input(round_no, array, history, budget_remaining, mode, you, correction=None):
    payload = {
        "round": round_no,
        "array": array,
        "history": history[-HISTORY_CAP:],
        "budgetRemaining": budget_remaining,
        "mode": mode,
        "you": you,
    }
    if correction:
        payload["correction"] = correction
    return payload


def parse_handler_output(stdout, array_length):
    trimmed = (stdout or "").strip()
    if not trimmed:
        return False, "no output"
    try:
        parsed = json.loads(trimmed)
    except json.JSONDecodeError as e:
        return False, f"output is not valid JSON: {e}"
    return validate_move(parsed, array_length)


def call_handler(handler, payload, timeout_s):
    """Launched via `bash` explicitly, not exec'd directly: Windows has no shebang support and
    cannot run a .sh file as a subprocess argv[0] at all (CADS-DEMO-sort-docs#1) -- `bash` is
    assumed on PATH (Git Bash on Windows, native everywhere else), matching every handler's own
    #!/usr/bin/env bash shebang."""
    try:
        proc = subprocess.run(
            ["bash", handler], input=json.dumps(payload), capture_output=True, text=True, timeout=timeout_s
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"handler timed out after {timeout_s}s")
    if not proc.stdout.strip():
        detail = proc.stderr.strip()
        raise RuntimeError(f"handler produced no output, exit {proc.returncode}" + (f" -- stderr: {detail}" if detail else ""))
    return proc.stdout


def run_round(handler, round_no, array, history, budget_remaining, mode, you, timeout_s):
    """Mirrors runRound: never raises: exhausts MAX_CORRECTIONS retries, then returns a fault."""
    correction = None
    max_attempts = MAX_CORRECTIONS + 1
    for attempt in range(1, max_attempts + 1):
        payload = build_round_input(round_no, array, history, budget_remaining, mode, you, correction)
        try:
            stdout = call_handler(handler, payload, timeout_s)
        except RuntimeError as e:
            correction = f"your last reply could not be read ({e}) -- reply with exactly one JSON object"
            if attempt >= max_attempts:
                return {"fault": True, "reason": correction}
            continue
        ok, result = parse_handler_output(stdout, len(array))
        if ok:
            move = result
            if move["action"] == "done":
                return {"done": True, "actuallySorted": is_sorted(array)}
            return {"move": move, "array": apply_move(array, move)}
        correction = f"your last reply was rejected ({result}) -- reply with exactly one JSON object per docs/protocol.md"
        if attempt >= max_attempts:
            return {"fault": True, "reason": result}
    return {"fault": True, "reason": "exhausted retries"}  # unreachable in practice


def count_inversions(array):
    """Pairs i<j with array[i] > array[j] -- the 'how far from sorted' measure, and the proven
    lower bound on swaps for any adjacent-swap-only strategy (each adjacent swap fixes exactly
    one inversion). Mirrors server.lib.js's countInversions."""
    inv = 0
    for i in range(len(array)):
        for j in range(i + 1, len(array)):
            if array[i] > array[j]:
                inv += 1
    return inv


def run_solo(handler, initial_array, you, budget, timeout_s, quiet=False, property_checks=None):
    """Mirrors runSoloRun. Returns the same fields the bridge's own scoring reports.

    `property_checks` (tutorial stage 2, "evolve the harness toward a NAMED, verifiable
    algorithm"): a set possibly containing "adjacent" and/or "optimal-swaps". These turn
    algorithm-identity claims into CHECKED properties instead of vibes:
      - "adjacent":       every emitted compare/swap must touch neighbours only (j == i+1) --
                          the defining constraint of bubble sort (and its cousins).
      - "optimal-swaps":  total swaps must equal the initial array's inversion count -- an
                          adjacent-swap strategy that never swaps an already-ordered pair
                          achieves exactly this (each swap fixes exactly one inversion), so
                          exceeding it means wasted/undone work and a sub-bubble-sort harness.
    Violations are collected (not raised) and reported in the result's `propertyViolations`."""
    if len(initial_array) > MAX_ARRAY_LEN:
        raise ValueError(f"array length {len(initial_array)} exceeds MAX_ARRAY_LEN ({MAX_ARRAY_LEN})")
    property_checks = property_checks or set()
    initial_inversions = count_inversions(initial_array)
    property_violations = []
    array = list(initial_array)
    history = []
    comparisons = swaps = faults = wrong_done = 0
    finished_correctly = False
    round_no = 0
    started = time.time()

    while round_no < budget:
        round_no += 1
        outcome = run_round(handler, round_no, array, history, budget - round_no, "solo", you, timeout_s)
        if outcome.get("fault"):
            faults += 1
            if not quiet:
                print(f"round {round_no}: FAULT ({outcome['reason']})")
            continue  # array unchanged, budget still spent -- per docs/protocol.md
        if outcome.get("done"):
            if outcome["actuallySorted"]:
                finished_correctly = True
                if not quiet:
                    print(f"done at round {round_no}: SORTED {array}")
                break
            wrong_done += 1
            if not quiet:
                print(f"round {round_no}: done claimed but NOT sorted (fault-adjacent, not a format fault) {array}")
            continue
        move = outcome["move"]
        if "adjacent" in property_checks and abs(move["j"] - move["i"]) != 1:
            property_violations.append(
                f"round {round_no}: {move['action']} {move['i']},{move['j']} touches a NON-adjacent pair "
                f"(|j-i| = {abs(move['j'] - move['i'])}, must be 1)"
            )
        if move["action"] == "compare":
            comparisons += 1
        else:
            swaps += 1
            array = outcome["array"]
        history.append({"round": round_no, "action": move["action"], "i": move["i"], "j": move["j"], "resultArray": list(array)})
        if not quiet:
            print(f"round {round_no}: {move['action']} {move['i']},{move['j']} -> {array}")

    if not finished_correctly and round_no >= budget and not quiet:
        print(f"budget exhausted, still {array}")

    if "optimal-swaps" in property_checks and finished_correctly and swaps != initial_inversions:
        property_violations.append(
            f"swaps ({swaps}) != initial inversions ({initial_inversions}) -- an adjacent-swap "
            f"strategy that never swaps an ordered pair uses exactly one swap per inversion; the "
            f"surplus is wasted or undone work"
        )

    return {
        "you": you,
        "finalArray": array,
        "finishedCorrectly": finished_correctly,
        "comparisons": comparisons,
        "swaps": swaps,
        "faults": faults,
        "wrongDone": wrong_done,
        "roundsUsed": round_no,
        "wallClockMs": round((time.time() - started) * 1000),
        "initialInversions": initial_inversions,
        "propertyViolations": property_violations,
    }


# --- CLI ------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("handler", help="path to the handler script (bash)")
    ap.add_argument("--len", type=int, default=8, help="random array length (ignored if --array given)")
    ap.add_argument("--array", help="comma-separated array, e.g. 5,3,8,1,9,2 -- reproduces an exact run")
    ap.add_argument("--seed", type=int, help="random seed for a reproducible random array")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET)
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_MS / 1000, help="per-round timeout in seconds")
    ap.add_argument("--you", default="dryrun")
    ap.add_argument("--correction-check", action="store_true", help="probe whether the handler reacts to `correction`")
    ap.add_argument("--quiet", action="store_true", help="suppress per-round lines, print only the summary")
    ap.add_argument(
        "--require-adjacent",
        action="store_true",
        help="FAIL unless every compare/swap touches neighbours only (j == i+1) -- the defining "
        "constraint of bubble sort; tutorial stage 2's first checked property",
    )
    ap.add_argument(
        "--require-optimal-swaps",
        action="store_true",
        help="FAIL unless total swaps == the start array's inversion count -- what a bubble sort "
        "that never swaps an ordered pair achieves exactly; combine with --require-adjacent and "
        "--seed for a reproducible algorithm-identity check",
    )
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if args.correction_check:
        array = [int(x) for x in args.array.split(",")] if args.array else [3, 1, 2]
        probe = build_round_input(1, array, [], 20, "solo", args.you)
        corrected = build_round_input(1, array, [], 20, "solo", args.you, correction="i and j must differ; you sent i=0 j=0")
        try:
            base = call_handler(args.handler, probe, args.timeout).strip()
            fixed = call_handler(args.handler, corrected, args.timeout).strip()
        except RuntimeError as e:
            print(f"correction check: SKIPPED ({e})")
            return 0
        print(f"array:              {array}")
        print(f"without correction: {base}")
        print(f"with correction:    {fixed}")
        if base and base == fixed:
            print(
                "correction check: NOTE -- move is byte-identical with and without `correction` present. "
                "Expected if your handler is deterministic and never emits an invalid move in the first "
                "place (like the reference baseline) -- it will never actually receive a real correction "
                "to react to. But if your handler IS meant to react to `correction` and picked the same "
                "move anyway, it may be silently ignoring the field -- check that it treats `correction` "
                "as a plain string, not an object (CADS-DEMO-sort#15)."
            )
        else:
            print("correction check: OK (move changed when `correction` was present)")
        return 0

    array = [int(x) for x in args.array.split(",")] if args.array else [random.randint(0, 99) for _ in range(args.len)]
    checks = set()
    if args.require_adjacent:
        checks.add("adjacent")
    if args.require_optimal_swaps:
        checks.add("optimal-swaps")
    print("start:", array)
    result = run_solo(args.handler, array, args.you, args.budget, args.timeout, quiet=args.quiet, property_checks=checks)
    print(
        f"rounds={result['roundsUsed']} comparisons={result['comparisons']} swaps={result['swaps']} "
        f"faults={result['faults']} wrongDone={result['wrongDone']} sorted={result['finishedCorrectly']} "
        f"inversions={result['initialInversions']} wallClockMs={result['wallClockMs']}"
    )
    print("final:", result["finalArray"])
    for violation in result["propertyViolations"]:
        print(f"property violation: {violation}")
    if checks and not result["propertyViolations"] and result["finishedCorrectly"]:
        print(f"property checks passed: {', '.join(sorted(checks))}")
    return 0 if (result["finishedCorrectly"] and result["faults"] == 0 and not result["propertyViolations"]) else 1


if __name__ == "__main__":
    sys.exit(main())
