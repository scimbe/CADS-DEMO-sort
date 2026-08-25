"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  countInversions,
  isSorted,
  validateMove,
  applyMove,
  parseHandlerOutput,
  runRound,
  runSoloRun,
  runRaceSession,
  splitEven,
  runPartitionSession,
  MAX_ARRAY_LEN,
} = require("./server.lib.js");

test("countInversions: sorted array has zero", () => {
  assert.equal(countInversions([1, 2, 3, 4]), 0);
});

test("countInversions: fully reversed array has n*(n-1)/2", () => {
  assert.equal(countInversions([4, 3, 2, 1]), 6);
});

test("isSorted", () => {
  assert.equal(isSorted([1, 2, 3]), true);
  assert.equal(isSorted([1, 3, 2]), false);
  assert.equal(isSorted([]), true);
  assert.equal(isSorted([5]), true);
});

test("validateMove: accepts a well-formed compare", () => {
  const r = validateMove({ action: "compare", i: 0, j: 1 }, 4);
  assert.deepEqual(r, { ok: true, move: { action: "compare", i: 0, j: 1 } });
});

test("validateMove: accepts a well-formed swap", () => {
  const r = validateMove({ action: "swap", i: 2, j: 3 }, 4);
  assert.deepEqual(r, { ok: true, move: { action: "swap", i: 2, j: 3 } });
});

test("validateMove: accepts done", () => {
  const r = validateMove({ action: "done" }, 4);
  assert.deepEqual(r, { ok: true, move: { action: "done" } });
});

test("validateMove: rejects non-object replies", () => {
  assert.equal(validateMove(null, 4).ok, false);
  assert.equal(validateMove("swap", 4).ok, false);
  assert.equal(validateMove(42, 4).ok, false);
  assert.equal(validateMove([1, 2], 4).ok, false);
  assert.equal(validateMove(undefined, 4).ok, false);
});

test("validateMove: rejects unknown action", () => {
  const r = validateMove({ action: "sort_everything_now" }, 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown action/);
});

test("validateMove: rejects non-integer i/j", () => {
  assert.equal(validateMove({ action: "swap", i: 0.5, j: 1 }, 4).ok, false);
  assert.equal(validateMove({ action: "swap", i: "0", j: 1 }, 4).ok, false);
  assert.equal(validateMove({ action: "swap", i: null, j: 1 }, 4).ok, false);
  assert.equal(validateMove({ action: "swap" }, 4).ok, false);
});

test("validateMove: rejects out-of-range i/j", () => {
  assert.equal(validateMove({ action: "swap", i: -1, j: 1 }, 4).ok, false);
  assert.equal(validateMove({ action: "swap", i: 0, j: 4 }, 4).ok, false);
  assert.equal(validateMove({ action: "swap", i: 0, j: 100 }, 4).ok, false);
});

test("validateMove: rejects i === j", () => {
  const r = validateMove({ action: "swap", i: 2, j: 2 }, 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /differ/);
});

test("applyMove: swap exchanges two positions and does not mutate the input", () => {
  const arr = [10, 20, 30];
  const next = applyMove(arr, { action: "swap", i: 0, j: 2 });
  assert.deepEqual(next, [30, 20, 10]);
  assert.deepEqual(arr, [10, 20, 30], "input array must not be mutated");
});

test("applyMove: compare does not change the array", () => {
  const arr = [10, 20, 30];
  const next = applyMove(arr, { action: "compare", i: 0, j: 2 });
  assert.deepEqual(next, arr);
});

test("parseHandlerOutput: empty stdout is a fault, not a throw", () => {
  const r = parseHandlerOutput("", 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no output/);
});

test("parseHandlerOutput: prose instead of JSON is a fault, not a throw", () => {
  const r = parseHandlerOutput("I think we should swap 0 and 1!", 4);
  assert.equal(r.ok, false);
});

test("parseHandlerOutput: markdown-fenced JSON is rejected (protocol requires bare JSON, no fences)", () => {
  const r = parseHandlerOutput('```json\n{"action":"swap","i":0,"j":1}\n```', 4);
  assert.equal(r.ok, false, "fenced output does not conform to the strict contract — this is intentional");
});

test("parseHandlerOutput: valid JSON with trailing whitespace/newline is accepted", () => {
  const r = parseHandlerOutput('  {"action":"compare","i":0,"j":1}\n', 4);
  assert.equal(r.ok, true);
});

// ---- runRound: the fault-retry contract ----

