"use strict";

/**
 * Sort Arena bridge — pure core (CADS-DEMO-sort#2).
 *
 * Everything in this file is process/network-free on purpose: the arena's crash-safety
 * guarantee (a participant can never take the bridge down, however malformed its output) lives
 * entirely in validateMove/applyMove/runSoloRound, so it can be unit-tested directly without
 * spawning a real handler process. server.js wires this to real child processes and HTTP.
 *
 * The wire contract this implements is docs/protocol.md — read that first if the two disagree,
 * the doc is the source of truth and this file is a bug.
 */

const DEFAULT_BUDGET = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const HISTORY_CAP = 20;
const MAX_ARRAY_LEN = 24;
const MAX_CORRECTIONS = 2;

/** Count inversions (pairs i<j with array[i] > array[j]) — the "how far from sorted" measure. */
function countInversions(array) {
  let inv = 0;
  for (let i = 0; i < array.length; i++) {
    for (let j = i + 1; j < array.length; j++) {
      if (array[i] > array[j]) inv++;
    }
  }
  return inv;
}

function isSorted(array) {
  for (let i = 1; i < array.length; i++) {
    if (array[i - 1] > array[i]) return false;
  }
  return true;
}

/**
 * Validate a parsed move against the current array. Returns {ok:true} or {ok:false, reason}.
 * This is the ENTIRE defense against a malformed/hostile participant — every field is checked,
 * nothing is trusted. `raw` may be anything (including not an object) since it comes straight
 * from JSON.parse of untrusted stdout.
 */
function validateMove(raw, arrayLength) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "reply is not a JSON object" };
  }
  const { action } = raw;
  if (action === "done") {
    return { ok: true, move: { action: "done" } };
  }
  if (action !== "compare" && action !== "swap") {
    return { ok: false, reason: `unknown action "${String(action)}" — must be "compare", "swap", or "done"` };
  }
  const { i, j } = raw;
  if (!Number.isInteger(i) || !Number.isInteger(j)) {
    return { ok: false, reason: "i and j must be integers" };
  }
  if (i < 0 || i >= arrayLength || j < 0 || j >= arrayLength) {
    return { ok: false, reason: `i and j must be in range [0, ${arrayLength - 1}]` };
  }
  if (i === j) {
    return { ok: false, reason: "i and j must differ" };
  }
  return { ok: true, move: { action, i, j } };
}

/** Apply an already-validated move to `array` (mutates a copy, returns the new array). */
function applyMove(array, move) {
  if (move.action !== "swap") return array.slice();
  const next = array.slice();
  const tmp = next[move.i];
  next[move.i] = next[move.j];
  next[move.j] = tmp;
  return next;
}

/**
 * Build the exact stdin payload for one round (docs/protocol.md's "Round input" shape).
 * `correction`, when present, is appended per the fault-retry contract.
 */
function buildRoundInput({ round, array, history, budgetRemaining, mode, you, correction }) {
  const trimmedHistory = history.slice(-HISTORY_CAP);
  const payload = { round, array, history: trimmedHistory, budgetRemaining, mode, you };
  if (correction) payload.correction = correction;
  return payload;
}

/**
 * Parse raw handler stdout into a move, or a validation failure. Handles empty output and
 * non-JSON output as faults rather than throwing — a participant that prints nothing, or
 * prints prose, is exactly as "handled" as one that prints a well-formed-but-out-of-range move.
 */
function parseHandlerOutput(stdout, arrayLength) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    return { ok: false, reason: "no output" };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, reason: `output is not valid JSON: ${e.message}` };
  }
  return validateMove(parsed, arrayLength);
}

/**
 * Run one round: given a `callHandler(input) -> Promise<stdout string>` function (real process
 * spawn in server.js, a stub in tests), produce a scored round outcome. Retries up to
 * MAX_CORRECTIONS times on an invalid reply before skipping the round as a fault — a participant
 * NEVER causes an exception to propagate out of this function; every failure mode resolves to a
 * normal round result with `applied: false`.
 */
