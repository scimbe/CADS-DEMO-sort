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
 *   SORT_PARTICIPANTS_APPROVED_FILE - a second, bridge-writable JSON file with the same shape,
 *                              merged in after the base file (see loadParticipants) -- entries
 *                              added here via the waiting room's approve flow win on id collision
 *                              with the base file, so an operator can still override/retire a
 *                              self-service participant by hand-editing the base file.
 *   SORT_ROUND_TIMEOUT_MS    - per-round handler timeout (default 30000, per docs/protocol.md)
 *   SORT_BUDGET              - default round/tick budget (default 200, per docs/protocol.md)
 *   SORT_ADMIN_EMAILS        - comma-separated operator email(s) allowed to call the waiting-room
 *                              admin routes below, checked against the Caddy-verified
 *                              `X-Gate-Email` header (never a client-supplied field -- see
 *                              gateVerifiedEmail's own comment). Unset -> every admin route fails
 *                              closed (503), since this is a fresh feature with no back-compat
 *                              reason to default open.
 *   SORT_JOIN_REQUESTS_FILE  - path the pending waiting-room queue is persisted to (default
 *                              ./join-requests.json)
 *   SORT_CHANNEL_OPERATOR_PUBKEY, SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY - this deployment's Agent-
 *                              Fabric channel operator + bridge holder PUBLIC keys (64-hex each).
 *                              Both are non-secret by design -- exposed at GET /api/channel-info
 *                              so a participant's own `ct-agent channel member-material` call has
 *                              what it needs, and used server-side to independently recompute
 *                              channel_id_for_link when verifying a submitted attestation.
 *
 * Every run/race/partition endpoint also accepts a per-request `?budget=N` query param
 * (clamped to [10, 2000]), overriding SORT_BUDGET for that one call -- bubble sort's O(n^2)
 * worst case can exceed the 200-round default at the max array length on an unlucky seed.
 */

const http = require("node:http");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");
const {
  DEFAULT_BUDGET,
  DEFAULT_TIMEOUT_MS,
  MAX_ARRAY_LEN,
  runSoloRun,
  runRaceSession,
  runPartitionSession,
} = require("./server.lib.js");
const { channelIdForLink, verifyMemberNoiseAttestation, signMemberNoiseAttestation } = require("./attestation.js");

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

/** Parse+validate one participants-config JSON string into a `you -> {you,label,cmd}` Map --
 *  factored out of loadParticipants so the base file and the approved file share identical
 *  validation (a bridge-written entry must be exactly as well-formed as an operator-written one). */
function parseParticipantsJson(raw, sourceLabel) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${sourceLabel} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${sourceLabel} must be a JSON array`);
  const byId = new Map();
  for (const p of list) {
    if (!p || typeof p.you !== "string" || typeof p.cmd !== "string") {
      throw new Error(`${sourceLabel}: participant entry missing "you"/"cmd": ${JSON.stringify(p)}`);
    }
    byId.set(p.you, { you: p.you, label: p.label || p.you, cmd: p.cmd });
  }
  return byId;
}

/** Base config (SORT_PARTICIPANTS_JSON/_FILE, operator-curated, read-only in every real
 *  deployment) merged with an optional second, bridge-writable source
 *  (SORT_PARTICIPANTS_APPROVED_FILE, populated by the waiting room's approve flow --
 *  addApprovedParticipant below). Approved-file entries win on id collision, so an operator can
 *  still override or retire a self-service participant by hand-editing the base file. */
function loadParticipants() {
  const raw =
    process.env.SORT_PARTICIPANTS_JSON ||
    (process.env.SORT_PARTICIPANTS_FILE && fs.existsSync(process.env.SORT_PARTICIPANTS_FILE)
      ? fs.readFileSync(process.env.SORT_PARTICIPANTS_FILE, "utf8")
      : "[]");
  const byId = parseParticipantsJson(raw, "SORT_PARTICIPANTS_JSON/FILE");

  const approvedPath = process.env.SORT_PARTICIPANTS_APPROVED_FILE;
  if (approvedPath && fs.existsSync(approvedPath)) {
    const approvedRaw = fs.readFileSync(approvedPath, "utf8");
    const approved = parseParticipantsJson(approvedRaw, "SORT_PARTICIPANTS_APPROVED_FILE");
    for (const [you, entry] of approved) byId.set(you, entry);
  }
  return byId;
}

/** Atomic write (tmp file + rename, same discipline CADS-webconference-demo's bridge uses for its
 *  own JSON-file persistence) so a crash mid-write never leaves the target file truncated. */
function writeJsonFileAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, path);
}

/** Append (or replace, by id) one entry into SORT_PARTICIPANTS_APPROVED_FILE and make it live on
 *  the already-running bridge immediately -- `participants` is a Map held by reference in every
 *  request handler (see main()), so `.set()` here is visible on the very next request, no restart
 *  needed. The file write is what makes a restart durable: main() reloads both files on boot. */
function addApprovedParticipant(participants, entry) {
  const approvedPath = process.env.SORT_PARTICIPANTS_APPROVED_FILE;
  if (!approvedPath) throw new Error("SORT_PARTICIPANTS_APPROVED_FILE is not configured");
  let existing = [];
  if (fs.existsSync(approvedPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  const next = existing.filter((p) => p && p.you !== entry.you);
  next.push(entry);
  writeJsonFileAtomic(approvedPath, next);
  participants.set(entry.you, entry);
}

/** The current contents of SORT_PARTICIPANTS_APPROVED_FILE -- deliberately only that file, never
 *  the operator's own base SORT_PARTICIPANTS_FILE, so the admin "revoke" action below can only
 *  ever touch a self-service-admitted entry, never something the operator hand-curated. */
function listApprovedParticipants() {
  const approvedPath = process.env.SORT_PARTICIPANTS_APPROVED_FILE;
  if (!approvedPath || !fs.existsSync(approvedPath)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Remove one entry (by id) from SORT_PARTICIPANTS_APPROVED_FILE and from the live bridge
 *  immediately -- the inverse of addApprovedParticipant. Only ever removes from the approved
 *  file; if `you` isn't in there (e.g. it's a base-file entry, or already gone), this is a no-op
 *  that returns false rather than reaching into the base file or throwing. Once revoked, the
 *  same participant id is free again -- handleJoinRequestSubmit's `participants.has(you)` check
 *  no longer blocks a fresh join request for it. */
function removeApprovedParticipant(participants, you) {
  const approvedPath = process.env.SORT_PARTICIPANTS_APPROVED_FILE;
  if (!approvedPath) throw new Error("SORT_PARTICIPANTS_APPROVED_FILE is not configured");
  const existing = listApprovedParticipants();
  if (!existing.some((p) => p && p.you === you)) return false;
  const next = existing.filter((p) => p && p.you !== you);
  writeJsonFileAtomic(approvedPath, next);
  // Only delete from the live Map if the base file doesn't ALSO define this id -- an operator
  // could plausibly have both (approved-file entry overriding a base one, per loadParticipants'
  // own precedence), and revoking the approved one should fall back to the base entry, not wipe
  // the participant off the live roster entirely if the operator still wants it there.
  const base = parseParticipantsJson(
    process.env.SORT_PARTICIPANTS_JSON ||
      (process.env.SORT_PARTICIPANTS_FILE && fs.existsSync(process.env.SORT_PARTICIPANTS_FILE)
        ? fs.readFileSync(process.env.SORT_PARTICIPANTS_FILE, "utf8")
        : "[]"),
    "SORT_PARTICIPANTS_JSON/FILE"
  );
  if (base.has(you)) participants.set(you, base.get(you));
  else participants.delete(you);
  return true;
}

// ---- Waiting room: admin auth ----------------------------------------------------------------
//
// Mirrors CADS-webconference-demo/bridge/server.js's ADMIN_EMAILS + X-Gate-Email pattern exactly
// (that repo's own comments flag its sibling `callerEmail` body-field variant as an unverified
// impersonation gap -- this bridge only ever trusts the header, which Caddy's forward_auth sets
// from a real verified gate session and strips any client-supplied copy of first; see Caddyfile).
const ADMIN_EMAILS = new Set(
  (process.env.SORT_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function gateVerifiedEmail(req) {
  const email = req.headers["x-gate-email"];
  return email ? String(email).trim().toLowerCase() : null;
}

/** Every admin route fails closed (503) if SORT_ADMIN_EMAILS is unset -- unlike
 *  CADS-webconference-demo's read-only routes (which stay permissive on an empty admin list for
 *  demo-ergonomics reasons specific to that project's history), this is a fresh feature with no
 *  existing deployment to stay backward-compatible with, and every one of these routes is either
 *  a grant-capability action (approve) or exposes real participant-identity data (list) -- both
 *  worth requiring real admin config for from day one. */
function requireAdmin(req, res) {
  if (ADMIN_EMAILS.size === 0) {
    jsonError(res, 503, "admin not configured (SORT_ADMIN_EMAILS unset)");
    return false;
  }
  const caller = gateVerifiedEmail(req);
  if (!caller || !ADMIN_EMAILS.has(caller)) {
    jsonError(res, 403, "admin only");
    return false;
  }
  return true;
}

// ---- Waiting room: rate limiting + body reading ----------------------------------------------

/** Fixed-window-per-key limiter, identical shape to CADS-webconference-demo's makeRateLimiter. */
function makeRateLimiter(maxCount, windowMs) {
  const hits = new Map();
  return function rateLimited(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > maxCount;
  };
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// 64KB is generous for what this API ever sends (the largest real payload is a join-request body:
// a handful of hex fields, well under 1KB) -- same cap/reasoning as CADS-webconference-demo's
// readBody, closing the same "one huge body kept accumulating in memory" DoS shape.
const MAX_BODY_BYTES = 65_536;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("request body too large"));
        return;
      }
      data += c;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---- Waiting room: join-request queue ----------------------------------------------------------

const JOIN_REQUEST_RATE_LIMIT = 10;
const JOIN_REQUEST_RATE_WINDOW_MS = 60 * 1000;
const joinRequestRateLimited = makeRateLimiter(JOIN_REQUEST_RATE_LIMIT, JOIN_REQUEST_RATE_WINDOW_MS);
const JOIN_REQUEST_MAX_PENDING = 200;
const HEX32_RE = /^[0-9a-f]{64}$/i;
const HEX64_RE = /^[0-9a-f]{128}$/i;
const PARTICIPANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** you -> {you, label, holderPub, noisePub, attestation, createdAt} (all hex fields, all already
 *  cryptographically verified before being queued -- see handleJoinRequestSubmit). Persisted to
 *  SORT_JOIN_REQUESTS_FILE on every mutation, loaded once at startup, same write-through pattern
 *  as CADS-webconference-demo's accessRequests. */
function loadJoinRequests() {
  const path = process.env.SORT_JOIN_REQUESTS_FILE || "./join-requests.json";
  const map = new Map();
  if (fs.existsSync(path)) {
    try {
      for (const entry of JSON.parse(fs.readFileSync(path, "utf8"))) {
        if (entry && typeof entry.you === "string") map.set(entry.you, entry);
      }
    } catch (e) {
      process.stderr.write(`join-requests: could not load ${path}: ${e.message} -- starting empty\n`);
    }
  }
  return map;
}
function persistJoinRequests(joinRequests) {
  const path = process.env.SORT_JOIN_REQUESTS_FILE || "./join-requests.json";
  try {
    writeJsonFileAtomic(path, [...joinRequests.values()]);
  } catch (e) {
    process.stderr.write(`join-requests: could not persist to ${path}: ${e.message}\n`);
  }
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

// ---- Waiting room: approval automation (grant-minting + control-plane registration) -----------
//
// Requires the private-key/control-plane env vars configured (automationConfigured() below);
// handleJoinRequestApprove fails closed (503) if they're missing, rather than accepting an
// approve click it can't actually finish.
//
// _FILE convention (Docker secrets): if <NAME>_FILE is set, read the value from that file (a
// Docker `secrets:` mount lands outside `environment:`/`docker inspect` output); otherwise fall
// back to the plain env var. Mirrors CADS-webconference-demo/bridge/server.js's readSecret
// exactly.
function readSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch (e) {
      process.stderr.write(`bridge: failed to read ${name}_FILE (${filePath}): ${e.message}\n`);
      return undefined;
    }
  }
  return process.env[name];
}

function automationConfigured() {
  return Boolean(
    readSecret("SORT_CHANNEL_OPERATOR_KEY") &&
      readSecret("SORT_CHANNEL_BRIDGE_HOLDER_KEY") &&
      readSecret("SORT_CHANNEL_BRIDGE_NOISE_KEY") &&
      process.env.SORT_CP_URL &&
      readSecret("SORT_OIDC_TOKEN") &&
      process.env.SORT_CHANNEL_BROKER &&
      process.env.SORT_CHANNEL_RELAY
  );
}

// sort-channel-grant's own MAX_TTL_SECS (grant/src/main.rs) is 30 days -- passing anything
// higher is a hard, real rejection from the binary itself, not a soft cap. Caught live by this
// file's own integration test: an earlier version of this constant (365 days) made every real
// mint call fail. A participant's grant needs re-approving after this window; that's a real,
// disclosed limitation of the vendored crate's own design, not something to silently work around
// by forking it to accept a longer TTL.
const GRANT_TTL_SECS = 30 * 24 * 3600;

/** Shells out to the vendored sort-channel-grant binary (grant/, built into the bridge image --
 *  see Dockerfile) exactly the way CADS-webconference-demo's own mintGrants does: the operator's
 *  private key is passed via --operator-private-file (a Docker-secrets-mounted path) whenever
 *  configured, so it never sits in this child process's own argv/`/proc/<pid>/cmdline` even
 *  transiently -- only the key VALUE needs to stay secret, and reading it via _FILE here already
 *  keeps it out of THIS process's argv; --operator-private-file additionally keeps it out of the
 *  grant binary's argv too. */
function mintGrants(holderAHex, holderBHex) {
  return new Promise((resolve, reject) => {
    const grantBin = process.env.SORT_GRANT_BIN || "/usr/local/bin/sort-channel-grant";
    const operatorKeyFile = process.env.SORT_CHANNEL_OPERATOR_KEY_FILE;
    const operatorArgs = operatorKeyFile
      ? ["--operator-private-file", operatorKeyFile]
      : ["--operator-private", readSecret("SORT_CHANNEL_OPERATOR_KEY")];
    execFile(
      grantBin,
      [holderAHex, holderBHex, ...operatorArgs, "--ttl-secs", String(GRANT_TTL_SECS)],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const out = {};
        for (const line of stdout.trim().split("\n")) {
          const idx = line.indexOf("=");
          if (idx === -1) continue;
          out[line.slice(0, idx)] = line.slice(idx + 1);
        }
        if (!out.channel_id_hex || !out.grant_a_hex || !out.grant_b_hex) {
          return reject(new Error(`unexpected sort-channel-grant output: ${stdout}`));
        }
        resolve({ channel: out.channel_id_hex, grantA: out.grant_a_hex, grantB: out.grant_b_hex, operatorPub: out.operator_public_hex });
      }
    );
  });
}

/** POST to the control plane with a bearer token -- the simplest of CADS-webconference-demo's
 *  three auth tiers (service-account client_credentials preferred there; this deployment starts
 *  with the same manually-refreshed-token fallback tier, since standing up a service-account
 *  client is a real, separate operational step, not a code change). SORT_OIDC_TOKEN needs
 *  refreshing whenever it expires (a realm's default is typically minutes, not hours) -- until a
 *  service-account credential is wired in, that's a real operational limitation of Phase 2 worth
 *  documenting, not hiding. */
async function cpFetch(path, body) {
  const token = readSecret("SORT_OIDC_TOKEN");
  const resp = await fetch(`${process.env.SORT_CP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text().catch(() => "");
  return { status: resp.status, text };
}

/** Full Phase 2 automation for one approval: mint both grants, register the channel + both
 *  members with the control plane, and construct the real `cmd` string -- the bridge's own
 *  attestation is signed fresh here (signMemberNoiseAttestation), the participant's was already
 *  verified at submit time (handleJoinRequestSubmit) and is reused as-is. Never fabricates
 *  success: any failed step returns {ok:false, detail} with the exact response, the same "report
 *  the real failure, don't pretend it worked" discipline CADS-webconference-demo's tryRegister
 *  uses. Throws only on a genuine local/programming error (e.g. mintGrants' own process spawn
 *  failure) -- HTTP-level control-plane failures are returned, not thrown. */
async function automateApproval(pending) {
  const bridgeHolderPub = process.env.SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY;
  const bridgeHolderPriv = Buffer.from(readSecret("SORT_CHANNEL_BRIDGE_HOLDER_KEY"), "hex");
  const bridgeNoisePriv = Buffer.from(readSecret("SORT_CHANNEL_BRIDGE_NOISE_KEY"), "hex");
  // The bridge's own noise PUBLIC key -- derivable from the private key, but this repo has no
  // "derive Ed25519 pubkey from privkey" helper of its own; simplest correct source is to
  // require it configured explicitly, matching how the holder pubkey is already configured.
  const bridgeNoisePub = process.env.SORT_CHANNEL_BRIDGE_NOISE_PUBKEY;
  if (!bridgeNoisePub) return { ok: false, detail: "SORT_CHANNEL_BRIDGE_NOISE_PUBKEY is not configured" };

  const minted = await mintGrants(bridgeHolderPub, pending.holderPub);
  const channelBuf = Buffer.from(minted.channel, "hex");

  const reg = await cpFetch("/me/channels", { channel: minted.channel, operator_pubkey: minted.operatorPub });
  if (reg.status !== 200) {
    return { ok: false, detail: `POST /me/channels -> ${reg.status} ${reg.text}`.slice(0, 400) };
  }

  const bridgeAttestation = signMemberNoiseAttestation(channelBuf, bridgeHolderPriv, Buffer.from(bridgeHolderPub, "hex"), bridgeNoisePub && Buffer.from(bridgeNoisePub, "hex"));
  const memBridge = await cpFetch(`/me/channels/${minted.channel}/members`, {
    holder: bridgeHolderPub,
    noise_pubkey: bridgeNoisePub,
    noise_attestation: bridgeAttestation.toString("hex"),
  });
  const memParticipant = await cpFetch(`/me/channels/${minted.channel}/members`, {
    holder: pending.holderPub,
    noise_pubkey: pending.noisePub,
    noise_attestation: pending.attestation,
  });
  if (memBridge.status !== 200 || memParticipant.status !== 200) {
    return {
      ok: false,
      detail: `members -> bridge=${memBridge.status} participant=${memParticipant.status} ${memBridge.text || memParticipant.text}`.slice(0, 400),
    };
  }

  const cmd =
    `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=text_generation ` +
    `CT_CHANNEL_GRANT=${minted.grantA} ` +
    `CT_CHANNEL_HOLDER_KEY=${bridgeHolderPriv.toString("hex")} CT_CHANNEL_NOISE_KEY=${bridgeNoisePriv.toString("hex")} ` +
    `CT_CHANNEL_BROKER=${process.env.SORT_CHANNEL_BROKER} CT_CHANNEL_RELAY=${process.env.SORT_CHANNEL_RELAY} ` +
    `ct-agent channel`;

  return { ok: true, channel: minted.channel, cmd, grantB: minted.grantB };
}

// ---- Waiting room: route handlers --------------------------------------------------------------

/** GET /api/channel-info -- public, unauthenticated. Both values are the deployment's own PUBLIC
 *  keys (never a secret), needed by a participant's own `ct-agent channel member-material` call
 *  (CT_CHANNEL_OPERATOR_PUBKEY / CT_CHANNEL_BRIDGE_HOLDER) to produce a join-request submission. */
function handleChannelInfo(req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      operatorPubkey: process.env.SORT_CHANNEL_OPERATOR_PUBKEY || null,
      bridgeHolderPubkey: process.env.SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY || null,
    })
  );
}

