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

// ---- Self-service participant liveness (CADS-DEMO-sort#28) ------------------------------------
//
// The self-service roster used to grow without bound: every join added an approved-file entry that
// only ever left by an explicit admin revoke, so dead throwaway/test participants (whose ct-agent
// is long gone) piled up in GET /participants forever. The operator's rule: a self-service
// participant whose ct-agent hasn't actually connected within SORT_PARTICIPANT_TTL_MS (default 24h)
// is pruned and must re-join (the login-is-approval flow makes that a one-step action). "Connected"
// is observed passively from real dials -- a successful roleCall means that participant's ct-agent
// answered -- plus approval itself (they were online to join); there is no active probing, so a
// dead entry simply ages out while a live one keeps refreshing its own timestamp. Operator-curated
// BASE-file participants are never touched here (reconcile only ever reads the approved file), so
// reference-sorter and friends can never be swept.
const PARTICIPANT_TTL_MS = Number(process.env.SORT_PARTICIPANT_TTL_MS) || 24 * 60 * 60 * 1000;
const PARTICIPANT_SWEEP_INTERVAL_MS =
  Number(process.env.SORT_PARTICIPANT_SWEEP_INTERVAL_MS) || 60 * 60 * 1000;

// you -> ms epoch of the last observed connection. In-memory and O(1) to update (a real round
// updates it per successful dial, so it must be cheap); durability is the approved file's own
// lastSeenAt, flushed by reconcileApprovedParticipants. Seeded from that file at boot in main().
const participantLastSeen = new Map();
function recordParticipantSeen(you, now = Date.now()) {
  participantLastSeen.set(you, now);
}
// Test-only: clear the in-memory liveness map so cases don't leak "seen" state into each other.
function resetParticipantSeenForTests() {
  participantLastSeen.clear();
}
// Exposed alongside everAnswered on GET /participants (CADS-DEMO-sort#58 follow-up, live-verified
// by an external re-test 2026-08-28): everAnswered never decays -- once true, a participant that
// answered a single call at any point in this bridge's uptime stays "everAnswered: true" forever,
// even if every round since has hung. Two real participants (tobi, bennet) reproduced exactly this:
// both answered successfully at some point, both now time out every round (0 completions in 40s),
// and both still read everAnswered:true -- actively steering a reader who filters on that flag
// TOWARD the two that currently hang, away from ones that would actually finish a run. lastSeenAt
// is the fix: it's the timestamp of the LAST successful call (same seenRecordingCall trigger, see
// below), not "ever, at all" -- pairing "everAnswered:true" with a stale lastSeenAt is exactly the
// "used to work, now dead" signal #58 originally asked for and everAnswered alone can't give.
function getParticipantLastSeen(you) {
  return participantLastSeen.get(you) ?? null;
}

// CADS-DEMO-sort#58: GET /participants advertises `you`/`label` only, with no way for a reader to
// tell "has ever completed a real call" apart from "was just approved and never answered anything"
// -- lastSeenAt alone can't distinguish these, since addApprovedParticipant stamps it at approval
// time too. This tracks the narrower fact deliberately: only a real resolved roleCall (inside
// seenRecordingCall's success path, i.e. the participant's ct-agent actually answered) adds to it,
// approval never does. Same in-memory-only shape as participantLastSeen; not persisted, since
// "did we ever see this participant answer in the current bridge's lifetime" is the honest claim,
// not a durable historical record. Read this together with lastSeenAt above, not alone -- see its
// comment for why "everAnswered:true" by itself can point straight at a currently-broken participant.
const participantEverAnswered = new Set();
function resetParticipantEverAnsweredForTests() {
  participantEverAnswered.clear();
}
function hasParticipantEverAnswered(you) {
  return participantEverAnswered.has(you);
}

/** Append (or replace, by id) one entry into SORT_PARTICIPANTS_APPROVED_FILE and make it live on
 *  the already-running bridge immediately -- `participants` is a Map held by reference in every
 *  request handler (see main()), so `.set()` here is visible on the very next request, no restart
 *  needed. The file write is what makes a restart durable: main() reloads both files on boot.
 *  Stamps lastSeenAt at approval time -- being admitted counts as a connection, so a freshly
 *  approved participant gets a full TTL window before the liveness sweep can consider it (#28). */
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
  const stamped = { ...entry, lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : Date.now() };
  const next = existing.filter((p) => p && p.you !== stamped.you);
  next.push(stamped);
  writeJsonFileAtomic(approvedPath, next);
  participants.set(stamped.you, stamped);
  recordParticipantSeen(stamped.you, stamped.lastSeenAt);
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
  applyBaseFallbackToMap(participants, you);
  return true;
}

/** Update the live Map after an approved-file entry for `you` has been dropped: only delete it if
 *  the base file doesn't ALSO define this id -- an operator could plausibly have both (approved
 *  entry overriding a base one, per loadParticipants' own precedence), and dropping the approved
 *  one should fall back to the base entry, not wipe the participant off the live roster entirely if
 *  the operator still wants it there. Map-only (no file I/O), so callers that already rewrote the
 *  approved file in bulk (the liveness sweep) can reconcile the Map without a second write. */
function applyBaseFallbackToMap(participants, you) {
  const base = parseParticipantsJson(
    process.env.SORT_PARTICIPANTS_JSON ||
      (process.env.SORT_PARTICIPANTS_FILE && fs.existsSync(process.env.SORT_PARTICIPANTS_FILE)
        ? fs.readFileSync(process.env.SORT_PARTICIPANTS_FILE, "utf8")
        : "[]"),
    "SORT_PARTICIPANTS_JSON/FILE"
  );
  if (base.has(you)) participants.set(you, base.get(you));
  else participants.delete(you);
}

/** The liveness sweep (CADS-DEMO-sort#28). Rewrites SORT_PARTICIPANTS_APPROVED_FILE in one atomic
 *  pass: every self-service entry whose last observed connection is older than ttlMs is dropped
 *  (and reconciled out of the live Map), every survivor is kept with its lastSeenAt flushed from
 *  the in-memory map so a restart remembers it. Base-file participants are never considered -- this
 *  only ever reads the approved file. `now`/`ttlMs`/`bootTime`/`lastSeen` are injectable so the
 *  behavior is unit-testable without wall-clock or the module-level map. A legacy entry that
 *  predates this feature (no lastSeenAt, never touched) falls back to bootTime, i.e. gets a full
 *  fresh TTL window from the deploy rather than being deleted out from under a live participant. */
