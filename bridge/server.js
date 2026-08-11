#!/usr/bin/env node
"use strict";

/**
 * Sort Arena bridge — HTTP + real process spawning (CADS-DEMO-sort#2/#3).
 *
 * The browser never supplies a handler command — every participant's shell command is
 * operator-configured (env var / config file), read once at startup. This is the same
 * discipline CADS-flappy-demo's bridge uses (CREW_PHYSICS_CMD etc. are env vars, never
 * request bodies) and it's not optional here: accepting an arbitrary command string over HTTP
 * would be remote code execution, not a "trust the sorting strategy" trade-off.
 *
 * Env:
 *   SORT_BRIDGE_LISTEN       - default 0.0.0.0:8789
 *   SORT_PARTICIPANTS_JSON   - JSON array of {"you": "<id>", "label": "<display name>", "cmd": "<shell command, stdin/stdout per docs/protocol.md>"}
 *   SORT_PARTICIPANTS_FILE   - path to a JSON file with the same shape (checked if the env var above is unset)
 *   SORT_ROUND_TIMEOUT_MS    - per-round handler timeout (default 30000, per docs/protocol.md)
 *   SORT_BUDGET              - default round/tick budget (default 200, per docs/protocol.md)
 *
 * Every run/race/partition endpoint also accepts a per-request `?budget=N` query param
 * (clamped to [10, 2000]), overriding SORT_BUDGET for that one call -- bubble sort's O(n^2)
 * worst case can exceed the 200-round default at the max array length on an unlucky seed.
 */

const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
  DEFAULT_BUDGET,
  DEFAULT_TIMEOUT_MS,
  MAX_ARRAY_LEN,
  runSoloRun,
  runRaceSession,
  runPartitionSession,
} = require("./server.lib.js");

const LISTEN = process.env.SORT_BRIDGE_LISTEN || "0.0.0.0:8789";
const TIMEOUT_MS = Number(process.env.SORT_ROUND_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const BUDGET = Number(process.env.SORT_BUDGET || DEFAULT_BUDGET);
// This coached bubble sort visits a full-length pass every time with no shrink optimization, so
// its real worst case is (n-1)^2 rounds, not just "O(n^2) inversions" -- at MAX_ARRAY_LEN (24)
// that's up to ~530, confirmed live (a real 24-element run still hadn't finished at budget=400).
// Comfortably exceeds the default 200-round BUDGET on an unlucky (highly-shuffled) seed array,
// cutting a perfectly correct run off before it finishes. Let the caller ask for more, bounded so
// nobody can request an unbounded number of real handler subprocess spawns.
const MAX_BUDGET = 2000;
function resolveBudget(query) {
  return Math.min(Math.max(Number(query.get("budget")) || BUDGET, 10), MAX_BUDGET);
}

function loadParticipants() {
  const raw =
    process.env.SORT_PARTICIPANTS_JSON ||
    (process.env.SORT_PARTICIPANTS_FILE && fs.existsSync(process.env.SORT_PARTICIPANTS_FILE)
      ? fs.readFileSync(process.env.SORT_PARTICIPANTS_FILE, "utf8")
      : "[]");
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SORT_PARTICIPANTS_JSON/FILE is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(list)) throw new Error("participants config must be a JSON array");
  const byId = new Map();
  for (const p of list) {
    if (!p || typeof p.you !== "string" || typeof p.cmd !== "string") {
      throw new Error(`participant entry missing "you"/"cmd": ${JSON.stringify(p)}`);
    }
    byId.set(p.you, { you: p.you, label: p.label || p.you, cmd: p.cmd });
  }
  return byId;
}

/** Spawn `cmd` under `sh -c`, write `JSON.stringify(input)` to stdin, resolve with stdout.
 *  Rejects (never throws synchronously, never leaves a dangling process) on timeout / non-zero
 *  exit / spawn failure — exactly the contract runRound's callHandler expects. */