test("runRound: a handler that always returns garbage never throws, resolves as a fault after retries", async () => {
  let calls = 0;
  const callHandler = async () => {
    calls++;
    return "not json at all";
  };
  const outcome = await runRound({
    callHandler,
    round: 1,
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "chaos-agent",
  });
  assert.equal(outcome.fault, true);
  assert.equal(outcome.applied, false);
  assert.equal(calls, 3, "1 initial attempt + 2 corrections per docs/protocol.md");
});

test("runRound: a handler that hangs (rejects with a timeout-shaped error) is a fault, not an unhandled rejection", async () => {
  const callHandler = async () => {
    throw new Error("role command timed out after 30s");
  };
  const outcome = await runRound({
    callHandler,
    round: 1,
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "hanging-agent",
  });
  assert.equal(outcome.fault, true);
  assert.match(outcome.reason, /timed out/);
});

test("runRound: a handler that self-corrects on the 2nd attempt succeeds (fault machinery doesn't over-penalize a recoverable mistake)", async () => {
  let calls = 0;
  const callHandler = async (input) => {
    calls++;
    if (calls === 1) return "garbage";
    assert.ok(input.correction, "the 2nd call must receive a correction explaining the rejection");
    return JSON.stringify({ action: "swap", i: 0, j: 1 });
  };
  const outcome = await runRound({
    callHandler,
    round: 1,
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "self-correcting-agent",
  });
  assert.equal(outcome.fault, undefined);
  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.array, [1, 3, 2]);
});

test("runRound: a well-formed but out-of-range move is a fault, exactly like garbage output", async () => {
  const callHandler = async () => JSON.stringify({ action: "swap", i: 0, j: 99 });
  const outcome = await runRound({
    callHandler,
    round: 1,
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "out-of-range-agent",
  });
  assert.equal(outcome.fault, true);
});

test("runRound: done is reported with whether the array is ACTUALLY sorted, not trusted from the reply", async () => {
  const callHandler = async () => JSON.stringify({ action: "done" });
  const outcomeWrong = await runRound({
    callHandler,
    round: 1,
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "overconfident-agent",
  });
  assert.equal(outcomeWrong.done, true);
  assert.equal(outcomeWrong.actuallySorted, false);

  const outcomeRight = await runRound({
    callHandler,
    round: 1,
    array: [1, 2, 3],
    history: [],
    budgetRemaining: 10,
    mode: "solo",
    you: "correct-agent",
  });
  assert.equal(outcomeRight.actuallySorted, true);
});

// ---- runSoloRun: end-to-end, using stub handlers instead of real processes ----

test("runSoloRun: a perfectly-behaved insertion-sort-shaped handler finishes correctly with zero faults", async () => {
  // A tiny scripted "handler" that always picks the first out-of-order adjacent pair.
  const callHandler = async (input) => {
    const arr = input.array;
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] > arr[i + 1]) {
        return JSON.stringify({ action: "swap", i, j: i + 1 });
      }
    }
    return JSON.stringify({ action: "done" });
  };
  const result = await runSoloRun({ callHandler, initialArray: [5, 3, 8, 1, 9, 2], you: "bubble-ish", budget: 200 });
  assert.equal(result.finishedCorrectly, true);
  assert.deepEqual(result.finalArray, [1, 2, 3, 5, 8, 9]);
  assert.equal(result.faults, 0);
  assert.equal(result.inversionsOverTime[result.inversionsOverTime.length - 1], 0);
});

test("runSoloRun: onRound fires once per round, in order, as each round resolves — not all at once at the end (CADS-DEMO-sort#12)", async () => {
  const callHandler = async (input) => {
    const arr = input.array;
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] > arr[i + 1]) return JSON.stringify({ action: "swap", i, j: i + 1 });
    }
    return JSON.stringify({ action: "done" });
  };
  const seenBeforeFinish = [];
  const result = await runSoloRun({
    callHandler,
    initialArray: [3, 2, 1],
    you: "streamed",
    budget: 200,
    onRound: (entry) => seenBeforeFinish.push({ ...entry }),
  });
  // The whole point of onRound: every trace entry was ALSO delivered incrementally, in the same
  // order, not just assembled into result.trace after the loop already finished.
  assert.deepEqual(seenBeforeFinish, result.trace);
  assert.ok(seenBeforeFinish.length > 0);
  assert.equal(seenBeforeFinish[0].round, 1);
});