function reconcileApprovedParticipants(
  participants,
  { now = Date.now(), ttlMs = PARTICIPANT_TTL_MS, bootTime = now, lastSeen = participantLastSeen } = {}
) {
  const approvedPath = process.env.SORT_PARTICIPANTS_APPROVED_FILE;
  if (!approvedPath) return { pruned: [], kept: [] };
  const list = listApprovedParticipants();
  const byId = new Map(list.filter((e) => e && typeof e.you === "string").map((e) => [e.you, e]));
  const kept = [];
  const pruned = [];
  for (const entry of list) {
    if (!entry || typeof entry.you !== "string") continue; // drop malformed lines silently
    const seen = lastSeen.get(entry.you) ?? entry.lastSeenAt ?? bootTime;
    if (now - seen > ttlMs) pruned.push(entry.you);
    else kept.push({ ...entry, lastSeenAt: seen });
  }
  const timestampsChanged = kept.some((e) => (byId.get(e.you) || {}).lastSeenAt !== e.lastSeenAt);
  if (pruned.length > 0 || timestampsChanged || kept.length !== list.length) {
    writeJsonFileAtomic(approvedPath, kept);
  }
  for (const you of pruned) applyBaseFallbackToMap(participants, you);
  return { pruned, kept };
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
  const email = req && req.headers ? req.headers["x-gate-email"] : null;
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

/** Auto-approval (2026-08-13, tutorial rework): a Keycloak login IS the legitimization -- once
 *  Caddy's forward_auth has verified a real account (see the Caddyfile's `@join-page`/
 *  `@join-submit` gate blocks and `gateVerifiedEmail` below), a join request is approved
 *  IMMEDIATELY instead of sitting in the admin queue. That removes a manual click from every
 *  participant's path but also removes the one thing that click used to bound: how many live
 *  participants (each with its own control-plane registration + a held channel-relay member) one
 *  logged-in account can mint. AUTO_APPROVE_RATE_LIMIT caps it per gate-verified email, same
 *  fixed-window shape as joinRequestRateLimited above -- generous enough for genuine iteration
 *  (rebuild your handler, rejoin) inside a workshop, tight enough that a buggy script under one
 *  real account can't fork-bomb the bridge's persistent-client processes. */
const AUTO_APPROVE_RATE_LIMIT = 5;
const AUTO_APPROVE_RATE_WINDOW_MS = 60 * 60 * 1000;
const autoApproveRateLimited = makeRateLimiter(AUTO_APPROVE_RATE_LIMIT, AUTO_APPROVE_RATE_WINDOW_MS);
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

/** The one-shot grant-delivery slot (pendingGrantDelivery) persisted to SORT_PENDING_GRANTS_FILE,
 *  same write-through pattern as join-requests above. This is the CADS-DEMO-sort#26 fix: without
 *  it, a bridge redeploy between approval and the participant's own status poll wiped the only copy
 *  of grantB -- the participant was registered with the control plane (durable) but had no way to
 *  retrieve the grant they need to actually dial in, and the operator had to notice and re-run
 *  approve. Persisting the slot means a redeploy can no longer strand a grant. The Map's VALUE
 *  carries no `you` (it's the key), so persistence flattens `you` back in and load reconstructs it.
 *  Note this file, like SORT_JOIN_REQUESTS_FILE, must live on the bridge's writable volume -- a
 *  path the bridge can't write to silently degrades to the old in-memory-only behavior (logged). */
function loadPendingGrants() {
  const path = process.env.SORT_PENDING_GRANTS_FILE || "./pending-grants.json";
  const map = new Map();
  if (fs.existsSync(path)) {
    try {
      for (const entry of JSON.parse(fs.readFileSync(path, "utf8"))) {
        if (entry && typeof entry.you === "string") {
          map.set(entry.you, {
            channel: entry.channel,
            grantB: entry.grantB,
            createdAt: entry.createdAt,
            firstDeliveredAt: entry.firstDeliveredAt,
          });
        }
      }
    } catch (e) {
      process.stderr.write(`pending-grants: could not load ${path}: ${e.message} -- starting empty\n`);
    }
  }
  return map;
}
function persistPendingGrants(pendingGrantDelivery) {
  const path = process.env.SORT_PENDING_GRANTS_FILE || "./pending-grants.json";
  try {
    writeJsonFileAtomic(path, [...pendingGrantDelivery.entries()].map(([you, v]) => ({ you, ...v })));
  } catch (e) {
    process.stderr.write(`pending-grants: could not persist to ${path}: ${e.message}\n`);
  }
}

/** Spawn `cmd` under `sh -c`, write `JSON.stringify(input)` to stdin, resolve with stdout.
 *  Rejects (never throws synchronously, never leaves a dangling process) on timeout / non-zero
 *  exit / spawn failure — exactly the contract runRound's callHandler expects.
 *
 *  `detached: true` puts the child in its OWN process group so the timeout path can SIGKILL the
 *  whole group (`process.kill(-pid)`) rather than just `sh`. That is load-bearing, not hygiene:
 *  `sh -c "VAR=val ct-agent channel"` does not exec-replace itself, it forks a real `ct-agent`
 *  grandchild and waits on it, so killing only `sh` left that grandchild running indefinitely --
 *  it also kept the inherited stdio pipe fds open, which delayed this promise's 'close' until it
 *  finally exited on its own (measured: 2.5s after the SIGKILL, vs ~1ms once the group is killed).
 *
 *  The orphan then became a zombie, because the bridge used to run as PID 1 in its container and
 *  a PID 1 inherits every orphan -- while Node only ever waitpid()s children it spawned itself.
 *  Measured live: 75 `<defunct>` children in ~1h of ct-agent dials timing out (CADS-DEMO-sort#9).
 *  That half is fixed in bridge/Dockerfile (tini as PID 1, which reaps); BOTH halves are needed --
 *  an init alone still leaves the grandchild running, and a group kill alone still leaves a
 *  zombie, since the grandchild is orphaned the instant its `sh` parent dies. */
// sort#44: caps how many local-handler subprocesses can be alive at once, across ALL requests.
// /run, /race, /partition are intentionally public (the spectator/participant API,
// Caddyfile's @api matcher), and runRaceSession/runPartitionSession already run every
// participant's round loop CONCURRENTLY within one request (Promise.all in server.lib.js) --
// so a single /race?ids=a,b,c,... already fans out N simultaneous spawns, and nothing bounded
// how many such requests could be in flight together. resolveBudget's MAX_BUDGET only clamps
// rounds WITHIN one request, not concurrent spawns ACROSS requests. Queueing (not rejecting)
// past the cap: a spawn is typically done in well under a second, so a queued caller still
// gets a real result shortly, and the demo's "it eventually works" feel survives a burst --
// unlike a 429, which would surface as a broken round to an ordinary spectator running two
// races in two tabs. The queue itself is bounded (below) so it can't become its own memory DoS.
const MAX_CONCURRENT_HANDLER_SPAWNS = Number(process.env.SORT_MAX_CONCURRENT_SPAWNS) || 16;
const MAX_QUEUED_HANDLER_SPAWNS = Number(process.env.SORT_MAX_QUEUED_SPAWNS) || 200;
let activeHandlerSpawns = 0;
const spawnQueue = [];
function acquireSpawnSlot() {
  if (activeHandlerSpawns < MAX_CONCURRENT_HANDLER_SPAWNS) {
    activeHandlerSpawns++;
    return Promise.resolve();
  }
  if (spawnQueue.length >= MAX_QUEUED_HANDLER_SPAWNS) {
    return Promise.reject(new Error("bridge is at capacity (too many rounds in flight) -- try again shortly"));
  }
  return new Promise((resolve) => spawnQueue.push(resolve));
}
function releaseSpawnSlot() {
  const next = spawnQueue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter -- activeHandlerSpawns stays unchanged
    return;
  }
  activeHandlerSpawns--;
}

function callHandlerProcess(cmd, input, timeoutMs = TIMEOUT_MS) {
  return acquireSpawnSlot().then(() => spawnAndAwaitHandler(cmd, input, timeoutMs).finally(releaseSpawnSlot));
}

function spawnAndAwaitHandler(cmd, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Guarded on `exited`: once libuv has reaped `sh`, its pid — and therefore this pgid — can
      // be recycled, and signalling a recycled group would hit an unrelated process.
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          // ESRCH just means the group exited between the check and the signal.
          if (e.code !== "ESRCH") {
            process.stderr.write(`callHandlerProcess: could not kill process group ${child.pid}: ${e.message}\n`);
          }
        }
      }
      reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {}); // a handler that answers before draining stdin is fine
    child.stdin.write(JSON.stringify(input), () => {});
    child.stdin.end();

    child.on("exit", () => (exited = true));
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

/** #19 (ct-agent v0.4.9): one PERSISTENT role-command process per participant, holding ONE channel
 *  session for its whole life and multiplexing calls as NDJSON lines over stdio -- instead of a
 *  fresh spawn (= a fresh join + pairing + Noise handshake, and one roll of the accept side's
 *  re-park gap) per round. Measured motivation: the per-round model produced a structural 15-22%
 *  transport-fault rate (ct-agent#18) and ~200-500ms handshake overhead per round.
 *
 *  Contract with `ct-agent channel` under CT_CHANNEL_CALL_PERSISTENT=1: one JSON request per stdin
 *  line; one envelope per stdout line ({"ok":true,"output":...} / {"ok":false,"error":...} as the
 *  structured last line before a non-zero exit). Failure model: any broken call kills the child
 *  (process GROUP, same recycled-pid-guarded pattern as callHandlerProcess) and ONE respawn+retry
 *  is attempted before the error surfaces -- the run-level supervision the per-round model had,
 *  kept at run granularity. Calls are serialized per participant (arena rounds are sequential per
 *  participant anyway), so no response-to-request correlation is needed beyond FIFO. */
class PersistentRoleClient {
  /** `cmdProvider`: async () -> the full shell command to spawn. Injected (production passes the
   *  freshenedCmd + CT_CHANNEL_CALL_PERSISTENT prefix builder) so tests can substitute a stub
   *  process without a real ct-agent binary or edge. */
  constructor(cmdProvider, label = "role") {
    this.cmdProvider = cmdProvider;
    this.label = label; // for log lines only -- never secrets, never the full cmd
    this.child = null;
    this.buf = "";
    this.stderrTail = "";
    this.pendingResolve = null; // FIFO depth 1 -- calls are serialized via `chain`
    this.pendingResolveChild = null; // which child pendingResolve is actually waiting on -- guards against a stale/killed child's async close settling a NEWER call (see _callOnce)
    this.chain = Promise.resolve();
    // #25 proactive respawn (pre-warm): when the held session dies BETWEEN rounds (participant
    // restart, edge blip), waiting for the next round call to notice costs that call a full
    // dial+pair on top of its own budget -- measured live as a constant 60-100s round-1 latency
    // (2-3 stacked 30s windows) vs 110ms on an intact session. ct-agent under
    // CT_CHANNEL_CALL_PERSISTENT exits on session death, so the close handler below re-spawns
    // immediately with exponential backoff (500ms..5s cap): by the time the next round call
    // arrives, the fresh child has usually already dialed and paired. The backoff cap keeps a
    // permanently-absent peer at a modest ~5s dial cadence instead of the #250 flap-storm class.
    this.respawnDelayMs = 500;
    this.respawnTimer = null;
    this.spawnedAt = 0;
    this.spawnInFlight = null; // shared so the timer and a concurrent call never double-spawn
  }

  _log(msg) {
    process.stderr.write(`PersistentRoleClient[${this.label}] ${new Date().toISOString()} ${msg}\n`);
  }