async function runRound({ callHandler, round, array, history, budgetRemaining, mode, you }) {
  let correction;
  let attempts = 0;
  const maxAttempts = MAX_CORRECTIONS + 1;
  while (attempts < maxAttempts) {
    attempts++;
    const input = buildRoundInput({ round, array, history, budgetRemaining, mode, you, correction });
    let stdout;
    try {
      stdout = await callHandler(input);
    } catch (e) {
      // Spawn failure, timeout, non-zero exit — callHandler's contract is to reject with a
      // message, never to throw something we can't stringify.
      //
      // #9 retest 2: name the failing SIDE. A `role command exited …` rejection means the
      // BRIDGE's own ct-agent invocation died before any request ever reached the participant
      // — wording it as "your last reply could not be read" sent a participant with a
      // perfectly healthy handler off to debug their own side for hours (their words). Only a
      // genuine read/exchange failure keeps the old participant-facing wording.
      const bridgeSide = /role command exited/.test(String(e.message || e));
      correction = bridgeSide
        ? `the arena's own role command failed before your handler was ever called (${e.message || e}) — this is a bridge-side fault, nothing to fix on your side`
        : `your last reply could not be read (${e.message || e}) — reply with exactly one JSON object`;
      if (attempts >= maxAttempts) {
        return { round, fault: true, reason: correction, array, applied: false };
      }
      continue;
    }
    const result = parseHandlerOutput(stdout, array.length);
    if (result.ok) {
      const move = result.move;
      if (move.action === "done") {
        return { round, move, array, applied: false, done: true, actuallySorted: isSorted(array) };
      }
      const nextArray = applyMove(array, move);
      return { round, move, array: nextArray, applied: true };
    }
    correction = `your last reply was rejected (${result.reason}) — reply with exactly one JSON object per docs/protocol.md`;
    if (attempts >= maxAttempts) {
      return { round, fault: true, reason: result.reason, array, applied: false };
    }
  }
  // Unreachable in practice (loop always returns inside maxAttempts iterations), kept as a
  // defensive fallback so this function's contract ("always resolves, never throws") holds even
  // if the loop bound above is ever changed carelessly.
  return { round, fault: true, reason: "exhausted retries", array, applied: false };
}

/**
 * Run a full solo participant to completion (or until budget/array-length bounds stop it).
 * `callHandler` is the only side-effecting dependency, injected so tests never spawn a process.
 */
async function runSoloRun({ callHandler, initialArray, you, budget = DEFAULT_BUDGET, onRound = () => {} }) {
  if (initialArray.length > MAX_ARRAY_LEN) {
    throw new Error(`array length ${initialArray.length} exceeds MAX_ARRAY_LEN (${MAX_ARRAY_LEN})`);
  }
  let array = initialArray.slice();
  const history = [];
  const trace = [];
  let comparisons = 0;
  let swaps = 0;
  let faults = 0;
  let finishedCorrectly = false;
  let round = 0;
  const startedAt = Date.now();
  const inversionsOverTime = [countInversions(array)];

  // `onRound` fires synchronously right after each round resolves — CADS-DEMO-sort#12: a caller
  // that wants live per-round progress (server.js streaming NDJSON to the browser) taps this
  // instead of waiting for the full `trace` array a run below only assembles at the very end.
  const record = (entry) => {
    trace.push(entry);
    onRound(entry);
  };

  while (round < budget) {
    round++;
    const before = Date.now();
    const outcome = await runRound({
      callHandler,
      round,
      array,
      history,
      budgetRemaining: budget - round,
      mode: "solo",
      you,
    });
    const callMs = Date.now() - before;

    if (outcome.fault) {
      faults++;
      record({ round, action: "fault", reason: outcome.reason, callMs });
      continue; // array unchanged, budget still spent — per docs/protocol.md
    }
    if (outcome.done) {
      record({ round, action: "done", callMs, actuallySorted: outcome.actuallySorted });
      if (outcome.actuallySorted) {
        finishedCorrectly = true;
        break;
      }
      // Wrong "done" claim: not a protocol fault (the reply was well-formed), but it doesn't
      // end the run either — falls through to the next round with the array unchanged.
      continue;
    }
    const { move } = outcome;
    if (move.action === "compare") comparisons++;
    if (move.action === "swap") {
      swaps++;
      array = outcome.array;
      inversionsOverTime.push(countInversions(array));
    }
    history.push({ round, action: move.action, i: move.i, j: move.j, resultArray: array.slice() });
    record({ round, action: move.action, i: move.i, j: move.j, callMs });
  }

  return {
    you,
    finalArray: array,
    finishedCorrectly,
    comparisons,
    swaps,
    faults,
    roundsUsed: round,
    wallClockMs: Date.now() - startedAt,
    inversionsOverTime,
    trace,
  };
}

/**
 * Split `array` into `n` contiguous, near-equal segments, left segments absorbing the remainder
 * (length 100 split 3 ways -> 34, 33, 33, matching the natural way you'd hand out 100 items to 3
 * workers by hand). Pure and tiny on purpose — this is the one piece of partition mode's logic
 * worth unit-testing in isolation from the concurrency around it.
 */
function splitEven(array, n) {
  const len = array.length;
  const base = Math.floor(len / n);
  const rem = len % n;
  const segments = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < rem ? 1 : 0);
    segments.push({ start: offset, array: array.slice(offset, offset + size) });
    offset += size;
  }
  return segments;
}

/**
 * Partition mode: the array is split by POSITION (not by value) into one contiguous segment per
 * participant, and each sorts only its own segment — independently, concurrently, no shared
 * state, exactly like an independent solo run against a smaller array. Segments never overlap,
 * so — unlike race mode's N genuinely independent full-length arrays — every participant's
 * progress can legitimately be drawn into ONE shared picture at once: segment i always occupies
 * the same fixed slice of the whole array.
 *
 * Honesty matters here: because segments are split by position, not by value range, sorting
 * every segment individually does NOT generally make the reassembled whole array sorted (e.g.
 * segment 1 = [50,60,70], segment 2 = [10,20,30] — each internally sorted, concatenated is not).
 * `wholeArraySorted` reports the real answer rather than implying success from "every segment
 * finished correctly" — a real parallel/partitioned sort needs a merge phase afterward, which
 * this deliberately does not implement (out of scope; the point here is watching N segments sort
 * concurrently, not delivering a working parallel sort algorithm).
 */