test("runSoloRun: onRound is optional — omitting it behaves exactly as before (no crash, same result shape)", async () => {
  const callHandler = async () => JSON.stringify({ action: "done" });
  const result = await runSoloRun({ callHandler, initialArray: [1, 2], you: "no-listener", budget: 5 });
  assert.equal(result.finishedCorrectly, true);
});

test("runSoloRun: a maximally chaotic handler (always garbage) never crashes the run — it just burns its whole budget as faults", async () => {
  const callHandler = async () => "give me an F";
  const budget = 15;
  const result = await runSoloRun({ callHandler, initialArray: [3, 1, 2], you: "chaos-agent", budget });
  assert.equal(result.finishedCorrectly, false);
  assert.equal(result.faults, budget);
  assert.equal(result.roundsUsed, budget);
  assert.deepEqual(result.finalArray, [3, 1, 2], "array must be unchanged — every round was a fault");
});

test("runSoloRun: a handler that throws on every call (simulated process-spawn failure) still resolves a scored result", async () => {
  const callHandler = async () => {
    throw new Error("spawn ENOENT");
  };
  const result = await runSoloRun({ callHandler, initialArray: [2, 1], you: "broken-agent", budget: 5 });
  assert.equal(result.faults, 5);
  assert.equal(result.finishedCorrectly, false);
});

test("runSoloRun: rejects an initial array over MAX_ARRAY_LEN before making any handler calls", async () => {
  const tooLong = Array.from({ length: MAX_ARRAY_LEN + 1 }, (_, i) => i);
  let called = false;
  const callHandler = async () => {
    called = true;
    return JSON.stringify({ action: "done" });
  };
  await assert.rejects(() => runSoloRun({ callHandler, initialArray: tooLong, you: "x", budget: 10 }));
  assert.equal(called, false);
});

test("runSoloRun: history sent to the handler is capped, even after many moves", async () => {
  let maxHistorySeen = 0;
  const callHandler = async (input) => {
    maxHistorySeen = Math.max(maxHistorySeen, input.history.length);
    // alternate two adjacent swaps forever so the run consumes its whole budget with real moves
    return JSON.stringify({ action: "swap", i: 0, j: 1 });
  };
  await runSoloRun({ callHandler, initialArray: [1, 2], you: "swapper", budget: 50 });
  assert.ok(maxHistorySeen <= 20, `history must be capped at 20, saw ${maxHistorySeen}`);
});

// "Stop" didn't stop (real, reproduced bug): a client disconnect used to leave this loop
// dispatching real rounds to the participant's own channel for the rest of its budget with
// nobody left to read them. isAborted is the fix -- see its own comment above runSoloRun for why
// this matters beyond "wasted rounds": an orphaned run left in flight against the SAME
// participant as a NEW run interleaves both over that participant's one physical channel, which
// reads as a broken/nondeterministic handler and is very hard to tell apart from an actual bug.
test("runSoloRun: isAborted stops dispatching new rounds instead of running to budget", async () => {
  let calls = 0;
  const callHandler = async () => {
    calls++;
    return JSON.stringify({ action: "swap", i: 0, j: 1 }); // never claims done on its own
  };
  const result = await runSoloRun({
    callHandler,
    initialArray: [2, 1],
    you: "would-run-forever",
    budget: 1000,
    isAborted: () => calls >= 5,
  });
  assert.equal(calls, 5, "callHandler must never be invoked again once isAborted() has tripped");
  assert.equal(result.roundsUsed, 5, "the run must stop where it was aborted, not burn its full 1000-round budget");
  assert.equal(result.finishedCorrectly, false);
});

test("runSoloRun: isAborted is optional — omitting it behaves exactly as before (runs to budget/done)", async () => {
  const callHandler = async () => JSON.stringify({ action: "done" });
  const result = await runSoloRun({ callHandler, initialArray: [1], you: "no-abort-listener", budget: 5 });
  assert.equal(result.finishedCorrectly, true);
});

test("runSoloRun: an abort that lands after the very first round still stops before a second dispatch", async () => {
  let calls = 0;
  const callHandler = async () => {
    calls++;
    return JSON.stringify({ action: "swap", i: 0, j: 1 });
  };
  const result = await runSoloRun({
    callHandler,
    initialArray: [2, 1],
    you: "aborted-immediately",
    budget: 1000,
    isAborted: () => calls >= 1,
  });
  assert.equal(calls, 1);
  assert.equal(result.roundsUsed, 1);
});