/** POST /api/join-requests -- public (gate-exempt in Caddy), rate-limited. Validates shape, then
 *  cryptographically verifies the attestation BEFORE queuing: the bridge independently recomputes
 *  channel_id_for_link(operatorPub, bridgeHolderPub, holderPub) itself rather than trusting a
 *  caller-supplied channel id, so a bad submission is rejected at submit time (400), not
 *  discovered by an operator later at approval time. */
async function handleJoinRequestSubmit(req, res, joinRequests, participants) {
  if (joinRequestRateLimited(clientIp(req))) return jsonError(res, 429, "too many requests -- try again later");
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonError(res, 400, e.message || "invalid request body");
  }
  const { you, label, holderPub, noisePub, attestation } = body || {};
  if (typeof you !== "string" || !PARTICIPANT_ID_RE.test(you)) {
    return jsonError(res, 400, "you: 1-64 chars, lowercase letters/digits/hyphens, must start alphanumeric");
  }
  if (label !== undefined && typeof label !== "string") return jsonError(res, 400, "label must be a string");
  if (typeof holderPub !== "string" || !HEX32_RE.test(holderPub)) return jsonError(res, 400, "holderPub must be 64 hex chars");
  if (typeof noisePub !== "string" || !HEX32_RE.test(noisePub)) return jsonError(res, 400, "noisePub must be 64 hex chars");
  if (typeof attestation !== "string" || !HEX64_RE.test(attestation)) return jsonError(res, 400, "attestation must be 128 hex chars");
  if (participants.has(you)) return jsonError(res, 409, `"${you}" is already a live participant`);
  if (joinRequests.has(you)) return jsonError(res, 409, `"${you}" already has a pending join request`);
  if (joinRequests.size >= JOIN_REQUEST_MAX_PENDING) return jsonError(res, 503, "too many pending requests -- try again later");

  const operatorPubHex = process.env.SORT_CHANNEL_OPERATOR_PUBKEY;
  const bridgeHolderHex = process.env.SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY;
  if (!operatorPubHex || !bridgeHolderHex) return jsonError(res, 503, "channel identity not configured on this deployment");
  const channel = channelIdForLink(
    Buffer.from(operatorPubHex, "hex"),
    Buffer.from(bridgeHolderHex, "hex"),
    Buffer.from(holderPub, "hex")
  );
  const valid = verifyMemberNoiseAttestation(
    channel,
    Buffer.from(holderPub, "hex"),
    Buffer.from(noisePub, "hex"),
    Buffer.from(attestation, "hex")
  );
  if (!valid) return jsonError(res, 400, "attestation does not verify against holderPub for this deployment's channel");

  joinRequests.set(you, { you, label: label || you, holderPub, noisePub, attestation, createdAt: Date.now() });
  persistJoinRequests(joinRequests);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, channelId: channel.toString("hex") }));
}

