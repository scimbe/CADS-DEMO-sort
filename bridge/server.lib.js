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
      correction = `your last reply could not be read (${e.message || e}) — reply with exactly one JSON object`;
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
 * Run a relay/cooperative round: one shared array, every currently-online participant gets
 * exactly one move in rotation. `participants` is an array of `{you, callHandler}`; the online
 * set may change between calls (a participant can appear/disappear) — this function only ever
 * looks at the array passed to it on that call, so a caller drives the "who's online now" policy
 * from outside and this stays pure/testable (CADS-DEMO-sort#3).
 *
 * Per-participant scoring accumulates across calls via the `scores` map the caller owns and
 * passes back in — this function mutates it in place (adds comparisons/swaps/faults for whoever
 * moved this tick) and also returns it, so both call styles (ignore the return, or treat it as
 * pure and reassign) work.
 */
async function runRelayTick({ participants, array, history, budgetRemaining, tickNumber, scores }) {
  let currentArray = array.slice();
  const tickHistory = history.slice();
  const events = [];

  for (const participant of participants) {
    if (!scores.has(participant.you)) {
      scores.set(participant.you, { comparisons: 0, swaps: 0, faults: 0, movesTaken: 0 });
    }
    const s = scores.get(participant.you);
    const outcome = await runRound({
      callHandler: participant.callHandler,
      round: tickNumber,
      array: currentArray,
      history: tickHistory,
      budgetRemaining,
      mode: "relay",
      you: participant.you,
    });

    if (outcome.fault) {
      s.faults++;
      events.push({ tick: tickNumber, you: participant.you, action: "fault", reason: outcome.reason });
      continue;
    }
    if (outcome.done) {
      events.push({ tick: tickNumber, you: participant.you, action: "done", actuallySorted: outcome.actuallySorted });
      continue;
    }
    const { move } = outcome;
    s.movesTaken++;
    if (move.action === "compare") s.comparisons++;
    if (move.action === "swap") {
      s.swaps++;
      currentArray = outcome.array;
    }
    const historyEntry = { round: tickNumber, you: participant.you, action: move.action, i: move.i, j: move.j, resultArray: currentArray.slice() };
    tickHistory.push(historyEntry);
    events.push({ tick: tickNumber, you: participant.you, ...historyEntry });
  }

  return {
    array: currentArray,
    history: tickHistory.slice(-HISTORY_CAP),
    events,
    scores,
    inversions: countInversions(currentArray),
    sorted: isSorted(currentArray),
  };
}

/**
 * Run a full relay session to completion (sorted, or budget exhausted). `getOnlineParticipants()`
 * is called once per tick so the caller can change who's online between ticks without this
 * function needing to know why (join/leave is entirely the caller's concern).
 */
async function runRelaySession({ getOnlineParticipants, initialArray, budget = DEFAULT_BUDGET }) {
  if (initialArray.length > MAX_ARRAY_LEN) {
    throw new Error(`array length ${initialArray.length} exceeds MAX_ARRAY_LEN (${MAX_ARRAY_LEN})`);
  }
  let array = initialArray.slice();
  let history = [];
  const scores = new Map();
  const allEvents = [];
  let tick = 0;
  const startedAt = Date.now();
  const inversionsOverTime = [countInversions(array)];

  while (tick < budget) {
    const online = getOnlineParticipants();
    if (!online || online.length === 0) break; // nobody left to move — session ends, not a fault
    tick++;
    const result = await runRelayTick({
      participants: online,
      array,
      history,
      budgetRemaining: budget - tick,
      tickNumber: tick,
      scores,
    });
    array = result.array;
    history = result.history;
    allEvents.push(...result.events);
    inversionsOverTime.push(result.inversions);
    if (result.sorted) break;
  }

  const perParticipant = {};
  for (const [you, s] of scores.entries()) perParticipant[you] = s;

  return {
    finalArray: array,
    finishedCorrectly: isSorted(array),
    ticksUsed: tick,
    wallClockMs: Date.now() - startedAt,
    inversionsOverTime,
    perParticipant,
    events: allEvents,
  };
}

/**
 * Race mode (CADS-DEMO-sort redesign): same seed array handed to N participants, each running
 * an independent, unmodified solo session -- unlike relay, they never see each other's moves, and
 * unlike relay's tick-by-tick shared array they run fully concurrently. `participants` is an
 * array of `{you, callHandler}`, same shape runRelaySession takes. `onRound(entry)` (optional)
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
  runRelayTick,
  runRelaySession,
  runRaceSession,
};