test("runRaceSession: isAborted is forwarded to every participant's underlying runSoloRun", async () => {
  let aborted = false;
  const makeHandler = () => async () => JSON.stringify({ action: "swap", i: 0, j: 1 });
  const resultPromise = runRaceSession({
    participants: [
      { you: "a", callHandler: makeHandler() },
      { you: "b", callHandler: makeHandler() },
    ],
    initialArray: [2, 1],
    budget: 1000,
    isAborted: () => aborted,
  });
  // Flip it almost immediately -- both participants must stop within a handful of rounds each,
  // nowhere near the 1000-round budget, proving the flag reached both underlying runSoloRun calls.
  aborted = true;
  const result = await resultPromise;
  for (const r of result.results) {
    assert.ok(r.roundsUsed < 50, `"${r.you}" ran ${r.roundsUsed} rounds after abort — isAborted was not forwarded`);
  }
});

test("runPartitionSession: isAborted is forwarded to every participant's underlying runSoloRun", async () => {
  let aborted = false;
  const makeHandler = () => async () => JSON.stringify({ action: "swap", i: 0, j: 1 });
  const resultPromise = runPartitionSession({
    participants: [
      { you: "a", callHandler: makeHandler() },
      { you: "b", callHandler: makeHandler() },
    ],
    initialArray: [4, 3, 2, 1],
    budget: 1000,
    isAborted: () => aborted,
  });
  aborted = true;
  const result = await resultPromise;
  for (const p of result.perParticipant) {
    assert.ok(p.roundsUsed < 50, `"${p.you}" ran ${p.roundsUsed} rounds after abort — isAborted was not forwarded`);
  }
});

// ---- race mode: same seed array, independent concurrent solo runs, ranked ----

test("runRaceSession: requires at least two participants", async () => {
  await assert.rejects(
    () => runRaceSession({ participants: [{ you: "solo", callHandler: async () => JSON.stringify({ action: "done" }) }], initialArray: [1, 2], budget: 5 }),
    /at least two participants/
  );
});

test("runRaceSession: a faster participant (fewer rounds) ranks above a slower one that also finishes correctly", async () => {
  // Real selection sort: swap the correct value directly into the next unsorted position
  // (non-adjacent swaps are legal per docs/protocol.md), needing at most n-1 swaps total --
  // genuinely fewer rounds than "slow"'s adjacent-pair-only strategy on the same array.
  const fast = {
    you: "fast",
    callHandler: async (input) => {
      const arr = input.array;
      const target = [...arr].sort((a, b) => a - b);
      let p = 0;
      while (p < arr.length && arr[p] === target[p]) p++;
      if (p >= arr.length) return JSON.stringify({ action: "done" });
      const idx = arr.indexOf(target[p], p);
      return JSON.stringify({ action: "swap", i: p, j: idx });
    },
  };
  const slow = {
    you: "slow",
    callHandler: async (input) => {
      const arr = input.array;
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i] > arr[i + 1]) return JSON.stringify({ action: "swap", i, j: i + 1 });
      }
      return JSON.stringify({ action: "done" });
    },
  };
  const result = await runRaceSession({ participants: [slow, fast], initialArray: [5, 3, 8, 1, 9, 2], budget: 200 });
  assert.equal(result.ranked[0].you, "fast", "fewer roundsUsed must rank first");
  assert.ok(result.ranked[0].finishedCorrectly);
  assert.ok(result.ranked[1].finishedCorrectly);
  assert.ok(result.ranked[0].roundsUsed <= result.ranked[1].roundsUsed);
});

test("runRaceSession: a participant that finishes correctly always outranks one that never finishes, regardless of rounds", async () => {
  const winner = {
    you: "winner",
    callHandler: async () => JSON.stringify({ action: "done" }),
  };
  const chaos = { you: "chaos", callHandler: async () => "garbage forever" };
  const result = await runRaceSession({ participants: [chaos, winner], initialArray: [1, 2], budget: 10 });
  assert.equal(result.ranked[0].you, "winner");
  assert.equal(result.ranked[1].you, "chaos");
  assert.equal(result.ranked[1].finishedCorrectly, false);
});

test("runRaceSession: both participants race the SAME initial array (identical starting conditions)", async () => {
  const seenArrays = [];
  const makeHandler = (you) => ({
    you,
    callHandler: async (input) => {
      seenArrays.push(JSON.stringify(input.array));
      return JSON.stringify({ action: "done" });
    },
  });
  await runRaceSession({ participants: [makeHandler("a"), makeHandler("b")], initialArray: [4, 2, 1], budget: 5 });
  assert.equal(new Set(seenArrays).size, 1, "both participants must see the identical initial array");
});

