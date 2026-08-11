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
  runRelayTick,
  runRelaySession,
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

// ---- relay mode (CADS-DEMO-sort#3): shared array, round-robin, per-participant attribution ----

test("runRelayTick: two participants each get exactly one move, array reflects both in order", async () => {
  const alice = {
    you: "alice",
    callHandler: async (input) => JSON.stringify({ action: "swap", i: 0, j: 1 }),
  };
  const bob = {
    you: "bob",
    callHandler: async (input) => JSON.stringify({ action: "swap", i: 1, j: 2 }),
  };
  const scores = new Map();
  const result = await runRelayTick({
    participants: [alice, bob],
    array: [3, 1, 2],
    history: [],
    budgetRemaining: 10,
    tickNumber: 1,
    scores,
  });
  // alice swaps(0,1): [3,1,2] -> [1,3,2]; then bob swaps(1,2) on that result: [1,3,2] -> [1,2,3]
  assert.deepEqual(result.array, [1, 2, 3]);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].you, "alice");
  assert.equal(result.events[1].you, "bob");
  assert.equal(scores.get("alice").swaps, 1);
  assert.equal(scores.get("bob").swaps, 1);
});

test("runRelayTick: a fault from one participant doesn't block the next participant's turn", async () => {
  const chaos = { you: "chaos", callHandler: async () => "nonsense" };
  const steady = { you: "steady", callHandler: async () => JSON.stringify({ action: "swap", i: 0, j: 1 }) };
  const scores = new Map();
  const result = await runRelayTick({
    participants: [chaos, steady],
    array: [2, 1],
    history: [],
    budgetRemaining: 10,
    tickNumber: 1,
    scores,
  });
  assert.equal(scores.get("chaos").faults, 1);
  assert.equal(scores.get("steady").swaps, 1);
  assert.deepEqual(result.array, [1, 2]);
});

test("runRelayTick: history passed to the SECOND participant already includes the first's move (relay, not parallel)", async () => {
  let bobSawHistoryLength = null;
  const alice = { you: "alice", callHandler: async () => JSON.stringify({ action: "swap", i: 0, j: 1 }) };
  const bob = {
    you: "bob",
    callHandler: async (input) => {
      bobSawHistoryLength = input.history.length;
      assert.equal(input.mode, "relay");
      assert.equal(input.you, "bob");
      return JSON.stringify({ action: "done" });
    },
  };
  await runRelayTick({
    participants: [alice, bob],
    array: [2, 1],
    history: [],
    budgetRemaining: 10,
    tickNumber: 1,
    scores: new Map(),
  });
  assert.equal(bobSawHistoryLength, 1, "bob must see alice's move from the same tick");
});

test("runRelaySession: converges to sorted with two complementary participants and attributes scores per-agent", async () => {
  // Each participant only ever looks at adjacent pairs starting from its own fixed offset —
  // together they cover the whole array, like two workers splitting a bubble-sort pass.
  const makeAdjacentFixer = (you, startAt) => ({
    you,
    callHandler: async (input) => {
      const arr = input.array;
      for (let i = startAt; i < arr.length - 1; i += 2) {
        if (arr[i] > arr[i + 1]) return JSON.stringify({ action: "swap", i, j: i + 1 });
      }
      return JSON.stringify({ action: "done" });
    },
  });
  const evens = makeAdjacentFixer("evens", 0);
  const odds = makeAdjacentFixer("odds", 1);
  const result = await runRelaySession({
    getOnlineParticipants: () => [evens, odds],
    initialArray: [5, 3, 8, 1, 9, 2, 7, 4],
    budget: 100,
  });
  assert.equal(result.finishedCorrectly, true);
  assert.deepEqual(result.finalArray, [1, 2, 3, 4, 5, 7, 8, 9]);
  assert.ok(result.perParticipant.evens, "evens must have an accumulated score");
  assert.ok(result.perParticipant.odds, "odds must have an accumulated score");
});

test("runRelaySession: an online set that changes between ticks (leave mid-run) doesn't crash the session", async () => {
  let tickCount = 0;
  const leaver = { you: "leaver", callHandler: async () => JSON.stringify({ action: "swap", i: 0, j: 1 }) };
  const stayer = { you: "stayer", callHandler: async () => JSON.stringify({ action: "done" }) };
  const result = await runRelaySession({
    getOnlineParticipants: () => {
      tickCount++;
      // leaver is online for tick 1 only, then leaves; stayer is online throughout
      return tickCount === 1 ? [leaver, stayer] : [stayer];
    },
    initialArray: [2, 1],
    budget: 20,
  });
  assert.equal(result.finishedCorrectly, true);
  assert.ok(result.perParticipant.leaver, "leaver's tick-1 contribution must still be scored");
});

test("runRelaySession: an empty online set ends the session cleanly instead of looping forever", async () => {
  const result = await runRelaySession({
    getOnlineParticipants: () => [],
    initialArray: [3, 1, 2],
    budget: 50,
  });
  assert.equal(result.ticksUsed, 0);
  assert.deepEqual(result.finalArray, [3, 1, 2]);
});