/** GET /api/join-requests -- admin-only. */
function handleJoinRequestsList(req, res, joinRequests) {
  if (!requireAdmin(req, res)) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ requests: [...joinRequests.values()].sort((a, b) => a.createdAt - b.createdAt) }));
}

/** POST /api/join-requests/:you/approve -- admin-only. Mints both grants, registers the channel
 *  + both members with the control plane for real, and makes the participant live immediately --
 *  one click, fully automatic. Requires automationConfigured() (operator/bridge private keys +
 *  control-plane URL/token/broker/relay); if any of those is missing this fails closed (503)
 *  rather than accepting a request it can't actually finish -- there is no manual fallback path,
 *  a misconfigured deployment should say so plainly, not silently degrade to something else. */
async function handleJoinRequestApprove(req, res, joinRequests, participants, pendingGrantDelivery, you) {
  if (!requireAdmin(req, res)) return;
  const pending = joinRequests.get(you);
  if (!pending) return jsonError(res, 404, `no pending join request for "${you}"`);
  if (!automationConfigured()) {
    return jsonError(
      res,
      503,
      "automation not configured on this deployment -- set SORT_CHANNEL_OPERATOR_KEY, SORT_CHANNEL_BRIDGE_HOLDER_KEY, " +
        "SORT_CHANNEL_BRIDGE_NOISE_KEY, SORT_CP_URL, SORT_OIDC_TOKEN, SORT_CHANNEL_BROKER, SORT_CHANNEL_RELAY"
    );
  }

  let result;
  try {
    result = await automateApproval(pending);
  } catch (e) {
    // A genuine local failure (grant binary missing/crashed, etc) -- log in full server-side,
    // generic to the client, same discipline CADS-webconference-demo's mintGrants error path
    // uses. The request stays pending (not deleted) so the operator can retry rather than
    // losing it.
    process.stderr.write(`join-requests: automated approval failed for "${you}": ${e.message}\n`);
    return jsonError(res, 500, "automated approval failed -- see bridge logs");
  }
  if (!result.ok) {
    // Real control-plane failure, reported honestly -- request stays pending, retryable.
    return jsonError(res, 502, `automated approval failed: ${result.detail}`);
  }
  joinRequests.delete(you);
  persistJoinRequests(joinRequests);
  addApprovedParticipant(participants, { you: pending.you, label: pending.label, cmd: result.cmd });
  pendingGrantDelivery.set(you, { channel: result.channel, grantB: result.grantB, createdAt: Date.now() });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, you: pending.you, label: pending.label, channel: result.channel }));
}