test("runRaceSession: onRound fires for every participant's rounds, each tagged with the right `you`, without waiting for the whole race to finish", async () => {
  const makeHandler = (you, delayMs) => ({
    you,
    callHandler: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return JSON.stringify({ action: "done" });
    },
  });
  const seen = [];
  await runRaceSession({
    participants: [makeHandler("slow", 20), makeHandler("fast", 0)],
    initialArray: [1, 2],
    budget: 5,
    onRound: (entry) => seen.push(entry),
  });
  assert.ok(seen.some((e) => e.you === "slow"));
  assert.ok(seen.some((e) => e.you === "fast"));
  // the fast participant's (only) round event must have been delivered before the slow one's,
  // proving events aren't buffered until Promise.all resolves for everyone
  const fastIdx = seen.findIndex((e) => e.you === "fast");
  const slowIdx = seen.findIndex((e) => e.you === "slow");
  assert.ok(fastIdx < slowIdx, "fast participant's round event should arrive before the slow one's");
});

test("runRaceSession: a callHandler that throws synchronously (real spawn failure, not a protocol fault) doesn't abort the whole race", async () => {
  const broken = { you: "broken", callHandler: async () => { throw new Error("spawn ENOENT"); } };
  const fine = { you: "fine", callHandler: async () => JSON.stringify({ action: "done" }) };
  const result = await runRaceSession({ participants: [broken, fine], initialArray: [1, 2], budget: 5 });
  assert.equal(result.ranked.find((r) => r.you === "fine").finishedCorrectly, true);
  // runSoloRun already turns handler failures into per-round faults rather than rejecting, so
  // "broken" still resolves a normal (if all-faults) result here, not an `error` entry -- this
  // test's real purpose is confirming one participant's misbehavior never takes the other down.
  assert.ok(result.ranked.find((r) => r.you === "broken"));
});

// ---- partition mode: split by position, each participant sorts only its own segment ----

test("splitEven: 100 elements split 3 ways gives 34/33/33, left segments absorbing the remainder", () => {
  const segments = splitEven(Array.from({ length: 100 }, (_, i) => i), 3);
  assert.deepEqual(segments.map((s) => s.array.length), [34, 33, 33]);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].start, 34);
  assert.equal(segments[2].start, 67);
  // contiguous and non-overlapping: concatenating the segments recovers the original array
  assert.deepEqual(segments.flatMap((s) => s.array), Array.from({ length: 100 }, (_, i) => i));
});

test("splitEven: an exact multiple splits perfectly even with no remainder", () => {
  const segments = splitEven(Array.from({ length: 9 }, (_, i) => i), 3);
  assert.deepEqual(segments.map((s) => s.array.length), [3, 3, 3]);
});

test("runPartitionSession: requires at least two participants", async () => {
  await assert.rejects(
    () => runPartitionSession({ participants: [{ you: "solo", callHandler: async () => JSON.stringify({ action: "done" }) }], initialArray: [1, 2], budget: 5 }),
    /at least two participants/
  );
});

test("runPartitionSession: rejects fewer array elements than participants", async () => {
  const p = { you: "x", callHandler: async () => JSON.stringify({ action: "done" }) };
  await assert.rejects(
    () => runPartitionSession({ participants: [p, p, p], initialArray: [1, 2], budget: 5 }),
    /smaller than the number of participants/
  );
});

test("runPartitionSession: each participant only ever sees its OWN segment, never the whole array", async () => {
  const seenArrays = { a: [], b: [] };
  const makeHandler = (you) => ({
    you,
    callHandler: async (input) => {
      seenArrays[you].push(input.array.slice());
      return JSON.stringify({ action: "done" });
    },
  });
  await runPartitionSession({
    participants: [makeHandler("a"), makeHandler("b")],
    initialArray: [5, 3, 8, 1, 9, 2],
    budget: 5,
  });
  assert.deepEqual(seenArrays.a[0], [5, 3, 8], "first segment gets the first 3 elements");
  assert.deepEqual(seenArrays.b[0], [1, 9, 2], "second segment gets the remaining 3 elements");
});

