---
name: sort-arena-harness
description: Turns a plain-language sorting strategy into real, verified Sort Arena competitor code. Use when onboarding a new Sort Arena participant, or when changing an existing participant's strategy or target challenge.
---

# Sort Arena harness

## What this does

Sort Arena is not a place where your LLM decides sorting moves live, one at a time, while it
competes. Your LLM's job is to **write the sorting program once, as real code** — that code is
what actually runs the contest from then on. This skill is the guided path through that: it asks
you for the handful of things that genuinely vary per participant, then takes care of the rest of
the harness for you — writing the strategy spec, generating the code, checking it actually works,
and telling you what to do next.

## Why it works this way

Getting a model to make a good live judgment call, under a timer, round after round, is a
different (and much less reliable) skill than getting it to write code you can check once and
then trust every time after. When your strategy is real code, it runs in milliseconds and behaves
identically on every call — you can test it, verify it, and compete with it, instead of hoping
each live decision goes well.

## What I need from you

Tell me these up front if you already know them — otherwise I'll ask, one at a time, plain
language is completely fine:

1. **Participant id** — a short slug for you, e.g. `insertion-fan`. Becomes your directory name
   and how the arena identifies you.
2. **Display label** — the friendly name shown on the leaderboard.
3. **Your strategy, in your own words** — what should your sorter do, and why do you think it
   fits? You do not need a textbook algorithm name. "Always fix the pair nearest the front" and
   "assume the array is nearly sorted already, so look for the one thing out of place" are both
   completely fine answers.
4. **A target challenge, if you have one** — Sort Arena can hand out named challenge arrays with
   different shapes (nearly sorted, reversed, lots of duplicates, ...). If you're building for a
   specific one, name it (see `GET /challenges` on the bridge, or ask me to list them); I'll fold
   its shape into what your code needs to handle well. If you don't have one in mind, that's fine
   too — say so and I'll build for a general random array instead.

## What I do with it (you don't need to do this part by hand)

1. Turn what you told me into a real strategy spec — `<your-project-dir>/AGENTS.md` — plain
   language, but precise about what to do and how to tell when you're done. **Your participant
   directory lives OUTSIDE this repo clone by default** (CADS-DEMO-sort#30: your strategy is your
   project, not untracked cruft in someone else's git tree — `git pull` here must never collide
   with your work). I ask where you want it (suggestion: a sibling of the clone, named after your
   participant id — the id is derived from the directory's basename), then copy
   `templates/generated-python/generate.sh`, `handler.sh` AND `reference-handler.py` there — that
   generic trio needs no edits before it can run. Two things still come from the repo by path:
   the move contract (`generate.sh` finds it via `SORT_PROTOCOL_MD=<clone>/participants/CLAUDE.md`,
   which I set in the commands I give you) and `dryrun.py` (invoked from the clone). Working
   inside the clone under `participants/<your-id>/` still works unchanged — it's just no longer
   the default I steer you to. I then copy `reference-handler.py` to `generated/handler.py`, and
   **that is your first success, immediately**: a working, contract-verified baseline sorter you
   can selftest, dry-run and race in the local arena before any model call has happened — first
   success does not wait on a generation.
2. Run `generate.sh`, which asks the model to REPLACE that baseline with your own strategy as a
   real, self-contained Python program (`generated/handler.py`) — code, not a promise to follow
   instructions live. `generate.sh` compile-checks what comes back (`py_compile`) and
   automatically regenerates once on garbage output, so a bad model draw costs seconds, not a
   confusing broken artifact.
3. Verify what came back, three ways: `handler.sh --selftest` (does it speak the contract at
   all), a local dry run (`dryrun.py`) that actually sorts a real array with it — run **twice** on
   the same array, to confirm it's genuinely deterministic code and not a live guess that happened
   to work once — and `dryrun.py`'s own `correction check` (same round, with and without
   `correction` attached, move must differ if your strategy is meant to react to it). That third
   check exists because it catches a real, easy-to-miss class of bug: generated code that
   compiles, passes `--selftest`, and sorts correctly, but silently never reads `correction` at
   all because it guessed the wrong type for it (CADS-DEMO-sort#15 — the shared contract now
   states explicitly that `correction` is always a plain string, never an object, precisely
   because a model had no way to know that otherwise).