/** GET /api/join-requests/:you/status -- public, unauthenticated. A participant's own join.js
 *  polls this after submitting to learn whether they've been approved and, if automated, to
 *  retrieve their own grant (grantB) -- the one piece of information only they actually need
 *  and that never has anywhere else to go, since they're not the one running the admin panel.
 *  Safe to leave unauthenticated: a grant is only USABLE by whoever holds the matching holder
 *  private key, which never left the requester's own browser -- reading the grant string itself
 *  reveals nothing exploitable to a third party who doesn't also hold that key. */
function handleJoinRequestStatus(req, res, joinRequests, pendingGrantDelivery, you) {
  if (pendingGrantDelivery.has(you)) {
    const entry = pendingGrantDelivery.get(you);
    pendingGrantDelivery.delete(you); // single delivery -- the participant's own join.js is the only reader
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "approved", channel: entry.channel, grant: entry.grantB }));
    return;
  }
  const status = joinRequests.has(you) ? "pending" : "unknown";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status }));
}

/** POST /api/join-requests/:you/decline -- admin-only. */
function handleJoinRequestDecline(req, res, joinRequests, you) {
  if (!requireAdmin(req, res)) return;
  if (!joinRequests.has(you)) return jsonError(res, 404, `no pending join request for "${you}"`);
  joinRequests.delete(you);
  persistJoinRequests(joinRequests);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** POST /api/participants/approved -- admin-only. A general "add a participant with an
 *  already-known cmd" action -- not part of the join-request flow (handleJoinRequestApprove
 *  handles that end to end automatically), but useful on its own for hand-adding an entry the
 *  operator has already provisioned some other way. Writes SORT_PARTICIPANTS_APPROVED_FILE and
 *  updates the running bridge's participants Map in one step, no restart needed (see
 *  addApprovedParticipant). */