  _scheduleRespawn(reason) {
    if (this.respawnTimer || this.child) return;
    const delay = this.respawnDelayMs;
    this.respawnDelayMs = Math.min(this.respawnDelayMs * 2, 5000);
    this._log(`scheduling proactive respawn in ${delay}ms (${reason})`);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.child) return; // a round call got there first
      this._ensureChild().catch((e) => {
        this._log(`proactive respawn failed: ${e.message}`);
        this._scheduleRespawn("previous proactive respawn failed");
      });
    }, delay);
    // Never hold the process open just for a pre-warm timer.
    if (this.respawnTimer.unref) this.respawnTimer.unref();
  }

  _ensureChild() {
    if (this.child) return Promise.resolve();
    if (!this.spawnInFlight) {
      this.spawnInFlight = this._spawn().finally(() => (this.spawnInFlight = null));
    }
    return this.spawnInFlight;
  }

  call(input, timeoutMs = TIMEOUT_MS) {
    const run = () => this._callOnce(input, timeoutMs).catch(async (first) => {
      // One respawn+retry: the child (and its held session) may have died between rounds.
      this._kill();
      try {
        return await this._callOnce(input, timeoutMs);
      } catch (second) {
        throw new Error(`persistent role command failed (retry after respawn also failed): ${second.message} (first: ${first.message})`);
      }
    });
    // Serialize per participant; a failed call must not poison the chain for the next one.
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async _callOnce(input, timeoutMs) {
    await this._ensureChild();
    const child = this.child;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._log(`call timed out after ${Math.round(timeoutMs / 1000)}s -- killing child pid ${child && child.pid}`);
        // Stale-callback race (found live 2026-08-26 while investigating a reload/new-run report):
        // _kill() here fires this child's own "close" asynchronously, sometimes AFTER call()'s
        // catch-and-retry above has already spawned a fresh child and overwritten
        // this.pendingResolve with the RETRY's callback. Without the child-identity guard below,
        // that stale close event would incorrectly reject the retry's promise using the OLD
        // child's death, even though the new child might have been about to succeed -- observed
        // live as a run cycling through repeated 30s timeouts against a participant whose fresh
        // dial should have worked. Clearing both here (not just leaving settled=true) means a
        // close event arriving after this point is unambiguously stale for THIS call.
        if (this.pendingResolveChild === child) {
          this.pendingResolve = null;
          this.pendingResolveChild = null;
        }
        this._kill(); // a stuck call kills the whole child; the NEXT call respawns
        reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pendingResolve = (err, envelope) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingResolve = null;
        this.pendingResolveChild = null;
        if (err) return reject(err);
        if (envelope.ok) {
          this.respawnDelayMs = 500; // a healthy session resets the pre-warm backoff
          return resolve(String(envelope.output ?? ""));
        }
        reject(new Error(`role command reported: ${envelope.error || "unknown error"}`));
      };
      this.pendingResolveChild = child;
      child.stdin.write(JSON.stringify(input) + "\n", (e) => {
        if (e && this.pendingResolveChild === child && this.pendingResolve) this.pendingResolve(new Error(`stdin write failed: ${e.message}`));
      });
    });
  }

  async _spawn() {
    const cmd = await this.cmdProvider();
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child;
    this.buf = "";
    this.stderrTail = "";
    this.spawnedAt = Date.now();
    this._log(`spawned child pid ${child.pid}`);
    let exited = false;
    child.on("exit", () => (exited = true));
    child._exitedFlag = () => exited;
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000); // bounded tail for error context
    });
    child.stdout.on("data", (d) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line || this.pendingResolveChild !== child || !this.pendingResolve) continue;
        try {
          this.pendingResolve(null, JSON.parse(line));
        } catch (e) {
          this.pendingResolve(new Error(`unparseable envelope line from role command: ${e.message}`));
        }
      }
    });
    child.on("close", (code) => {
      const lifeMs = Date.now() - this.spawnedAt;
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = null;
      // sort#25 follow-up (2026-08-18): stderrTail was already captured but only ever LOGGED on
      // the "died during an active call" branch below -- every idle death (the overwhelming
      // majority: ~3400/day measured) discarded ct-agent's own exit reason. Days of these logs
      // said WHAT (closed, code, how long alive) but never WHY. Log it here too so the next
      // death is diagnosable instead of guessed at.
      const tail = this.stderrTail.trim() ? ` -- stderr: ${this.stderrTail.trim().split("\n").pop()}` : "";
      // Stale-callback guard (found live 2026-08-26): this "close" is asynchronous relative to
      // whatever killed this specific child (a timeout, an explicit _kill()) -- by the time it
      // fires, call()'s own catch-and-retry may have ALREADY spawned a fresh child and moved
      // this.pendingResolve on to that new attempt. Only settle the pending call if THIS child is
      // actually the one it's waiting on (this.pendingResolveChild === child); otherwise this
      // close is stale and must not reject an unrelated, possibly-succeeding call.
      const forPendingCall = this.pendingResolveChild === child && this.pendingResolve;
      this._log(`child pid ${child.pid} closed (code ${code}) after ${Math.round(lifeMs / 1000)}s${forPendingCall ? " during an active call" : " while idle"}${tail}`);
      if (forPendingCall) {
        const resolveFn = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingResolveChild = null;
        resolveFn(
          new Error(`role command exited ${code}${this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").pop()}` : ""}`)
        );
      } else if (wasCurrent) {
        // #25: idle session death (participant restart / edge blip). Pre-warm a replacement NOW
        // so the next round call lands on an already-paired session instead of paying dial+pair
        // inside its own timeout budget.
        this._scheduleRespawn(`idle session death, code ${code}`);
      }
    });
    child.on("error", (e) => {
      if (this.child === child) this.child = null;
      if (this.pendingResolveChild === child && this.pendingResolve) {
        const resolveFn = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingResolveChild = null;
        this._log(`spawn error: ${e.message}`);
        resolveFn(new Error(`spawn failed: ${e.message}`));
      } else {
        this._log(`spawn error: ${e.message}`);
      }
    });
  }

  _kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    // Same recycled-pgid guard as callHandlerProcess: never signal a reaped group.
    if (!(child._exitedFlag && child._exitedFlag())) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") {
          process.stderr.write(`PersistentRoleClient: could not kill process group ${child.pid}: ${e.message}\n`);
        }
      }
    }
  }
}

/** Whether arena role calls hold one session per participant (#19, default ON -- the image pins
 *  ct-agent v0.4.9+ which speaks the envelope contract). SORT_PERSISTENT_CALLS=0 opts back into
 *  the historical one-shot-per-round model. */
function persistentCallsEnabled() {
  const v = (process.env.SORT_PERSISTENT_CALLS || "").trim();
  return !(v === "0" || v.toLowerCase() === "false");
}

const persistentClients = new Map(); // stored cmd -> PersistentRoleClient (one per participant)

/** The single role-call entry point the arena modes use: persistent session per participant by
 *  default (#19), one-shot per round as the opt-out. Both paths re-apply freshenedCmd at spawn
 *  time, so certs stay live either way.
 *
 *  ONLY a `ct-agent channel` command speaks the CT_CHANNEL_CALL_PERSISTENT envelope contract
 *  (one {"ok":...} line per call, long-lived process). A bridge-LOCAL handler (a plain shell
 *  script from SORT_PARTICIPANTS_FILE, e.g. reference-sorter.sh) is one-shot: it reads one
 *  round, prints one RAW move JSON ({"action":...}, no envelope), and exits. Wrapping such a
 *  handler in PersistentRoleClient misreads its first reply as a failed envelope (`ok` absent),
 *  kills+respawns, fails again, and every round surfaces as "persistent role command failed"
 *  -- reproduced live 2026-08-14 ~04:45 UTC: ALL bridge-local runs (reference-sorter included)
 *  stopped producing rounds while channel participants kept working. Channel-command detection
 *  by the literal `ct-agent channel` suffix automateApproval/freshenedCmd already construct.
 *  Local handlers also skip freshenedCmd entirely: it exists to keep CT_CHANNEL_* transport env
 *  live, which a local handler neither reads nor needs -- and skipping it avoids a per-round
 *  /pki/ca round-trip for handlers with no channel at all. */
function isChannelCmd(storedCmd) {
  return /\bct-agent channel\b/.test(storedCmd);
}
function roleCall(storedCmd, input) {
  if (!isChannelCmd(storedCmd)) {
    return callHandlerProcess(storedCmd, input);
  }
  if (!persistentCallsEnabled()) {
    return freshenedCmd(storedCmd).then((cmd) => callHandlerProcess(cmd, input));
  }
  let client = persistentClients.get(storedCmd);
  if (!client) {
    // Label: a short cmd digest -- stable per participant, never leaks key material into logs.
    const label = require("node:crypto").createHash("sha256").update(storedCmd).digest("hex").slice(0, 8);
    client = new PersistentRoleClient(async () => `CT_CHANNEL_CALL_PERSISTENT=1 ${await freshenedCmd(storedCmd)}`, label);
    persistentClients.set(storedCmd, client);
  }
  return client.call(input);
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

/** Wrap a participant's per-round dial so that a SUCCESSFUL roleCall (the participant's ct-agent
 *  actually answered) refreshes its liveness timestamp (CADS-DEMO-sort#28). A rejected dial (dial
 *  timeout / connection failure -- "no connection") deliberately does NOT touch the timestamp, so a
 *  participant whose ct-agent has gone away ages out. Harmless for base-file participants: the
 *  liveness sweep only ever considers approved-file ids, so recording a base id just no-ops there.
 *  A round even reaching the handler with a fault still counts as a connection -- the ct-agent was
 *  reachable, which is exactly what the operator's rule is about, not per-move correctness. */
function seenRecordingCall(you, cmd) {
  return (input) =>
    roleCall(cmd, input).then((r) => {
      recordParticipantSeen(you);
      participantEverAnswered.add(you);
      return r;
    });
}

async function handleRun(req, res, participants, participantId, query) {
  const config = participants.get(participantId);
  if (!config) return jsonError(res, 404, `unknown participant "${participantId}"`);
  const len = Math.min(Math.max(Number(query.get("len")) || 8, 2), MAX_ARRAY_LEN);
  const initialArray = randomArray(len);

  // "Stop" didn't stop (real, reproduced bug): a client disconnect (browser Stop button, closed
  // tab, lost connection) used to leave runSoloRun dispatching real rounds to the participant's
  // channel for the rest of its budget with nobody left to read them -- see isAborted's own
  // comment in server.lib.js for how that surfaces (multiple orphaned runs against the SAME
  // participant interleave over its one physical channel, which looks exactly like a broken
  // handler). Armed before writeHead so a disconnect during the very first write is still caught.
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

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
      callHandler: seenRecordingCall(config.you, config.cmd),
      onRound: (entry) => sendNdjson(res, { stage: "round", ...entry }),
      isAborted: () => aborted,
    });
    sendNdjson(res, {
      stage: "final",
      you: result.you,
      finalArray: result.finalArray,
      finishedCorrectly: result.finishedCorrectly,
      comparisons: result.comparisons,
      swaps: result.swaps,
      faults: result.faults,
      // ALWAYS explicit, even at 0 (tester finding, #9 retest 6): for a SCORED metric the
      // explicit zero is the statement ("zero transport faults"), and a client cannot tell a
      // conditionally-omitted field from "this deployment predates the feature" -- which broke
      // exactly the regression measurement the field exists for. ?? 0 keeps the event stable
      // even if an older lib result ever lacks the counter.
      transportFaults: result.transportFaults ?? 0,
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

  // See handleRun's own comment: a client disconnect must stop new rounds from being dispatched,
  // or an orphaned race keeps hammering every one of its participants' channels in the background.
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  sendNdjson(res, { stage: "start", mode: "race", participants: chosen.map((c) => c.you), initialArray });

  try {
    const result = await runRaceSession({
      participants: chosen.map((c) => ({ you: c.you, callHandler: seenRecordingCall(c.you, c.cmd) })),
      initialArray,
      budget: resolveBudget(query),
      onRound: (entry) => sendNdjson(res, { stage: "round", ...entry }),
      isAborted: () => aborted,
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

  // See handleRun's own comment: a client disconnect must stop new rounds from being dispatched,
  // or an orphaned partition run keeps hammering every one of its participants' channels.
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });

  try {
    const segments = []; // filled in below, but participants need to know their own segment before the first round event
    const chosenWithHandlers = chosen.map((c) => ({ you: c.you, callHandler: seenRecordingCall(c.you, c.cmd) }));
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
      isAborted: () => aborted,
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

// In-memory-only OIDC session, started by an admin submitting a real browser-obtained token pair
// via POST /api/admin/oidc-session (see handleOidcSessionSubmit) -- the operator types their
// password into a real HTML form in THEIR OWN browser; only the resulting access+refresh tokens
// ever reach this process, never the password. Once started, the bridge self-refreshes the
// access token on a timer using ONLY the refresh token (a normal, intended use of a refresh
// token -- this is not a workaround of anything, it's what refresh tokens are for) until the
// refresh token's own lifetime runs out, then goes back to failing closed. Deliberately not
// persisted to disk: a bridge restart just means the operator starts a fresh session, same as
// any other web session expiring.
let liveOidcSession = null; // {accessToken, accessExpiresAt, refreshToken, sessionDeadline}
let oidcRefreshTimer = null;

// Service-account (client_credentials) token cache -- the DURABLE auth tier (sort#9): a
// confidential Keycloak client whose secret is mounted at SORT_OIDC_CLIENT_SECRET_FILE. Unlike
// the admin.html browser session (in-memory, wiped on every bridge redeploy -- the recurring
// "approvals silently break after a deploy" incident), this survives restarts because the bridge
// re-mints on demand from the mounted secret, no human re-arm and no refresh token. Preferred
// over both the browser session and the static SORT_OIDC_TOKEN when configured.
let serviceOidcToken = null; // {token, expiresAt}

function serviceClientSecret() {
  return readSecret("SORT_OIDC_CLIENT_SECRET"); // reads the _FILE variant transparently
}

/** Mint (or return a still-valid cached) service-account access token via client_credentials.
 *  Async; callers that need a token synchronously fall back through currentOidcToken(). Caches
 *  with a 30s safety margin before the real expiry so an in-flight cpFetch never races expiry. */
async function ensureServiceOidcToken() {
  const secret = serviceClientSecret();
  const issuerBase = process.env.SORT_OIDC_ISSUER_BASE;
  if (!secret || !issuerBase) return null;
  if (serviceOidcToken && serviceOidcToken.expiresAt - 30_000 > Date.now()) return serviceOidcToken.token;
  // Dedicated client id for the service tier -- deliberately NOT SORT_OIDC_CLIENT_ID (that one
  // is the browser-session/refresh client, `admin-cli`). They are different Keycloak clients: a
  // confidential client_credentials client here, the public browser client there. Sharing one
  // env var would let overriding the service client id silently break browser-session refresh.
  const resp = await fetch(`${issuerBase.replace(/\/$/, "")}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SORT_OIDC_SERVICE_CLIENT_ID || "sort-bridge-automation",
      client_secret: secret,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`client_credentials grant failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  serviceOidcToken = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(30, Number(body.expires_in) || 0) * 1000,
  };
  return serviceOidcToken.token;
}

function currentOidcToken() {
  // Prefer the durable service token when it's cached and valid; then the browser session; then
  // the static fallback. ensureServiceOidcToken() (async) is what keeps the first branch fresh --
  // cpFetch awaits it before every CP call, so by the time this sync getter runs the cache is warm.
  if (serviceOidcToken && serviceOidcToken.expiresAt - 30_000 > Date.now()) return serviceOidcToken.token;
  if (liveOidcSession && liveOidcSession.accessExpiresAt > Date.now()) return liveOidcSession.accessToken;
  return readSecret("SORT_OIDC_TOKEN");
}

function automationConfigured() {
  // A configured service-account secret counts as an available token even before the first
  // cpFetch has warmed the cache -- otherwise automation reports "not configured" at boot until
  // something happens to mint a token, exactly the false-negative that made a redeploy look like
  // it had lost automation. currentOidcToken() covers the session/static tiers.
  const haveTokenSource = Boolean(
    (serviceClientSecret() && process.env.SORT_OIDC_ISSUER_BASE) || currentOidcToken()
  );
  return Boolean(
    // sort#43: specifically the _FILE form -- mintGrants() now refuses the plain-env-var fallback
    // (see its own comment), so reporting "configured" for a deployment that only set the plain
    // var would be a false positive that fails later, deep inside the first real mint call.
    process.env.SORT_CHANNEL_OPERATOR_KEY_FILE &&
      readSecret("SORT_CHANNEL_BRIDGE_HOLDER_KEY") &&
      readSecret("SORT_CHANNEL_BRIDGE_NOISE_KEY") &&
      process.env.SORT_CP_URL &&
      haveTokenSource &&
      process.env.SORT_CHANNEL_BROKER &&
      process.env.SORT_CHANNEL_RELAY
  );
}

const OIDC_CLIENT_ID = process.env.SORT_OIDC_CLIENT_ID || "admin-cli";

async function refreshOidcToken(issuerBase, refreshToken) {
  const resp = await fetch(`${issuerBase.replace(/\/$/, "")}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: OIDC_CLIENT_ID, refresh_token: refreshToken }),
  });
  if (!resp.ok) throw new Error(`refresh_token grant failed: HTTP ${resp.status}`);
  return resp.json();
}