test("runPartitionSession: two participants that each sort their own segment reassemble into a fully sorted array here (segments happen to already be range-ordered)", async () => {
  const makeSelectionSorter = (you) => ({
    you,
    callHandler: async (input) => {
      const arr = input.array;
      for (let i = 0; i < arr.length - 1; i++) {
        let m = i;
        for (let k = i + 1; k < arr.length; k++) if (arr[k] < arr[m]) m = k;
        if (m !== i) return JSON.stringify({ action: "swap", i, j: m });
      }
      return JSON.stringify({ action: "done" });
    },
  });
  // Deliberately range-partitioned input: segment 1 is entirely smaller than segment 2, so
  // sorting each independently DOES yield a globally sorted whole here -- the honest opposite
  // case (position-partitioned, NOT range-partitioned) is covered by the next test.
  const result = await runPartitionSession({
    participants: [makeSelectionSorter("lo"), makeSelectionSorter("hi")],
    initialArray: [3, 1, 2, 60, 40, 50],
    budget: 20,
  });
  assert.equal(result.perParticipant[0].finishedCorrectly, true);
  assert.equal(result.perParticipant[1].finishedCorrectly, true);
  assert.deepEqual(result.finalArray, [1, 2, 3, 40, 50, 60]);
  assert.equal(result.wholeArraySorted, true);
});

test("runPartitionSession: every segment individually sorted does NOT imply the reassembled whole array is sorted (position-partitioned, not range-partitioned)", async () => {
  const makeSelectionSorter = (you) => ({
    you,
    callHandler: async (input) => {
      const arr = input.array;
      for (let i = 0; i < arr.length - 1; i++) {
        let m = i;
        for (let k = i + 1; k < arr.length; k++) if (arr[k] < arr[m]) m = k;
        if (m !== i) return JSON.stringify({ action: "swap", i, j: m });
      }
      return JSON.stringify({ action: "done" });
    },
  });
  // segment 1 = [60,70,50] (all LARGE values), segment 2 = [1,2,0] (all SMALL values) -- each
  // sorts perfectly on its own, but concatenated the whole is nowhere close to sorted.
  const result = await runPartitionSession({
    participants: [makeSelectionSorter("first"), makeSelectionSorter("second")],
    initialArray: [60, 70, 50, 1, 2, 0],
    budget: 20,
  });
  assert.equal(result.perParticipant[0].finishedCorrectly, true);
  assert.equal(result.perParticipant[1].finishedCorrectly, true);
  assert.deepEqual(result.finalArray, [50, 60, 70, 0, 1, 2]);
  assert.equal(result.wholeArraySorted, false, "every segment sorted individually is NOT the same as the whole array being sorted");
});

test("runPartitionSession: onRound tags every event with its participant AND that segment's global offset", async () => {
  const makeHandler = (you) => ({
    you,
    callHandler: async (input) => JSON.stringify({ action: "swap", i: 0, j: input.array.length - 1 }),
  });
  const seen = [];
  await runPartitionSession({
    participants: [makeHandler("a"), makeHandler("b")],
    initialArray: [4, 3, 2, 1],
    budget: 1,
    onRound: (entry) => seen.push(entry),
  });
  const aEvent = seen.find((e) => e.you === "a");
  const bEvent = seen.find((e) => e.you === "b");
  assert.equal(aEvent.segmentStart, 0);
  assert.equal(bEvent.segmentStart, 2);
});

test("runPartitionSession: a broken participant's segment never sorting doesn't take the other segments down", async () => {
  // runSoloRun already turns a throwing callHandler into per-round faults rather than
  // rejecting (confirmed by the equivalent runRaceSession test above), so this segment
  // resolves normally here too -- just never finishing, budget spent as faults.
  const broken = { you: "broken", callHandler: async () => { throw new Error("spawn ENOENT"); } };
  const fine = {
    you: "fine",
    callHandler: async (input) => {
      const arr = input.array;
      for (let i = 0; i < arr.length - 1; i++) if (arr[i] > arr[i + 1]) return JSON.stringify({ action: "swap", i, j: i + 1 });
      return JSON.stringify({ action: "done" });
    },
  };
  const result = await runPartitionSession({ participants: [broken, fine], initialArray: [9, 1, 8, 2], budget: 5 });
  assert.equal(result.perParticipant[1].finishedCorrectly, true);
  assert.equal(result.perParticipant[0].finishedCorrectly, false);
  assert.equal(result.perParticipant[0].faults, 5, "the broken segment burns its whole budget as faults, not silently vanishing");
});