async function runPartitionSession({ participants, initialArray, budget = DEFAULT_BUDGET, onRound = () => {} }) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error("runPartitionSession needs at least two participants");
  }
  if (initialArray.length > MAX_ARRAY_LEN) {
    throw new Error(`array length ${initialArray.length} exceeds MAX_ARRAY_LEN (${MAX_ARRAY_LEN})`);
  }
  if (initialArray.length < participants.length) {
    throw new Error(`array length ${initialArray.length} is smaller than the number of participants (${participants.length}) -- each needs at least one element`);
  }

  const segments = splitEven(initialArray, participants.length);

  const results = await Promise.all(
    participants.map((p, idx) => {
      const seg = segments[idx];
      return runSoloRun({
        you: p.you,
        initialArray: seg.array,
        budget,
        callHandler: p.callHandler,
        onRound: (entry) => onRound({ you: p.you, segmentStart: seg.start, segmentLength: seg.array.length, ...entry }),
      }).catch((e) => ({
        you: p.you,
        error: e.message || String(e),
        finishedCorrectly: false,
        finalArray: seg.array,
        roundsUsed: null,
        wallClockMs: null,
        comparisons: null,
        swaps: null,
        faults: null,
      }));
    })
  );

  const finalArray = results.flatMap((r) => r.finalArray || []);
  const perParticipant = results.map((r, idx) => ({
    you: r.you,
    segmentStart: segments[idx].start,
    segmentLength: segments[idx].array.length,
    finishedCorrectly: !!r.finishedCorrectly,
    roundsUsed: r.roundsUsed ?? null,
    wallClockMs: r.wallClockMs ?? null,
    comparisons: r.comparisons ?? null,
    swaps: r.swaps ?? null,
    faults: r.faults ?? null,
    error: r.error || null,
  }));

  return {
    initialArray,
    segments: segments.map((s, i) => ({ you: participants[i].you, start: s.start, length: s.array.length })),
    finalArray,
    wholeArraySorted: isSorted(finalArray),
    perParticipant,
  };
}

/**
 * Race mode (CADS-DEMO-sort redesign): same seed array handed to N participants, each running
 * an independent, unmodified solo session, fully concurrently -- none of them ever see each
 * other's moves. `participants` is an array of `{you, callHandler}`. `onRound(entry)` (optional)
 * fires for every round from every participant, already tagged with `you`, in whatever order
 * their real calls resolve in -- a caller streaming this to a browser taps it exactly like
 * runSoloRun's own onRound.
 *
 * Ranking: finished-correctly beats not-finished, then fewest roundsUsed, then fastest
 * wallClockMs. A participant whose callHandler rejects unexpectedly (not a protocol fault -- an
 * actual thrown/rejected error escaping runSoloRun, which shouldn't normally happen since
 * runSoloRun already turns handler failures into per-round faults) is recorded with an `error`
 * field and ranked last rather than aborting the whole race.
 */
async function runRaceSession({ participants, initialArray, budget = DEFAULT_BUDGET, onRound = () => {} }) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error("runRaceSession needs at least two participants");
  }
  if (initialArray.length > MAX_ARRAY_LEN) {
    throw new Error(`array length ${initialArray.length} exceeds MAX_ARRAY_LEN (${MAX_ARRAY_LEN})`);
  }

  const results = await Promise.all(
    participants.map((p) =>
      runSoloRun({
        you: p.you,
        initialArray,
        budget,
        callHandler: p.callHandler,
        onRound: (entry) => onRound({ you: p.you, ...entry }),
      }).catch((e) => ({ you: p.you, error: e.message || String(e), finishedCorrectly: false }))
    )
  );

  const ranked = results
    .map((r) => ({
      you: r.you,
      finishedCorrectly: !!r.finishedCorrectly,
      roundsUsed: r.roundsUsed ?? null,
      wallClockMs: r.wallClockMs ?? null,
      comparisons: r.comparisons ?? null,
      swaps: r.swaps ?? null,
      faults: r.faults ?? null,
      error: r.error || null,
    }))
    .sort((a, b) => {
      if (a.finishedCorrectly !== b.finishedCorrectly) return a.finishedCorrectly ? -1 : 1;
      if ((a.roundsUsed ?? Infinity) !== (b.roundsUsed ?? Infinity)) return (a.roundsUsed ?? Infinity) - (b.roundsUsed ?? Infinity);
      return (a.wallClockMs ?? Infinity) - (b.wallClockMs ?? Infinity);
    });

  return { initialArray, ranked, results };
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_TIMEOUT_MS,
  HISTORY_CAP,
  MAX_ARRAY_LEN,
  MAX_CORRECTIONS,
  countInversions,
  isSorted,
  validateMove,
  applyMove,
  buildRoundInput,
  parseHandlerOutput,
  runRound,
  runSoloRun,
  runRaceSession,
  splitEven,
  runPartitionSession,
};
