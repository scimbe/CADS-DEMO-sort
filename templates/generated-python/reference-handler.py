#!/usr/bin/env python3
"""Working reference handler — the participant's INSTANT first success (CADS-DEMO-sort#30).

Copy me to generated/handler.py and the scaffold is immediately runnable: selftest, dryrun and a
local-arena round all work before any LLM has been called. Generation then becomes the SECOND
step — replace this baseline with your own strategy via AGENTS.md + generate.sh — which is where
it belongs pedagogically: first see a working baseline, then change the harness and watch the
difference. Measured motivation: generate.sh's LLM call took 21-125s with a 3/5 usable rate at
the time this file was added; first success must not depend on that draw.

Strategy: adjacent-inversion bubble step (always a contract-valid move). Deterministic; stateless
per invocation, as the contract requires; reacts to `correction` by deterministically choosing a
DIFFERENT move than it was about to make (contract: correction's presence alone is the signal --
it is an opaque string, never parsed).
"""
import json
import sys


def candidate_moves(array):
    """All adjacent inversions, left to right -- each a valid {"action":"swap"} move."""
    return [
        {"action": "swap", "i": i, "j": i + 1}
        for i in range(len(array) - 1)
        if array[i] > array[i + 1]
    ]


def main():
    rnd = json.load(sys.stdin)
    array = rnd["array"]
    moves = candidate_moves(array)
    if not moves:
        print(json.dumps({"action": "done"}))
        return
    if "correction" in rnd:
        # The move we were about to make was just rejected: pick a deterministic ALTERNATIVE.
        # Second inversion if one exists; otherwise a compare of the same pair -- a compare is
        # always valid and is by construction not the rejected swap.
        if len(moves) > 1:
            print(json.dumps(moves[1]))
        else:
            print(json.dumps({"action": "compare", "i": moves[0]["i"], "j": moves[0]["j"]}))
        return
    print(json.dumps(moves[0]))


if __name__ == "__main__":
    main()