4. If either check fails, I don't just re-roll and hope for a cleaner sample. A failure here means
   something in `AGENTS.md` (step 1) was ambiguous or incomplete enough that the model couldn't
   turn it into reliable code — a missing edge case, an underspecified termination rule, a cursor
   or state assumption that isn't actually true every round. I'll point at what specifically the
   dry run's failure suggests is missing, tighten `AGENTS.md` to cover it, and regenerate. That
   tightened spec — not the regenerated code by itself — is the actual fix, and it's the part
   worth understanding: this is how you make the harness produce a *reliable* service, not just a
   service that happened to pass once.

## What you should expect to see

A short pass/fail report: whether `--selftest` passed, what the dry run produced (comparisons,
swaps, rounds used, whether it actually finished correctly sorted), and — if you named a
challenge — how it did against that challenge's array specifically. You don't need to read or
approve the generated Python yourself; the checks above are what "it works" means here.

## What you'll have learned once this is done

Not "how to get a model to sort a list live" — that was never the exercise, and not "how to get a
model to write some code" either. The actual goal is understanding **what about the harness you
have to change to make the generated service reliable**: which ambiguity in `AGENTS.md` produced
which wrong behavior in the generated code, and what a tightened spec (an explicit edge case, a
stated termination rule, a worked example) fixes versus what a plain re-roll never would have. If
verification fails once or twice before it passes, that sequence — spec, generated code, real
failure, sharper spec, reliable code — is not a detour from the lesson. It *is* the lesson. The
transferable skill is diagnosing harness gaps from a real failure, not writing a good prompt on
the first try.

## Stage 2 (optional, the real lesson): evolve the harness toward a NAMED, checkable algorithm

Once your v1 handler competes, the deeper exercise is steering the harness to a **specific,
verifiable target** — not "it sorts" but "it IS bubble sort, provably." This is where tools and
hooks enter, and where the spec-tightening loop from step 4 above becomes a real engineering
workflow:

1. **State the target as CHECKED properties, not vibes.** `dryrun.py` has them built in:
   `--require-adjacent` (every move touches neighbours only, `j == i+1` — bubble sort's defining
   constraint) and `--require-optimal-swaps` (total swaps == the start array's inversion count —
   what a bubble sort that never swaps an ordered pair achieves exactly). Your goal line is:

   ```
   python3 dryrun.py participants/<id>/handler.sh --seed 42 --quiet \
     --require-adjacent --require-optimal-swaps
   ```

   passing (exit 0) — and passing **twice on the same seed**, because reproducibility is part of
   the target, not a nice-to-have.

2. **Wire the goal line in as a hook, so regressions cannot slip past you.** Add it as a Claude
   Code hook (a `PostToolUse` hook on Bash that runs the goal line whenever `generate.sh` ran, or
   simply a `verify.sh` you invoke after every regeneration) — the point is that verification
   happens *mechanically*, every time, not when you remember. This mirrors how the arena itself
   treats verification: `handler.sh --selftest` and the bridge's own scoring are hooks you don't
   get to skip.

3. **Iterate `AGENTS.md`, not the generated code.** Run the goal line; every `property violation:`
   line names exactly what your spec failed to pin down (a non-adjacent jump means your spec never
   forbade direct placement; surplus swaps mean it lets the cursor swap already-ordered pairs or
   lose its position and redo work). Tighten the spec — an explicit cursor-reconstruction rule, a
   stated "only ever touch `k` and `k+1`", a termination rule read from the live array — and
   regenerate. `participants/bubble-sort-claude/AGENTS.md` is the reference solution: consult it
   AFTER your own attempt, as the worked answer, not as a copy source — deriving which spec line
   kills which violation is the transferable skill.

4. **Know when you're done.** Both property checks pass, on two different seeds, twice each. At
   that point your harness doesn't just produce working code — it produces a *specific algorithm
   on demand*, reproducibly, and you can explain which sentence in the spec guarantees which
   property. That is a testably better harness, which was the point.

## After this

Your generated handler is what competes. Joining the arena is self-service at `join.html`: log in
with your Keycloak account (the login IS the legitimization — reaching the join page already means
you're authenticated), generate your channel identity in-browser, and submit; you are **approved
automatically on the spot** (no waiting for an operator), the page hands you your grant and the
exact serve command to run. See
[Join as a participant](https://scimbe.github.io/CADS-DEMO-sort-docs/how-to/join-as-a-participant/)
for the full walkthrough. The operator can still revoke a participant later — approval is
automatic, moderation is not gone. This skill only covers turning your strategy into verified
code, so don't describe or suggest hand-editing
`SORT_PARTICIPANTS_JSON`/`SORT_PARTICIPANTS_FILE` anywhere in what you tell the user or write
into a generated README's own "registering" section — that's the operator's own base-config
mechanism (see `handlers/README.md`), not how a newly generated participant actually joins.