/** POST /api/admin/oidc-session -- admin-only. Body: {accessToken, refreshToken, expiresIn,
 *  refreshExpiresIn} -- exactly the four fields a real browser-side password-grant response
 *  carries (see admin.html's login form). Starts (or replaces) the self-refreshing session
 *  described above. */
async function handleOidcSessionSubmit(req, res) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonError(res, 400, e.message || "invalid request body");
  }
  const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = body || {};
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    !Number.isFinite(expiresIn) ||
    !Number.isFinite(refreshExpiresIn)
  ) {
    return jsonError(res, 400, "accessToken, refreshToken (non-empty strings), expiresIn, refreshExpiresIn (numbers) required");
  }
  const issuerBase = process.env.SORT_OIDC_ISSUER_BASE;
  if (!issuerBase) return jsonError(res, 503, "SORT_OIDC_ISSUER_BASE not configured on this deployment");

  if (oidcRefreshTimer) clearTimeout(oidcRefreshTimer);
  const sessionDeadline = Date.now() + refreshExpiresIn * 1000;
  liveOidcSession = { accessToken, accessExpiresAt: Date.now() + expiresIn * 1000, refreshToken, sessionDeadline };

  const scheduleNext = (delayMs) => {
    oidcRefreshTimer = setTimeout(async () => {
      if (!liveOidcSession || Date.now() >= liveOidcSession.sessionDeadline) {
        liveOidcSession = null;
        oidcRefreshTimer = null;
        return;
      }
      try {
        const fresh = await refreshOidcToken(issuerBase, liveOidcSession.refreshToken);
        liveOidcSession = {
          accessToken: fresh.access_token,
          accessExpiresAt: Date.now() + fresh.expires_in * 1000,
          refreshToken: fresh.refresh_token || liveOidcSession.refreshToken,
          sessionDeadline: liveOidcSession.sessionDeadline,
        };
        scheduleNext(Math.max(5_000, (fresh.expires_in - 30) * 1000));
      } catch (e) {
        process.stderr.write(`bridge: oidc auto-refresh failed, session ended early: ${e.message || e}\n`);
        liveOidcSession = null; // fail closed -- automationConfigured()/cpFetch go back to the
        oidcRefreshTimer = null; // static SORT_OIDC_TOKEN (or unconfigured) honestly, no fake success
      }
    }, delayMs);
  };
  scheduleNext(Math.max(5_000, (expiresIn - 30) * 1000));

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, activeUntil: new Date(sessionDeadline).toISOString() }));
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
    // sort#43: refuse rather than fall back to `--operator-private <hex>`. That form puts the
    // operator's private key on this process's own argv -- visible to any co-resident process via
    // e.g. /proc/<pid>/cmdline for the duration of every mint call (documented in
    // grant/src/main.rs's own doc comment) -- and, on a grant-binary failure, execFile's Error
    // re-embeds the full argv it ran, so the same key would additionally land in whatever catches
    // and logs that error. Fail closed here instead: automationConfigured() (below) already
    // requires this exact var, so a deployment that reaches this function without it set is
    // misconfigured, not merely missing an optional secret.
    if (!operatorKeyFile) {
      return reject(new Error(
        "SORT_CHANNEL_OPERATOR_KEY_FILE is not set -- refusing to pass the operator private key as " +
          "a CLI argument. Set SORT_CHANNEL_OPERATOR_KEY_FILE to a file path (never " +
          "SORT_CHANNEL_OPERATOR_KEY alone) to mint grants."
      ));
    }
    const operatorArgs = ["--operator-private-file", operatorKeyFile];
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