async function handleAddApprovedParticipant(req, res, participants) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonError(res, 400, e.message || "invalid request body");
  }
  const { you, label, cmd } = body || {};
  if (typeof you !== "string" || !PARTICIPANT_ID_RE.test(you)) {
    return jsonError(res, 400, "you: 1-64 chars, lowercase letters/digits/hyphens, must start alphanumeric");
  }
  if (typeof cmd !== "string" || !cmd.trim()) return jsonError(res, 400, "cmd must be a non-empty string");
  if (label !== undefined && typeof label !== "string") return jsonError(res, 400, "label must be a string");
  try {
    addApprovedParticipant(participants, { you, label: label || you, cmd });
  } catch (e) {
    return jsonError(res, 500, e.message || String(e));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, you }));
}

/** GET /api/participants/approved -- admin-only. Lists self-service-admitted participants (i.e.
 *  SORT_PARTICIPANTS_APPROVED_FILE's own contents), so the admin panel can offer a Revoke action
 *  distinct from the operator's own hand-curated base roster. */
function handleListApprovedParticipants(req, res) {
  if (!requireAdmin(req, res)) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ participants: listApprovedParticipants() }));
}

/** POST /api/participants/approved/:you/revoke -- admin-only. Removes a self-service-admitted
 *  participant so it stops being live and, critically, so the same id is free again for a fresh
 *  join request (handleJoinRequestSubmit's duplicate check reads the live participants Map,
 *  which this updates immediately -- see removeApprovedParticipant). */