function callHandlerProcess(cmd, input, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {}); // a handler that answers before draining stdin is fine
    child.stdin.write(JSON.stringify(input), () => {});
    child.stdin.end();

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`role command exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function randomArray(len) {
  const arr = Array.from({ length: len }, () => 1 + Math.floor(Math.random() * 99));
  return arr;
}

function sendNdjson(res, obj) {
  res.write(JSON.stringify(obj) + "\n");
}

function jsonError(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

async function handleRun(req, res, participants, participantId, query) {
  const config = participants.get(participantId);
  if (!config) return jsonError(res, 404, `unknown participant "${participantId}"`);
  const len = Math.min(Math.max(Number(query.get("len")) || 8, 2), MAX_ARRAY_LEN);
  const initialArray = randomArray(len);

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  sendNdjson(res, { stage: "start", you: config.you, label: config.label, initialArray });

  try {
    // CADS-DEMO-sort#12: runSoloRun's `onRound` fires synchronously right after each round
    // resolves, so a real LLM-backed participant's progress reaches the browser round by round
    // instead of arriving as one buffered burst once the entire (possibly multi-minute) run
    // finishes.
    const result = await runSoloRun({
      you: config.you,
      initialArray,
      budget: resolveBudget(query),
      callHandler: (input) => callHandlerProcess(config.cmd, input),
      onRound: (entry) => sendNdjson(res, { stage: "round", ...entry }),
    });
    sendNdjson(res, {
      stage: "final",
      you: result.you,
      finalArray: result.finalArray,
      finishedCorrectly: result.finishedCorrectly,
      comparisons: result.comparisons,
      swaps: result.swaps,
      faults: result.faults,
      roundsUsed: result.roundsUsed,
      wallClockMs: result.wallClockMs,
      inversionsOverTime: result.inversionsOverTime,
    });
  } catch (e) {
    sendNdjson(res, { stage: "error", message: e.message || String(e) });
  }
  res.end();
}

/** Race mode: same seed array to N participants, each an independent solo run, ranked at the
 *  end. Unlike relay, participants never see each other's moves -- this is a direct head-to-head
 *  on identical starting conditions. Safe to run concurrently: runSoloRun (server.lib.js) holds
 *  no shared/module-level mutable state, and Node's single-threaded event loop means each
 *  participant's res.write() call fully completes before the next, so interleaved round events
 *  from different participants never corrupt each other's JSON line. Orchestration itself lives
 *  in runRaceSession (server.lib.js) so it's testable with stub handlers, same as relay mode. */
async function handleRace(req, res, participants, ids, query) {
  const chosen = [];
  for (const id of ids) {
    const config = participants.get(id);
    if (!config) return jsonError(res, 404, `unknown participant "${id}"`);
    chosen.push(config);
  }
  if (chosen.length < 2) return jsonError(res, 400, "at least two participant ids required (?ids=a,b,c)");
  const len = Math.min(Math.max(Number(query.get("len")) || 8, 2), MAX_ARRAY_LEN);
  const initialArray = randomArray(len);

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  sendNdjson(res, { stage: "start", mode: "race", participants: chosen.map((c) => c.you), initialArray });

  try {
    const result = await runRaceSession({
      participants: chosen.map((c) => ({ you: c.you, callHandler: (input) => callHandlerProcess(c.cmd, input) })),
      initialArray,
      budget: resolveBudget(query),
      onRound: (entry) => sendNdjson(res, { stage: "round", ...entry }),
    });
    sendNdjson(res, { stage: "final", mode: "race", initialArray: result.initialArray, ranked: result.ranked, results: result.results });
  } catch (e) {
    sendNdjson(res, { stage: "error", message: e.message || String(e) });
  }
  res.end();
}

/** Partition mode: the array is split by position into one contiguous segment per participant,
 *  each sorting only its own slice, independently and concurrently. Segments never overlap, so
 *  every participant's own live progress can be drawn into one shared arena at fixed offsets
 *  (unlike race mode's genuinely independent full-length arrays). Orchestration lives in
 *  runPartitionSession (server.lib.js) so it's testable with stub handlers. */
async function handlePartition(req, res, participants, ids, query) {
  const chosen = [];
  for (const id of ids) {
    const config = participants.get(id);
    if (!config) return jsonError(res, 404, `unknown participant "${id}"`);
    chosen.push(config);
  }
  if (chosen.length < 2) return jsonError(res, 400, "at least two participant ids required (?ids=a,b,c)");
  const len = Math.min(Math.max(Number(query.get("len")) || 8, 2), MAX_ARRAY_LEN);
  const initialArray = randomArray(len);

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });

  try {
    const segments = []; // filled in below, but participants need to know their own segment before the first round event
    const chosenWithHandlers = chosen.map((c) => ({ you: c.you, callHandler: (input) => callHandlerProcess(c.cmd, input) }));
    // Compute segment boundaries the same way runPartitionSession will, purely so the "start"
    // event can tell the browser where each participant's slice sits before any rounds arrive.
    const base = Math.floor(initialArray.length / chosen.length);
    const rem = initialArray.length % chosen.length;
    let offset = 0;
    for (let i = 0; i < chosen.length; i++) {
      const size = base + (i < rem ? 1 : 0);
      segments.push({ you: chosen[i].you, start: offset, length: size });
      offset += size;
    }
    sendNdjson(res, { stage: "start", mode: "partition", participants: chosen.map((c) => c.you), initialArray, segments });

    const result = await runPartitionSession({
      participants: chosenWithHandlers,
      initialArray,
      budget: resolveBudget(query),
      onRound: (entry) => sendNdjson(res, { stage: "round", ...entry }),
    });
    sendNdjson(res, {
      stage: "final",
      mode: "partition",
      initialArray: result.initialArray,
      segments: result.segments,
      finalArray: result.finalArray,
      wholeArraySorted: result.wholeArraySorted,
      perParticipant: result.perParticipant,
    });
  } catch (e) {
    sendNdjson(res, { stage: "error", message: e.message || String(e) });
  }
  res.end();
}

function main() {
  const participants = loadParticipants();
  const server = http.createServer((req, res) => {
    // Permissive CORS: this API carries no session/cookie/secret and never accepts a
    // client-supplied handler command (see the header comment), so there's nothing an
    // arbitrary origin gains beyond what the same public endpoints already expose --
    // needed for the "open index.html locally, point it at a remote bridge" dev workflow
    // (production serves both from one origin via Caddy, where this is a no-op).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/participants") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([...participants.values()].map((p) => ({ you: p.you, label: p.label }))));
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, participants: participants.size }));
      return;
    }
    const runMatch = url.pathname.match(/^\/run\/([^/]+)$/);
    if (req.method === "POST" && runMatch) {
      handleRun(req, res, participants, decodeURIComponent(runMatch[1]), url.searchParams);
      return;
    }
    if (req.method === "POST" && url.pathname === "/race") {
      const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
      handleRace(req, res, participants, ids, url.searchParams);
      return;
    }
    if (req.method === "POST" && url.pathname === "/partition") {
      const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
      handlePartition(req, res, participants, ids, url.searchParams);
      return;
    }
    jsonError(res, 404, "not found");
  });
  const [host, port] = LISTEN.split(":");
  server.listen(Number(port), host, () => {
    process.stdout.write(`sort-arena-bridge listening on ${LISTEN}, ${participants.size} participant(s) configured\n`);
  });
}

if (require.main === module) main();

module.exports = { loadParticipants, callHandlerProcess, randomArray, handleRace, handlePartition, handleRun };