/** POST to the control plane with a bearer token. Token source is the three-tier precedence in
 *  currentOidcToken(): the durable service-account client_credentials tier
 *  (SORT_OIDC_CLIENT_SECRET_FILE + SORT_OIDC_ISSUER_BASE, re-minted on demand -- survives
 *  redeploys, no human re-arm), then the admin.html browser session (in-memory, wiped on
 *  redeploy), then the static SORT_OIDC_TOKEN last resort. cpFetch warms the service token first
 *  so it wins when configured. See docs/operations.md. */
/** Is `s` a decodable hex-DER string (non-empty, even length, hex chars only)? The gate every
 *  outbound trust-anchor value must pass -- see edgeCertHex() for the incident that makes this
 *  non-negotiable. */
function validHexDer(s) {
  return typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/** The edge trust-anchor cert as hex DER, fetched LIVE from the control plane's GET /pki/ca
 *  (cached 5 min), env fallback only if it validates.
 *
 *  Incident, 2026-08-13 (#9 retest): SORT_CHANNEL_FRONT_DOOR_CERT -- a hand-copied deploy-time
 *  env constant -- served an ODD-length (undecodable) hex string that was ALSO a stale cert:
 *  the edge CA was reissued at 15:24 UTC and the env value still carried the Aug-12 cert,
 *  corrupted by 3 dropped characters somewhere in the copy. Every participant following
 *  join.html AND the bridge's own role command (same env var) died instantly with
 *  `CT_CHANNEL_FRONT_DOOR_CERT must be hex DER` -- measured as 600/600 arena rounds faulting at
 *  ~90ms. A hand-copied cert constant can never survive a CA reissue; the CP's /pki/ca is the
 *  single source of truth (ct-agent's own docs point CT_CHANNEL_RELAY_GATE_CERT at the same
 *  endpoint), so serve THAT. The response is accepted as hex text or raw DER bytes (hex-encoded
 *  here); anything that fails validHexDer is never served -- better to omit the fallback rungs
 *  than to hand out a value that crashes every consumer. */
let cachedEdgeCert = { hex: null, fetchedAt: 0 };
const EDGE_CERT_TTL_MS = 5 * 60 * 1000;
async function edgeCertHex() {
  const now = Date.now();
  if (cachedEdgeCert.hex && now - cachedEdgeCert.fetchedAt < EDGE_CERT_TTL_MS) return cachedEdgeCert.hex;
  try {
    const resp = await fetch(`${process.env.SORT_CP_URL}/pki/ca`);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const asText = buf.toString("utf8").trim();
      const hex = validHexDer(asText) ? asText.toLowerCase() : buf.toString("hex");
      if (validHexDer(hex)) {
        cachedEdgeCert = { hex, fetchedAt: now };
        return hex;
      }
    }
  } catch {
    // CP unreachable -- fall through to the env fallback below.
  }
  const env = process.env.SORT_CHANNEL_FRONT_DOOR_CERT;
  return validHexDer(env) ? env.toLowerCase() : null;
}

/** The edge's #330 relay-gate host:port (the `:443`-multiplexed gated Circuit-Relay v2 path a
 *  NAT'd participant needs -- CT_CHANNEL_RELAY_GATE is deliberately NOT interchangeable with
 *  CT_CHANNEL_RELAY, and omitting it fails silently). Env override SORT_CHANNEL_RELAY_GATE
 *  first; otherwise derived from the CP's GET /network-info `channel_relay_gate_port` + the
 *  front-door/broker host (cached 5 min). Measured impact of publishing this (same v0.4.8, same
 *  grant, 90-100s window): 0 sessions without it vs 3 stable sessions with it. */
let cachedRelayGate = { addr: null, fetchedAt: 0 };
async function relayGateAddr() {
  if (process.env.SORT_CHANNEL_RELAY_GATE) return process.env.SORT_CHANNEL_RELAY_GATE;
  const now = Date.now();
  if (cachedRelayGate.addr && now - cachedRelayGate.fetchedAt < EDGE_CERT_TTL_MS) return cachedRelayGate.addr;
  try {
    const resp = await fetch(`${process.env.SORT_CP_URL}/network-info`);
    if (resp.ok) {
      const info = await resp.json();
      const port = info && info.channel_relay_gate_port;
      const hostSource = process.env.SORT_CHANNEL_FRONT_DOOR || process.env.SORT_CHANNEL_BROKER || "";
      const host = hostSource.includes(":") ? hostSource.slice(0, hostSource.lastIndexOf(":")) : hostSource;
      if (port && host) {
        cachedRelayGate = { addr: `${host}:${port}`, fetchedAt: now };
        return cachedRelayGate.addr;
      }
    }
  } catch {
    // CP unreachable -- omit the relay gate rather than serve a guess.
  }
  return null;
}

/** Re-inject the CURRENT front-door transport env into a stored role command (#9 retest 2,
 *  2026-08-13): approved participants persist their `cmd` string as built AT APPROVAL TIME --
 *  including whatever CT_CHANNEL_FRONT_DOOR_CERT was current (or, in the incident, corrupted)
 *  back then. Fixing the construction site alone therefore healed only FUTURE approvals; every
 *  existing participant (the tester's insertion-fan-048 among them) kept faulting 600/600 with
 *  `must be hex DER` because each round re-ran the stale stored string. Baked-in volatile values
 *  can also never survive a CA reissue. So: strip any front-door tokens the stored cmd carries
 *  and prepend today's validated ones at CALL time -- old participants heal without
 *  re-approval, and a future CA rotation is picked up within the cert cache TTL. */
async function freshenedCmd(storedCmd) {
  // sort#40: strip any bridge holder/noise key that ended up baked into an already-persisted
  // stored cmd (either from before this fix, or from the brief live-exposure window it closes --
  // see the ops ledger) as well as the volatile front-door tokens below. Every `ct-agent channel`
  // cmd on this bridge is always automateApproval's own initiate-role dial (the only place one is
  // constructed, per its own comment), so it is always THIS bridge's identity, never a
  // participant-specific one -- safe, and correct, to unconditionally re-inject it fresh here
  // rather than trust whatever a stored string happens to carry.
  const stripped = storedCmd.replace(
    /CT_CHANNEL_(?:FRONT_DOOR(?:_CERT|_ONLY)?|RELAY_GATE(?:_CERT)?|HOLDER_KEY|NOISE_KEY)=\S+\s+/g,
    ""
  );
  const bridgeHolderKey = readSecret("SORT_CHANNEL_BRIDGE_HOLDER_KEY");
  const bridgeNoiseKey = readSecret("SORT_CHANNEL_BRIDGE_NOISE_KEY");
  const bridgeKeyEnv =
    bridgeHolderKey && bridgeNoiseKey ? `CT_CHANNEL_HOLDER_KEY=${bridgeHolderKey} CT_CHANNEL_NOISE_KEY=${bridgeNoiseKey} ` : "";
  // Same "skip the round-trip when it can't matter" discipline as automateApproval: this runs on
  // EVERY invocation of a stored command (every round, for every approved participant), so an
  // unconditional fetch here is a real per-round control-plane call in any deployment that
  // hasn't configured a front door at all, not just a one-time cost.
  const liveCert = process.env.SORT_CHANNEL_FRONT_DOOR ? await edgeCertHex() : null;
  const frontDoorEnv =
    process.env.SORT_CHANNEL_FRONT_DOOR && liveCert
      ? `CT_CHANNEL_FRONT_DOOR=${process.env.SORT_CHANNEL_FRONT_DOOR} CT_CHANNEL_FRONT_DOOR_CERT=${liveCert} CT_CHANNEL_FRONT_DOOR_ONLY=1 `
      : "";
  // Retest 4 CORRECTION -- CT_CHANNEL_RELAY_GATE is deliberately NOT injected here anymore.
  // ct-agent's gate mode (`join_via_relay_gate_dcutr`) runs the channel-join ADMISSION over a
  // plain QUIC connection to the relay port (:4436) regardless -- the :443 gate only carries
  // the post-admission Circuit-Relay leg (verified in ct-agent channel_run.rs; its own comment
  // says the admission conn "is unconditionally a QUIC connection ... to the relay/broker
  // port, not the :443 relay-gate leg at all"). On this UDP-blocked host the gate mode
  // therefore made the bridge's Initiate DIE at admission ("Error: TimedOut") instead of using
  // the :443 front-door ladder it can actually reach -- and even for UDP-capable members the
  // gate path parks them in the edge's QUIC pairer while the bridge parks in the :443 pairer,
  // where the two can never pair (CADS-Tunnel#495). Until #495 unifies the pairers, BOTH
  // halves of an arena pairing must dial :443 front-door-only -- which frontDoorEnv above
  // already enforces. The stripping regex still removes any RELAY_GATE tokens baked into
  // stored commands by the brief window where this file injected them.
  return bridgeKeyEnv + frontDoorEnv + stripped;
}