function handleRevokeApprovedParticipant(req, res, participants, you) {
  if (!requireAdmin(req, res)) return;
  const removed = removeApprovedParticipant(participants, you);
  if (!removed) return jsonError(res, 404, `"${you}" is not a self-service-admitted participant`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, you }));
}

function main() {
  const participants = loadParticipants();
  const joinRequests = loadJoinRequests();
  // "you" -> {channel, grantB, createdAt} -- Phase 2's one-shot delivery slot for a participant's
  // own grant, read once by their own join.js status poll (handleJoinRequestStatus) then deleted.
  // In-memory only: if the bridge restarts before a participant polls, they're already fully
  // registered with the control plane (that part is durable), just need the operator to re-run
  // approve (idempotent-ish: mintGrants signs a fresh grant, registration calls are themselves
  // idempotent server-side) -- an acceptable, disclosed gap rather than adding a third
  // persisted-file format for what's meant to be a brief, one-time handoff.
  const pendingGrantDelivery = new Map();
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
    if (req.method === "GET" && url.pathname === "/api/channel-info") {
      handleChannelInfo(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/join-requests") {
      handleJoinRequestSubmit(req, res, joinRequests, participants);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/join-requests") {
      handleJoinRequestsList(req, res, joinRequests);
      return;
    }
    const approveMatch = url.pathname.match(/^\/api\/join-requests\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      handleJoinRequestApprove(req, res, joinRequests, participants, pendingGrantDelivery, decodeURIComponent(approveMatch[1]));
      return;
    }
    const declineMatch = url.pathname.match(/^\/api\/join-requests\/([^/]+)\/decline$/);
    if (req.method === "POST" && declineMatch) {
      handleJoinRequestDecline(req, res, joinRequests, decodeURIComponent(declineMatch[1]));
      return;
    }
    const statusMatch = url.pathname.match(/^\/api\/join-requests\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      handleJoinRequestStatus(req, res, joinRequests, pendingGrantDelivery, decodeURIComponent(statusMatch[1]));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/participants/approved") {
      handleAddApprovedParticipant(req, res, participants);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/participants/approved") {
      handleListApprovedParticipants(req, res);
      return;
    }
    const revokeMatch = url.pathname.match(/^\/api\/participants\/approved\/([^/]+)\/revoke$/);
    if (req.method === "POST" && revokeMatch) {
      handleRevokeApprovedParticipant(req, res, participants, decodeURIComponent(revokeMatch[1]));
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

module.exports = {
  loadParticipants,
  parseParticipantsJson,
  addApprovedParticipant,
  listApprovedParticipants,
  removeApprovedParticipant,
  callHandlerProcess,
  randomArray,
  handleRace,
  handlePartition,
  handleRun,
  handleChannelInfo,
  handleJoinRequestSubmit,
  handleJoinRequestsList,
  handleJoinRequestApprove,
  handleJoinRequestDecline,
  handleJoinRequestStatus,
  handleAddApprovedParticipant,
  handleListApprovedParticipants,
  handleRevokeApprovedParticipant,
  loadJoinRequests,
  persistJoinRequests,
  gateVerifiedEmail,
  ADMIN_EMAILS,
  readSecret,
  automationConfigured,
  mintGrants,
  cpFetch,
  automateApproval,
};