async function cpFetch(path, body) {
  // Warm the durable service token first (no-op when the client secret isn't configured), so
  // currentOidcToken() below returns it rather than a wiped session or a stale static token.
  try {
    await ensureServiceOidcToken();
  } catch (e) {
    process.stderr.write(`cpFetch: service token mint failed, falling back: ${e.message}\n`);
  }
  const token = currentOidcToken();
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
/** The wording for a holder-pair channel collision (see the call site for the incident).
 *  Pure, so the message itself is testable without minting a grant or reaching a control
 *  plane -- the message is the whole point of this branch, so it is what gets frozen. */
function channelCollisionDetail(channelHex) {
  return (
    `channel ${channelHex} is already registered under a different account. ` +
    `This is a collision, not a missing permission: the channel id is derived from ` +
    `your holder key, so re-joining under a different participant NAME cannot change ` +
    `it. Either join with a freshly generated holder keypair, or have the current ` +
    `owner delete that channel (DELETE /me/channels/${channelHex}).`
  );
}

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
    // The channel id is derived deterministically from the holder PAIR (bridge holder +
    // participant holder), so a 403 here does not mean "this account lacks permission" --
    // it means this exact holder pair already has a channel registered under some other
    // subject. A tester hit this on 2026-08-17, tried twice under two different display
    // names, got the identical error (same holder key -> same channel id) and reasonably
    // concluded their account needed to be "authorised for the channel". There is no such
    // thing to authorise: every participant gets their OWN channel. The raw control-plane
    // wording ("channel owned by another subject") reads like a permission problem, so say
    // what it actually is and name the id the next step needs.
    if (reg.status === 403) {
      return { ok: false, detail: channelCollisionDetail(minted.channel) };
    }
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

  // Portal grant deposit (CADS-Tunnel#514, live since 2026-08-15; unblocks CADS-DEMO-sort#20):
  // deposit the participant's own grant (grantB) with the control plane, so it is durably
  // claimable at /portal/channels/<channel>/claim with a filled .env block -- independent of
  // this bridge's own delivery slot. The one-shot status-poll path (pendingGrantDelivery)
  // remains the fast path; this is the platform-level end of the sort#26/#28 stranded-grant
  // class: no bridge-side mishap (redeploy, roster cleanup, crash) can take the participant's
  // only copy with it anymore. Deliberately BEST-EFFORT: a deposit failure must not fail an
  // approval whose channel + members are already registered (the participant is live either
  // way) -- it is logged loudly and surfaced in the result instead, never silently swallowed.
  // The CP validates the grant against its embedded channel/holder ids (a mismatch is a 400,
  // not a silent stranding -- core's own contract for the endpoint).
  let portalDeposit = false;
  try {
    const dep = await cpFetch(`/me/channels/${minted.channel}/grants/${pending.holderPub}`, { grant: minted.grantB });
    portalDeposit = dep.status === 200;
    if (!portalDeposit) {
      process.stderr.write(
        `join-requests: portal grant deposit for "${pending.you}" -> ${dep.status} ${String(dep.text).slice(0, 200)} ` +
          `(approval unaffected; one-shot delivery still available)\n`
      );
    }
  } catch (e) {
    process.stderr.write(
      `join-requests: portal grant deposit for "${pending.you}" failed: ${e.message} (approval unaffected)\n`
    );
  }

  // #106 :443 fallback, same optional treatment as everywhere else this pair appears --
  // present only when this deployment has actually set the front door.
  //
  // The CERT comes from edgeCertHex() (live /pki/ca, validated), NOT the raw env var: the
  // bridge's own role command died on the corrupted/stale env value exactly like every
  // participant did (see edgeCertHex's incident comment) -- 600/600 rounds faulting with
  // `CT_CHANNEL_FRONT_DOOR_CERT must be hex DER`.
  //
  // CT_CHANNEL_FRONT_DOOR_ONLY=1 (new in ct-agent v0.4.8): the edge runs the :443 front-door
  // pairer and the QUIC/relay pairer (:4436) as SEPARATE instances (CADS-Tunnel#495), so two
  // members only pair if they park in the SAME one. This host's own UDP/QUIC is confirmed
  // permanently blocked (13/13 port-scan failures), so the dial ladder here always lands on
  // :443 -- but a participant whose own UDP works would otherwise land in the QUIC pairer
  // instead, and both sides would park in different pairers, find no partner, and get reaped
  // after the 30s TTL (surfaces client-side as "edge broker refused the channel join" ~32-41s
  // in, not an obvious timeout). Forcing FRONT_DOOR_ONLY=1 here makes the bridge's own half
  // deterministic regardless of the participant's transport; join.js's own accept-side command
  // sets the same flag, until the edge ships transport-unified pairing (#495). The flag stays
  // coupled to the front-door pair being present: v0.4.8 refuses FRONT_DOOR_ONLY at parse time
  // without CT_CHANNEL_FRONT_DOOR(+_CERT), so emitting it with a null cert would crash the
  // command exactly like the incident did.
  // Skip the /pki/ca round-trip entirely when this deployment hasn't configured a front door at
  // all -- no point fetching a cert nothing will use, and it keeps automateApproval's real
  // control-plane call count matching what a given deployment's config actually needs.
  const liveCert = process.env.SORT_CHANNEL_FRONT_DOOR ? await edgeCertHex() : null;
  const frontDoorEnv =
    process.env.SORT_CHANNEL_FRONT_DOOR && liveCert
      ? `CT_CHANNEL_FRONT_DOOR=${process.env.SORT_CHANNEL_FRONT_DOOR} CT_CHANNEL_FRONT_DOOR_CERT=${liveCert} CT_CHANNEL_FRONT_DOOR_ONLY=1 `
      : "";
  // CT_CHANNEL_RELAY_ONLY=1: the bridge only ever DIALS OUT to a participant (initiate role) --
  // it's never dialed back, so it has no dialable address of its own and needs none. Without
  // this, ChannelJoinCliConfig::from_lookup requires CT_CHANNEL_LISTEN (a real support case:
  // confirmed live, every round faulted with "CT_CHANNEL_LISTEN required (advertised host:port)
  // -- or set CT_CHANNEL_RELAY_ONLY=1 for a relay-only member with no dialable address" the
  // moment CADS-DEMO-sort#9's ct-agent-binary-missing gap above was fixed and this cmd actually
  // ran for the first time). Same flag join.js's own accept-side command already correctly sets
  // for the participant's half of this same pairing.
  // Retest 4: deliberately NO CT_CHANNEL_RELAY_GATE here (nor in freshenedCmd) -- ct-agent's
  // gate mode runs its ADMISSION over QUIC :4436 regardless (the :443 gate only carries the
  // post-admission circuit), which this UDP-blocked host cannot reach, and which would park a
  // UDP-capable peer in the edge's QUIC pairer while this side parks in the :443 pairer
  // (disjoint pairers, CADS-Tunnel#495). Until #495, both halves of a pairing must be
  // front-door-only, which frontDoorEnv enforces.
  // sort#40: the bridge's own long-term CT_CHANNEL_HOLDER_KEY/CT_CHANNEL_NOISE_KEY must never be
  // baked into this string -- it's persisted verbatim per participant (addApprovedParticipant)
  // and served back verbatim to any admin session (GET /api/participants/approved), so every
  // self-service join used to multiply at-rest plaintext copies of the bridge's real identity,
  // not a per-participant secret. freshenedCmd (same place CT_CHANNEL_FRONT_DOOR_CERT is already
  // re-injected fresh per call, for the same "never trust what was baked in at approval time"
  // reason) now injects both keys from readSecret() at actual spawn time instead -- never
  // written to disk, never serialized in an HTTP response.
  const cmd =
    `CT_CHANNEL_ROLE=initiate CT_CHANNEL_RELAY_ONLY=1 CT_CHANNEL_CALL_SERVICE=text_generation ` +
    `CT_CHANNEL_GRANT=${minted.grantA} ` +
    `CT_CHANNEL_BROKER=${process.env.SORT_CHANNEL_BROKER} CT_CHANNEL_RELAY=${process.env.SORT_CHANNEL_RELAY} ` +
    frontDoorEnv +
    `ct-agent channel`;

  return { ok: true, channel: minted.channel, cmd, grantB: minted.grantB, portalDeposit };
}

// ---- Waiting room: route handlers --------------------------------------------------------------

/** GET /api/channel-info -- public, unauthenticated. The pubkeys are the deployment's own PUBLIC
 *  keys (never a secret), needed by a participant's own client-side identity generation
 *  (channel_id_for_link(operatorPub, bridgeHolderPub, holderPub)) to produce a join-request
 *  submission. broker/relay are this deployment's Agent-Fabric edge host:port -- also not
 *  secret (every participant needs them to dial in after approval anyway, same values
 *  docs/onboarding.md tells a manual joiner to read from GET <cp-url>/network-info) -- exposed
 *  here too so join.js can hand back a fully filled-in serve command once approved, instead of
 *  making the participant cross-reference a separate doc for two host:port strings.
 *  channelFrontDoor/channelFrontDoorCert are the CADS-Tunnel #106 `:443` TLS-TCP fallback for
 *  participants whose network blocks the direct broker/relay ports (empirically: some corporate/
 *  sandboxed networks pass ICMP and :4433 but filter :4435/:4436, per a real support case) --
 *  same non-secret treatment as broker/relay (the cert is the edge's own TLS leaf, a public trust
 *  anchor for the pinned TLS-TCP dial, not a private key). Both are optional/nullable: a
 *  deployment that hasn't set SORT_CHANNEL_FRONT_DOOR simply omits the fallback, same as an
 *  unconfigured broker/relay already does. */
async function handleChannelInfo(req, res) {
  // Live-validated trust anchor + relay gate (see edgeCertHex/relayGateAddr): a corrupted or
  // stale cert is never served (null omits the fallback instead of crashing every consumer),
  // and the #330 relay gate every NAT'd participant needs is finally published here too.
  const cert = await edgeCertHex();
  const relayGate = await relayGateAddr();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      // CADS-DEMO-sort#52: lets an outside reader tell what's actually running apart from
      // whatever they last read from source control -- see the Dockerfile's own comment on
      // SORT_DEPLOY_SHA. null (not "" or a stale value) when the image was built without the
      // build-arg, so a caller can tell "unknown" apart from "matches something specific".
      deploySha: process.env.SORT_DEPLOY_SHA || null,
      operatorPubkey: process.env.SORT_CHANNEL_OPERATOR_PUBKEY || null,
      bridgeHolderPubkey: process.env.SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY || null,
      channelBroker: process.env.SORT_CHANNEL_BROKER || null,
      channelRelay: process.env.SORT_CHANNEL_RELAY || null,
      channelFrontDoor: process.env.SORT_CHANNEL_FRONT_DOOR || null,
      channelFrontDoorCert: cert,
      // #330: the :443-multiplexed gated relay a NAT-only participant MUST use in addition to
      // broker/relay (not interchangeable with channelRelay; omitting it fails silently). The
      // cert is the same /pki/ca trust anchor as the front door's.
      channelRelayGate: relayGate,
      channelRelayGateCert: relayGate ? cert : null,
      // Not secret -- a realm base URL, same as CADS-Tunnel's own public agent-onboarding docs
      // already publish. admin.html's login form uses this to know where to POST the password
      // grant (see docs/operations.md); the password itself never reaches this bridge.
      oidcIssuerBase: process.env.SORT_OIDC_ISSUER_BASE || null,
      oidcClientId: OIDC_CLIENT_ID,
      // Auto-approval (2026-08-13): lets join.js show accurate copy instead of a generic
      // "waiting for review" message. `gateAuthenticated` reflects THIS request's own
      // X-Gate-Email (Caddy's forward_auth already ran before this handler by the time we're
      // here) -- true only when the join page's Keycloak gate is both configured AND actually
      // enforcing (the portal's per-tunnel "require login" toggle, see Caddyfile's own comment
      // on that being a separate operator switch from forward_auth simply being wired up).
      autoApproveAvailable: automationConfigured(),
      gateAuthenticated: Boolean(gateVerifiedEmail(req)),
    })
  );
}

/** POST /api/join-requests -- public (gate-exempt in Caddy), rate-limited. Validates shape, then
 *  cryptographically verifies the attestation BEFORE queuing: the bridge independently recomputes
 *  channel_id_for_link(operatorPub, bridgeHolderPub, holderPub) itself rather than trusting a
 *  caller-supplied channel id, so a bad submission is rejected at submit time (400), not
 *  discovered by an operator later at approval time. */
async function handleJoinRequestSubmit(req, res, joinRequests, participants, pendingGrantDelivery) {
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

  // A holderPub, not `you`, is what channelIdForLink is a function of -- two different
  // participant ids submitted with the SAME holderPub don't get two channels, they get one
  // channel wearing two labels. Whichever ct-agent process actually holds that channel then
  // silently answers for both ids, so a round dispatched to the OTHER label gets a reply from
  // the wrong handler (looks like "my strategy isn't running" or nonsensical moves, not an
  // error). Reject the collision here, at submit time, rather than let it happen invisibly --
  // this is the join.html "Generate a different identity" button existing for a reason, just
  // not one the page told anyone about before now.
  const collidingLive = [...participants].find(([otherYou, entry]) => otherYou !== you && entry.holderPub === holderPub);
  if (collidingLive) {
    return jsonError(
      res,
      409,
      `this browser identity is already the live participant "${collidingLive[0]}" -- one holder key backs ` +
        `exactly one participant id (they'd otherwise share the same underlying channel). Release it first ` +
        `with POST /api/participants/${encodeURIComponent(collidingLive[0])}/leave, or click "Generate a ` +
        `different identity" above before submitting a new id.`
    );
  }
  const collidingPending = [...joinRequests].find(([otherYou, entry]) => otherYou !== you && entry.holderPub === holderPub);
  if (collidingPending) {
    return jsonError(
      res,
      409,
      `this browser identity already has a pending join request as "${collidingPending[0]}" -- one holder key ` +
        `backs exactly one participant id. Wait for that request to resolve, or click "Generate a different ` +
        `identity" above before submitting a new id.`
    );
  }

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

  // Auto-approval (2026-08-13): a Keycloak login is sufficient legitimization -- when Caddy's
  // gate verified a real account for this request AND automation is configured, approve
  // immediately instead of queuing for a manual admin click. `gateVerifiedEmail` deliberately
  // does NOT check SORT_ADMIN_EMAILS here (unlike requireAdmin) -- ANY real, gate-authenticated
  // account is enough to legitimize a participant; the admin allowlist stays specific to admin
  // ACTIONS (revoke, viewing the roster), a different and stricter question. Falls through to
  // the historical manual-queue path when either condition is false -- an ungated deployment
  // (Caddy's tunnel-level "require login" toggle is off) or one without automation configured
  // keeps working exactly as before, no behavior change for those.
  const gateEmail = gateVerifiedEmail(req);
  if (gateEmail && automationConfigured()) {
    if (autoApproveRateLimited(gateEmail)) {
      return jsonError(
        res,
        429,
        `too many participants approved for this account in the last hour (max ${AUTO_APPROVE_RATE_LIMIT}) -- try again later`
      );
    }
    const pending = { you, label: label || you, holderPub, noisePub, attestation };
    let result;
    try {
      result = await automateApproval(pending);
    } catch (e) {
      process.stderr.write(`join-requests: auto-approval failed for "${you}" (${gateEmail}): ${e.message}\n`);
      return jsonError(res, 500, "automated approval failed -- see bridge logs");
    }
    if (!result.ok) {
      return jsonError(res, 502, `automated approval failed: ${result.detail}`);
    }
    addApprovedParticipant(participants, { you, label: pending.label, cmd: result.cmd, holderPub: pending.holderPub });
    pendingGrantDelivery.set(you, { channel: result.channel, grantB: result.grantB, createdAt: Date.now() });
    persistPendingGrants(pendingGrantDelivery);
    process.stderr.write(`join-requests: auto-approved "${you}" (${gateEmail})\n`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, channelId: channel.toString("hex"), approved: true }));
    return;
  }

  joinRequests.set(you, { you, label: label || you, holderPub, noisePub, attestation, createdAt: Date.now() });
  persistJoinRequests(joinRequests);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, channelId: channel.toString("hex"), approved: false }));
}

/** GET /api/whoami -- ALWAYS behind Caddy's forward_auth (see Caddyfile's @whoami block):
 *  reaching this handler at all proves the gate verified a real Keycloak account, so it just
 *  echoes the verified identity + whether auto-approval would apply. join.js uses it for
 *  accurate "logged in as X" copy; it exposes nothing an authenticated caller doesn't already
 *  know about themselves. */
function handleWhoami(req, res) {
  const email = gateVerifiedEmail(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ email, autoApprove: Boolean(email && automationConfigured()) }));
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
  addApprovedParticipant(participants, { you: pending.you, label: pending.label, cmd: result.cmd, holderPub: pending.holderPub });
  pendingGrantDelivery.set(you, { channel: result.channel, grantB: result.grantB, createdAt: Date.now() });
  persistPendingGrants(pendingGrantDelivery);
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
// CADS-DEMO-sort#57: this route is deliberately unauthenticated (grant strings are only usable
// by whoever holds the matching holder private key), but the previous single-shot delete-on-finish
// meant the FIRST reader consumed the grant, not necessarily the participant -- a monitoring
// script, a second tab, or a stray curl could silently eat a legitimate participant's only copy.
// Fix: delivery is idempotent for a short grace window after the first successful read, so a
// duplicate reader within the window gets the same grant harmlessly; the entry only expires
// (lazily, on the next status check) once the window has passed.
const GRANT_DELIVERY_GRACE_MS = 30_000;

function handleJoinRequestStatus(req, res, joinRequests, pendingGrantDelivery, you) {
  if (pendingGrantDelivery.has(you)) {
    const entry = pendingGrantDelivery.get(you);
    const now = Date.now();
    if (entry.firstDeliveredAt && now - entry.firstDeliveredAt > GRANT_DELIVERY_GRACE_MS) {
      // Grace window elapsed since the first successful delivery -- expire lazily here rather
      // than on a timer, same style as the rest of this file's in-memory maps.
      pendingGrantDelivery.delete(you);
      persistPendingGrants(pendingGrantDelivery);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      // Delete only once the response has actually finished writing -- a connection reset
      // mid-response (real, reproduced: CADS-DEMO-sort#9, intermittent `RemoteDisconnected`
      // against this same bridge from one real participant's network) must not be treated as
      // delivered. Deleting eagerly (the previous behavior) meant that exact failure silently
      // destroyed the participant's only copy of grantB with no retry path -- "single delivery"
      // was meant to stop a stale grant lingering forever, not to punish a dropped connection.
      res.on("finish", () => {
        if (!entry.firstDeliveredAt) {
          entry.firstDeliveredAt = Date.now();
          persistPendingGrants(pendingGrantDelivery);
        }
      });
      res.end(JSON.stringify({ status: "approved", channel: entry.channel, grant: entry.grantB }));
      return;
    }
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

/** POST /api/participants/:you/leave -- public, but self-AUTHENTICATING (CADS-DEMO-sort#30: join
 *  is self-service, leaving was not -- the only exit was the 24h liveness sweep, so every trial
 *  left a day-long corpse in the shared roster). Symmetric counterpart to the join: the caller
 *  proves possession of the participant's holder private key by signing the SAME member-noise
 *  attestation the join verified, over this deployment's channel for that holder. No admin gate,
 *  no operator involvement -- and no griefing surface: only whoever holds the private key that
 *  created the entry can remove it, and only entries that were self-service-joined (hence carry a
 *  stored holderPub) are removable this way; an operator-hand-added participant has no stored
 *  holderPub and stays admin-only, which is correct. */
async function handleParticipantLeave(req, res, participants, you) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonError(res, 400, `invalid body: ${e.message}`);
  }
  const { holderPub, noisePub, attestation } = body || {};
  if (typeof holderPub !== "string" || !HEX32_RE.test(holderPub)) return jsonError(res, 400, "holderPub must be 64 hex chars");
  if (typeof noisePub !== "string" || !HEX32_RE.test(noisePub)) return jsonError(res, 400, "noisePub must be 64 hex chars");
  if (typeof attestation !== "string" || !HEX64_RE.test(attestation)) return jsonError(res, 400, "attestation must be 128 hex chars");

  // Only a self-service-admitted entry (in the approved file) is leavable this way, and only if it
  // carries a stored holderPub. Generic 404 whether it's absent, admin-added-without-holderPub, or
  // just gone -- never disclose which, and never reach into the operator's base file.
  const entry = listApprovedParticipants().find((p) => p && p.you === you);
  if (!entry || typeof entry.holderPub !== "string") {
    return jsonError(res, 404, `"${you}" is not a self-service-admitted participant that can self-remove`);
  }
  // The submitted key must be THIS participant's, not merely a valid key -- otherwise anyone who
  // can sign for their own identity could remove someone else's id.
  if (entry.holderPub !== holderPub) {
    return jsonError(res, 403, "holderPub does not match this participant -- only its own holder key may remove it");
  }

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

  removeApprovedParticipant(participants, you);
  process.stderr.write(`participants: "${you}" self-removed (holder-key-authenticated leave)\n`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, you, left: true }));
}

function main() {
  const participants = loadParticipants();
  const joinRequests = loadJoinRequests();
  // "you" -> {channel, grantB, createdAt} -- Phase 2's one-shot delivery slot for a participant's
  // own grant, read once by their own join.js status poll (handleJoinRequestStatus) then deleted.
  // Persisted to SORT_PENDING_GRANTS_FILE and reloaded here at boot (CADS-DEMO-sort#26): a bridge
  // restart between approval and the participant's poll used to wipe this in-memory-only Map,
  // stranding the grant (participant registered with the control plane but with no way to fetch
  // grantB, needing the operator to notice and re-run approve). It now survives a redeploy; the
  // delete-on-successful-delivery semantics are unchanged, and every mutation writes through.
  const pendingGrantDelivery = loadPendingGrants();
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
      // everAnswered (CADS-DEMO-sort#58): lets a reader tell "has completed at least one real call
      // this bridge lifetime" apart from "was approved and never answered anything" -- the two look
      // identical without this, since approval also stamps lastSeenAt. Not present at all for
      // base-file (operator-curated) participants like reference-sorter until their first real call
      // either -- same rule, no special-casing.
      // lastSeenAt (CADS-DEMO-sort#58 follow-up): everAnswered never decays, so pair it with the
      // timestamp of the LAST successful call -- "everAnswered:true" plus a stale lastSeenAt is a
      // participant that used to work and now doesn't, not a currently-healthy one. See
      // getParticipantLastSeen's comment for the live-reproduced case this closes.
      res.end(
        JSON.stringify(
          [...participants.values()].map((p) => ({
            you: p.you,
            label: p.label,
            everAnswered: participantEverAnswered.has(p.you),
            lastSeenAt: getParticipantLastSeen(p.you),
          }))
        )
      );
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
    if (req.method === "GET" && url.pathname === "/api/whoami") {
      handleWhoami(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/oidc-session") {
      handleOidcSessionSubmit(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/oidc-session") {
      if (!requireAdmin(req, res)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          liveOidcSession && liveOidcSession.sessionDeadline > Date.now()
            ? { active: true, activeUntil: new Date(liveOidcSession.sessionDeadline).toISOString() }
            : { active: false }
        )
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/join-requests") {
      handleJoinRequestSubmit(req, res, joinRequests, participants, pendingGrantDelivery);
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
    // NB: ordered AFTER the /approved/:you/revoke match so ":you" can't swallow "approved" -- a
    // participant literally named "approved" is impossible anyway (approved is not a valid id), but
    // matching the more specific admin route first keeps that guarantee structural, not incidental.
    const leaveMatch = url.pathname.match(/^\/api\/participants\/([^/]+)\/leave$/);
    if (req.method === "POST" && leaveMatch) {
      handleParticipantLeave(req, res, participants, decodeURIComponent(leaveMatch[1]));
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
  // Self-service liveness (CADS-DEMO-sort#28): seed the in-memory last-seen map from the approved
  // file's persisted timestamps, then reconcile once at boot and on a fixed interval. bootTime is
  // captured once so legacy entries (no lastSeenAt) get a single full-TTL grace window from this
  // start, not repeatedly. unref() so the timer never by itself keeps the process alive.
  const bootTime = Date.now();
  for (const entry of listApprovedParticipants()) {
    if (entry && typeof entry.you === "string" && typeof entry.lastSeenAt === "number") {
      recordParticipantSeen(entry.you, entry.lastSeenAt);
    }
  }
  try {
    reconcileApprovedParticipants(participants, { bootTime });
  } catch (e) {
    process.stderr.write(`participant-sweep: initial reconcile failed: ${e.message}\n`);
  }
  const sweepTimer = setInterval(() => {
    try {
      const { pruned } = reconcileApprovedParticipants(participants, { bootTime });
      if (pruned.length) {
        process.stderr.write(
          `participant-sweep: pruned ${pruned.length} stale self-service participant(s) ` +
            `(no connection in >${PARTICIPANT_TTL_MS}ms): ${pruned.join(", ")}\n`
        );
      }
    } catch (e) {
      process.stderr.write(`participant-sweep: failed: ${e.message}\n`);
    }
  }, PARTICIPANT_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  const [host, port] = LISTEN.split(":");
  server.listen(Number(port), host, () => {
    process.stdout.write(`sort-arena-bridge listening on ${LISTEN}, ${participants.size} participant(s) configured\n`);
  });
}

if (require.main === module) main();

module.exports = {
  // Exported for the collision-message test: the raw control-plane 403 misled a tester
  // into believing their account needed authorising, so the wording is now a contract.
  channelCollisionDetail,
  loadParticipants,
  parseParticipantsJson,
  addApprovedParticipant,
  listApprovedParticipants,
  removeApprovedParticipant,
  applyBaseFallbackToMap,
  reconcileApprovedParticipants,
  recordParticipantSeen,
  resetParticipantSeenForTests,
  getParticipantLastSeen,
  seenRecordingCall,
  hasParticipantEverAnswered,
  resetParticipantEverAnsweredForTests,
  PARTICIPANT_TTL_MS,
  callHandlerProcess,
  PersistentRoleClient,
  randomArray,
  handleRace,
  handlePartition,
  handleRun,
  handleChannelInfo,
  handleJoinRequestSubmit,
  handleWhoami,
  handleJoinRequestsList,
  handleJoinRequestApprove,
  handleJoinRequestDecline,
  handleJoinRequestStatus,
  handleAddApprovedParticipant,
  handleListApprovedParticipants,
  handleRevokeApprovedParticipant,
  handleParticipantLeave,
  loadJoinRequests,
  persistJoinRequests,
  loadPendingGrants,
  persistPendingGrants,
  gateVerifiedEmail,
  ADMIN_EMAILS,
  readSecret,
  automationConfigured,
  mintGrants,
  cpFetch,
  automateApproval,
  freshenedCmd,
  currentOidcToken,
  ensureServiceOidcToken,
  automationConfigured,
  handleOidcSessionSubmit,
  refreshOidcToken,
  // Test-only: liveOidcSession/oidcRefreshTimer are deliberately module-level (a real bridge
  // process only ever has one), which means tests sharing this process need a way to reset them
  // between cases rather than leaking a session (or a dangling setTimeout) into the next test.
  resetOidcSessionForTests() {
    if (oidcRefreshTimer) clearTimeout(oidcRefreshTimer);
    oidcRefreshTimer = null;
    liveOidcSession = null;
  },
};
