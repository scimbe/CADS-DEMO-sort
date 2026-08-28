"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "testdata", "attestation-vectors.json"), "utf8")
);

// Redirect the pending-grants default path into a throwaway temp dir for the whole test process,
// so any test that exercises a persist path without its own withEnv override (the sync status
// tests below, which trigger a delete-on-finish write-through) never litters ./pending-grants.json
// into the repo. withEnv-based tests still set their own path and are unaffected by this default.
process.env.SORT_PENDING_GRANTS_FILE =
  process.env.SORT_PENDING_GRANTS_FILE ||
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sort-pending-grants-default-")), "pending-grants.json");

/** A minimal req stand-in for readBody()/handler functions: a real EventEmitter (so req.on
 *  works exactly as it does on a real http.IncomingMessage) with `.headers` and `.socket`, that
 *  emits the given body as one 'data' chunk then 'end' on the next tick. */
function fakeReq(body, headers) {
  const req = new EventEmitter();
  req.headers = headers || {};
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

/** Captures writeHead/end calls instead of writing to a real socket. */
/** A real EventEmitter (not a plain object) so `res.on("finish", ...)` works exactly as it does
 *  on a real http.ServerResponse. `end()` emits `finish` by default, matching a response that
 *  actually completed writing to the client; pass `emitFinish: false` to model a connection reset
 *  mid-response (CADS-DEMO-sort#9: a real, reproduced `RemoteDisconnected` against this same
 *  bridge) -- code that deletes state only inside a `finish` listener must NOT lose it in that case. */
function fakeRes({ emitFinish = true } = {}) {
  const res = new EventEmitter();
  res.statusCode = undefined;
  res.headers = undefined;
  res.body = undefined;
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
    if (emitFinish) res.emit("finish");
  };
  return res;
}

// Must restore env only AFTER fn's returned promise actually settles, not just after fn()
// synchronously returns one -- an async fn is still suspended at its first `await` when this
// function call returns, so restoring eagerly here would reset the env mid-flight, before the
// code under test ever reads it. Caught live: two tests below read SORT_CHANNEL_OPERATOR_PUBKEY/
// SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY as already-unset because of exactly this bug.
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sort-waiting-room-test-")), name);
}

test("parseParticipantsJson: accepts a well-formed array", () => {
  const { parseParticipantsJson } = require("./server.js");
  const map = parseParticipantsJson('[{"you":"a","cmd":"echo a"},{"you":"b","label":"B","cmd":"echo b"}]', "test");
  assert.equal(map.size, 2);
  assert.deepEqual(map.get("a"), { you: "a", label: "a", cmd: "echo a" });
  assert.deepEqual(map.get("b"), { you: "b", label: "B", cmd: "echo b" });
});

test("parseParticipantsJson: rejects invalid JSON, non-array, and missing you/cmd", () => {
  const { parseParticipantsJson } = require("./server.js");
  assert.throws(() => parseParticipantsJson("not json", "test"));
  assert.throws(() => parseParticipantsJson("{}", "test"));
  assert.throws(() => parseParticipantsJson('[{"you":"a"}]', "test"));
  assert.throws(() => parseParticipantsJson('[{"cmd":"echo"}]', "test"));
});

test("loadParticipants: merges the approved file in, approved wins on id collision with the base file", async () => {
  const baseFile = tmpFile("base.json");
  const approvedFile = tmpFile("approved.json");
  fs.writeFileSync(baseFile, JSON.stringify([{ you: "a", label: "Base A", cmd: "echo base-a" }]));
  fs.writeFileSync(
    approvedFile,
    JSON.stringify([
      { you: "a", label: "Approved A", cmd: "echo approved-a" },
      { you: "b", label: "Approved B", cmd: "echo approved-b" },
    ])
  );
  await withEnv(
    { SORT_PARTICIPANTS_JSON: "", SORT_PARTICIPANTS_FILE: baseFile, SORT_PARTICIPANTS_APPROVED_FILE: approvedFile },
    () => {
      delete require.cache[require.resolve("./server.js")];
      const { loadParticipants } = require("./server.js");
      const map = loadParticipants();
      assert.equal(map.size, 2);
      assert.equal(map.get("a").cmd, "echo approved-a", "approved file must win on id collision");
      assert.equal(map.get("b").cmd, "echo approved-b");
    }
  );
});

test("loadParticipants: works with no approved file configured at all (today's behavior, unchanged)", async () => {
  const baseFile = tmpFile("base.json");
  fs.writeFileSync(baseFile, JSON.stringify([{ you: "a", cmd: "echo a" }]));
  await withEnv({ SORT_PARTICIPANTS_JSON: "", SORT_PARTICIPANTS_FILE: baseFile, SORT_PARTICIPANTS_APPROVED_FILE: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { loadParticipants } = require("./server.js");
    const map = loadParticipants();
    assert.equal(map.size, 1);
  });
});

test("addApprovedParticipant: appends to the approved file and makes the entry live on the passed-in Map immediately", async () => {
  const approvedFile = tmpFile("approved.json");
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: approvedFile }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { addApprovedParticipant } = require("./server.js");
    const participants = new Map();
    addApprovedParticipant(participants, { you: "new-one", label: "New One", cmd: "echo new" });
    assert.equal(participants.get("new-one").cmd, "echo new");
    const onDisk = JSON.parse(fs.readFileSync(approvedFile, "utf8"));
    assert.equal(onDisk.length, 1);
    // The core fields persist verbatim; lastSeenAt is additionally stamped at approval time (#28).
    assert.equal(onDisk[0].you, "new-one");
    assert.equal(onDisk[0].label, "New One");
    assert.equal(onDisk[0].cmd, "echo new");
    assert.equal(typeof onDisk[0].lastSeenAt, "number");

    // Replacing an existing id updates in place rather than appending a duplicate row.
    addApprovedParticipant(participants, { you: "new-one", label: "New One", cmd: "echo updated" });
    const onDisk2 = JSON.parse(fs.readFileSync(approvedFile, "utf8"));
    assert.equal(onDisk2.length, 1);
    assert.equal(onDisk2[0].cmd, "echo updated");
  });
});

test("handleJoinRequestSubmit: rejects a malformed body without ever touching the queue", async () => {
  delete require.cache[require.resolve("./server.js")];
  const { handleJoinRequestSubmit } = require("./server.js");
  const joinRequests = new Map();
  const participants = new Map();
  const req = fakeReq({ you: "Not Valid!", holderPub: "x", noisePub: "x", attestation: "x" });
  const res = fakeRes();
  await handleJoinRequestSubmit(req, res, joinRequests, participants);
  assert.equal(res.statusCode, 400);
  assert.equal(joinRequests.size, 0);
});

test("handleJoinRequestSubmit: rejects a well-formed but cryptographically invalid attestation", async () => {
  await withEnv(
    { SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub, SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");
      const joinRequests = new Map();
      const participants = new Map();
      const req = fakeReq({
        you: "attacker",
        holderPub: vectors.holder_a_pub,
        noisePub: vectors.noise_a_pub,
        // Well-formed hex, but signed by the WRONG holder (holder_b signing a message that
        // claims to be holder_a's) -- genuinely fails verification against holder_a_pub, unlike
        // negative_wrong_channel's signature, which is still the real, valid signature (only the
        // *context* it's checked against is wrong) and would wrongly pass this test.
        attestation: vectors.negative_wrong_holder_signature.signature,
      });
      const res = fakeRes();
      await handleJoinRequestSubmit(req, res, joinRequests, participants);
      assert.equal(res.statusCode, 400);
      assert.equal(joinRequests.size, 0);
    }
  );
});

test("handleJoinRequestSubmit: queues a genuinely valid, verified submission", async () => {
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");
      const joinRequests = new Map();
      const participants = new Map();
      const req = fakeReq({
        you: "real-participant",
        label: "Real Participant",
        holderPub: vectors.holder_a_pub,
        noisePub: vectors.noise_a_pub,
        attestation: vectors.positive.signature,
      });
      const res = fakeRes();
      await handleJoinRequestSubmit(req, res, joinRequests, participants);
      assert.equal(res.statusCode, 200);
      assert.equal(joinRequests.size, 1);
      assert.equal(joinRequests.get("real-participant").holderPub, vectors.holder_a_pub);
    }
  );
});

test("handleJoinRequestSubmit: falls back to the manual queue when unauthenticated OR automation is unconfigured (auto-approval contract)", async () => {
  // 2026-08-13 auto-approval: the immediate-approve branch requires BOTH a gate-verified
  // identity AND automationConfigured(). This freezes the fallback half of the contract --
  // without either precondition, a valid submit still queues exactly as before (and the
  // response now says `approved: false` so join.js can render accurate copy). The positive
  // auto-approve half exercises automateApproval's real CP round-trips and is covered by the
  // deployment smoke flow, not unit tests.
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests-auto.json"),
      SORT_PENDING_GRANTS_FILE: tmpFile("pending-grants-auto.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");

      // Unauthenticated (no X-Gate-Email): queued.
      const joinRequests = new Map();
      const res = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq({ you: "anon-flow", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature }),
        res,
        joinRequests,
        new Map(),
        new Map()
      );
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).approved, false, "no gate identity -> manual queue, stated explicitly");
      assert.equal(joinRequests.size, 1);

      // Gate-authenticated but automation NOT configured (no operator/bridge keys in this env):
      // also queued -- a gated-but-unautomated deployment keeps the manual review flow.
      const joinRequests2 = new Map();
      const res2 = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq(
          { you: "gated-flow", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature },
          { "x-gate-email": "workshop-user@example.org" }
        ),
        res2,
        joinRequests2,
        new Map(),
        new Map()
      );
      assert.equal(res2.statusCode, 200);
      assert.equal(JSON.parse(res2.body).approved, false, "gate identity without automation -> still the manual queue");
      assert.equal(joinRequests2.size, 1);
    }
  );
});

test("handleJoinRequestSubmit: rejects a duplicate id already live or already pending", async () => {
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");
      const joinRequests = new Map();
      const participants = new Map([["taken", { you: "taken", label: "Taken", cmd: "echo" }]]);
      const res1 = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq({ you: "taken", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature }),
        res1,
        joinRequests,
        participants
      );
      assert.equal(res1.statusCode, 409);
    }
  );
});

// channelIdForLink is a function of holderPub alone, not of `you` -- a real (reproduced) bug: two
// different participant ids submitted with the SAME holderPub silently share one Agent-Fabric
// channel, so whichever ct-agent process actually holds it answers rounds for BOTH labels. The
// attestation itself signs channel+holder+noise, never `you` (see memberNoiseAttestBytes in
// join.js / the same preimage server-side), so vectors.positive.signature verifies unchanged
// under a second `you` here -- exactly what a browser reusing its stored identity would submit.
test("handleJoinRequestSubmit: rejects the same holderPub already live under a different id", async () => {
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");
      const joinRequests = new Map();
      const participants = new Map([
        ["first-strategy", { you: "first-strategy", label: "First", cmd: "echo", holderPub: vectors.holder_a_pub }],
      ]);
      const res = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq({
          you: "second-strategy",
          holderPub: vectors.holder_a_pub,
          noisePub: vectors.noise_a_pub,
          attestation: vectors.positive.signature,
        }),
        res,
        joinRequests,
        participants
      );
      assert.equal(res.statusCode, 409);
      assert.match(JSON.parse(res.body).error, /first-strategy/);
      assert.equal(joinRequests.size, 0, "never queued -- the collision is rejected before that");
    }
  );
});

test("handleJoinRequestSubmit: rejects the same holderPub already pending under a different id", async () => {
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");
      const joinRequests = new Map([
        ["already-pending", { you: "already-pending", label: "Already Pending", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature, createdAt: Date.now() }],
      ]);
      const participants = new Map();
      const res = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq({
          you: "another-id",
          holderPub: vectors.holder_a_pub,
          noisePub: vectors.noise_a_pub,
          attestation: vectors.positive.signature,
        }),
        res,
        joinRequests,
        participants
      );
      assert.equal(res.statusCode, 409);
      assert.match(JSON.parse(res.body).error, /already-pending/);
      assert.equal(joinRequests.size, 1, "still just the original pending request -- the new one was rejected");
    }
  );
});

// --- CADS-DEMO-sort#55: a resubmit under the SAME id replaces its own stale pending request -----

test(
  "handleJoinRequestSubmit: a resubmit with the SAME id and SAME holderPub replaces its own " +
    "stale pending request instead of being rejected (CADS-DEMO-sort#55)",
  async () => {
    await withEnv(
      {
        SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
        SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
        SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
      },
      async () => {
        delete require.cache[require.resolve("./server.js")];
        const { handleJoinRequestSubmit } = require("./server.js");
        const staleCreatedAt = Date.now() - 26 * 3600 * 1000; // e.g. the #52 live specimen: 26h+ stuck
        const joinRequests = new Map([
          [
            "stuck-participant",
            {
              you: "stuck-participant",
              label: "Stuck Participant",
              holderPub: vectors.holder_a_pub,
              noisePub: vectors.noise_a_pub,
              attestation: vectors.positive.signature,
              createdAt: staleCreatedAt,
              gateEmail: null,
            },
          ],
        ]);
        const participants = new Map();
        const res = fakeRes();
        await handleJoinRequestSubmit(
          fakeReq({
            you: "stuck-participant",
            holderPub: vectors.holder_a_pub, // SAME holder key -- the same browser identity
            noisePub: vectors.noise_a_pub,
            attestation: vectors.positive.signature,
          }),
          res,
          joinRequests,
          participants
        );
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        assert.equal(JSON.parse(res.body).approved, false, "automation not configured -- still the manual queue");
        assert.equal(joinRequests.size, 1, "replaced in place, not appended as a second entry");
        assert.ok(
          joinRequests.get("stuck-participant").createdAt > staleCreatedAt,
          "the resubmit refreshes createdAt -- this is a genuinely new pending window, not the stale one"
        );
      }
    );
  }
);

test(
  "handleJoinRequestSubmit: a resubmit with a DIFFERENT holderPub under the same id is still " +
    "rejected -- only the SAME browser identity may replace its own pending request (CADS-DEMO-sort#55 safety boundary)",
  async () => {
    await withEnv(
      {
        SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
        SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
        SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
      },
      async () => {
        delete require.cache[require.resolve("./server.js")];
        const { handleJoinRequestSubmit } = require("./server.js");
        const joinRequests = new Map([
          [
            "contested-id",
            {
              you: "contested-id",
              label: "Original Holder",
              holderPub: vectors.holder_a_pub,
              noisePub: vectors.noise_a_pub,
              attestation: vectors.positive.signature,
              createdAt: Date.now(),
              gateEmail: null,
            },
          ],
        ]);
        const participants = new Map();
        const res = fakeRes();
        // A DIFFERENT holder key claiming the same id -- attestation content doesn't matter here,
        // this must be rejected before attestation is ever checked (someone else's browser cannot
        // impersonate or bump the original holder's pending request).
        await handleJoinRequestSubmit(
          fakeReq({
            you: "contested-id",
            holderPub: vectors.holder_b_pub,
            noisePub: vectors.noise_a_pub,
            attestation: vectors.positive.signature,
          }),
          res,
          joinRequests,
          participants
        );
        assert.equal(res.statusCode, 409);
        assert.match(JSON.parse(res.body).error, /contested-id/);
        assert.equal(joinRequests.size, 1);
        assert.equal(
          joinRequests.get("contested-id").holderPub,
          vectors.holder_a_pub,
          "the original holder's entry must be untouched"
        );
      }
    );
  }
);

test("handleJoinRequestSubmit: stores the gate-verified email on a manually queued entry, or null for an ungated submission (CADS-DEMO-sort#54)", async () => {
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestSubmit } = require("./server.js");

      const joinRequests1 = new Map();
      const res1 = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq(
          { you: "gated-but-unautomated", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature },
          { "x-gate-email": "Workshop-User@Example.ORG" }
        ),
        res1,
        joinRequests1,
        new Map(),
        new Map()
      );
      assert.equal(res1.statusCode, 200);
      assert.equal(
        joinRequests1.get("gated-but-unautomated").gateEmail,
        "workshop-user@example.org",
        "the gate-verified email is recorded (lowercased, per gateVerifiedEmail), for a later re-arm scan to reuse"
      );

      const joinRequests2 = new Map();
      const res2 = fakeRes();
      await handleJoinRequestSubmit(
        fakeReq({ you: "anon-flow-2", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature }),
        res2,
        joinRequests2,
        new Map(),
        new Map()
      );
      assert.equal(res2.statusCode, 200);
      assert.equal(joinRequests2.get("anon-flow-2").gateEmail, null, "no gate header -> null, not omitted or undefined-on-disk");
    }
  );
});

test("admin routes: fail closed (503) when SORT_ADMIN_EMAILS is unset", async () => {
  await withEnv({ SORT_ADMIN_EMAILS: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestsList } = require("./server.js");
    const res = fakeRes();
    handleJoinRequestsList({ headers: {} }, res, new Map());
    assert.equal(res.statusCode, 503);
  });
});

test("admin routes: reject a non-admin caller (403) even with a plausible-looking header", async () => {
  await withEnv({ SORT_ADMIN_EMAILS: "operator@example.com" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestsList } = require("./server.js");
    const res = fakeRes();
    handleJoinRequestsList({ headers: { "x-gate-email": "not-the-operator@example.com" } }, res, new Map());
    assert.equal(res.statusCode, 403);
  });
});

test("admin routes: accept the configured admin, case-insensitively", async () => {
  await withEnv({ SORT_ADMIN_EMAILS: "Operator@Example.com" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestsList } = require("./server.js");
    const res = fakeRes();
    const joinRequests = new Map([["x", { you: "x", label: "X", createdAt: 1 }]]);
    handleJoinRequestsList({ headers: { "x-gate-email": "operator@example.com" } }, res, joinRequests);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).requests.length, 1);
  });
});

test("handleJoinRequestApprove: 404s on an unknown id, never fabricates a resolved request", async () => {
  await withEnv(
    { SORT_ADMIN_EMAILS: "operator@example.com", SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub, SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestApprove } = require("./server.js");
      const res = fakeRes();
      await handleJoinRequestApprove({ headers: { "x-gate-email": "operator@example.com" } }, res, new Map(), new Map(), new Map(), "nobody");
      assert.equal(res.statusCode, 404);
    }
  );
});

test("handleJoinRequestApprove: fails closed (503) when automation isn't configured, request stays pending", async () => {
  await withEnv(
    { SORT_ADMIN_EMAILS: "operator@example.com" },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestApprove } = require("./server.js");
      const joinRequests = new Map([
        ["real-participant", { you: "real-participant", label: "RP", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature, createdAt: 1 }],
      ]);
      const res = fakeRes();
      await handleJoinRequestApprove({ headers: { "x-gate-email": "operator@example.com" } }, res, joinRequests, new Map(), new Map(), "real-participant");
      assert.equal(res.statusCode, 503);
      assert.equal(joinRequests.size, 1, "an approval that can't finish must not remove the request from the queue");
    }
  );
});

// Full automation, end to end, against the REAL vendored grant binary (built once here, same as
// CI would need to) and a real local HTTP server standing in for the control plane -- not fully
// mocked, per this project's own "verify for real" ethos. The grant-minting crypto itself is
// already covered by grant/'s own Rust test suite (12 tests, including a real ct_common::verify
// round trip) and this file's signMemberNoiseAttestation test; this test's job is to prove
// server.js actually WIRES it all together correctly (right args, right env, parses stdout,
// makes the right CP calls, ends up with a live participant and a delivered grant) -- not to
// re-verify the crypto underneath it.
const GRANT_BIN_PATH = path.join(__dirname, "..", "grant", "target", "release", "sort-channel-grant");
const grantBinAvailable = fs.existsSync(GRANT_BIN_PATH);

test(
  "handleJoinRequestApprove: full automation succeeds end to end against the real grant binary + a real control-plane stub",
  { skip: !grantBinAvailable && "grant binary not built (run: cd grant && cargo build --release)" },
  async () => {
    // Fresh, real Ed25519 identities -- not the shared testdata vectors, so this test doesn't
    // silently depend on their specific values meaning anything here.
    const genIdentity = () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      return {
        pub: publicKey.export({ type: "spki", format: "der" }).subarray(-32),
        priv: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32),
      };
    };
    const operator = genIdentity();
    const bridge = { holder: genIdentity(), noise: genIdentity() };
    const participant = { holder: genIdentity(), noise: genIdentity() };

    const { channelIdForLink, memberNoiseAttestBytes } = require("./attestation.js");
    const channel = channelIdForLink(operator.pub, bridge.holder.pub, participant.holder.pub);
    const participantAttestationMsg = memberNoiseAttestBytes(channel, participant.holder.pub, participant.noise.pub);
    const participantSigKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), participant.holder.priv]),
      format: "der",
      type: "pkcs8",
    });
    const participantAttestation = crypto.sign(null, participantAttestationMsg, participantSigKey);

    // Stub control plane: real HTTP server, accepts the two real endpoints automateApproval
    // calls, records what it received so the test can assert on it.
    const received = [];
    const stub = require("node:http").createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const cpUrl = `http://127.0.0.1:${stub.address().port}`;

    const operatorKeyFile = tmpFile("operator.key");
    fs.writeFileSync(operatorKeyFile, operator.priv.toString("hex"));

    try {
      await withEnv(
        {
          SORT_ADMIN_EMAILS: "operator@example.com",
          SORT_GRANT_BIN: GRANT_BIN_PATH,
          SORT_CHANNEL_OPERATOR_KEY_FILE: operatorKeyFile,
          SORT_CHANNEL_BRIDGE_HOLDER_KEY: bridge.holder.priv.toString("hex"),
          SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: bridge.holder.pub.toString("hex"),
          SORT_CHANNEL_BRIDGE_NOISE_KEY: bridge.noise.priv.toString("hex"),
          SORT_CHANNEL_BRIDGE_NOISE_PUBKEY: bridge.noise.pub.toString("hex"),
          SORT_CP_URL: cpUrl,
          SORT_OIDC_TOKEN: "test-token",
          SORT_CHANNEL_BROKER: "test-edge:4435",
          SORT_CHANNEL_RELAY: "test-edge:4436",
          SORT_PARTICIPANTS_APPROVED_FILE: tmpFile("participants-approved.json"),
          SORT_PENDING_GRANTS_FILE: tmpFile("pending-grants.json"),
        },
        async () => {
          delete require.cache[require.resolve("./server.js")];
          const { handleJoinRequestApprove, freshenedCmd } = require("./server.js");
          const joinRequests = new Map([
            [
              "real-participant",
              {
                you: "real-participant",
                label: "Real Participant",
                holderPub: participant.holder.pub.toString("hex"),
                noisePub: participant.noise.pub.toString("hex"),
                attestation: participantAttestation.toString("hex"),
                createdAt: Date.now(),
              },
            ],
          ]);
          const liveParticipants = new Map();
          const pendingGrantDelivery = new Map();
          const res = fakeRes();

          await handleJoinRequestApprove(
            { headers: { "x-gate-email": "operator@example.com" } },
            res,
            joinRequests,
            liveParticipants,
            pendingGrantDelivery,
            "real-participant"
          );

          assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
          const body = JSON.parse(res.body);
          assert.equal(body.channel, channel.toString("hex"));
          assert.equal(joinRequests.size, 0, "approved request must leave the pending queue");

          // Actually live, with a real cmd string pointing at the freshly minted grant.
          assert.ok(liveParticipants.has("real-participant"));
          const cmd = liveParticipants.get("real-participant").cmd;
          assert.match(cmd, /CT_CHANNEL_ROLE=initiate/);
          assert.match(cmd, /CT_CHANNEL_CALL_SERVICE=text_generation/);
          // sort#40: the bridge's own long-term key material must NEVER be in the persisted/served
          // cmd -- addApprovedParticipant writes this string to disk and GET /api/participants/
          // approved serves it back verbatim to any admin session.
          assert.doesNotMatch(cmd, /CT_CHANNEL_HOLDER_KEY=/);
          assert.doesNotMatch(cmd, /CT_CHANNEL_NOISE_KEY=/);
          // ...but a real dial still needs it -- freshenedCmd (the same call-time injection point
          // that already re-applies a live front-door cert) must supply it fresh from readSecret(),
          // never from the stored string.
          const dialCmd = await freshenedCmd(cmd);
          assert.match(dialCmd, new RegExp(`CT_CHANNEL_HOLDER_KEY=${bridge.holder.priv.toString("hex")}`));
          assert.match(dialCmd, new RegExp(`CT_CHANNEL_NOISE_KEY=${bridge.noise.priv.toString("hex")}`));
          // Real production regression (CADS-DEMO-sort#9, windows-selection): without this flag
          // the bridge's own ct-agent invocation faults every round with "CT_CHANNEL_LISTEN
          // required" -- the bridge only ever dials OUT to a participant, so it has no dialable
          // address of its own and needs none, same as join.js's accept-side command already
          // correctly sets for the participant's half of this same pairing.
          assert.match(cmd, /CT_CHANNEL_RELAY_ONLY=1/);

          // The participant's own grant is waiting for their one-shot status poll.
          assert.ok(pendingGrantDelivery.has("real-participant"));
          const delivery = pendingGrantDelivery.get("real-participant");
          assert.equal(delivery.channel, channel.toString("hex"));
          assert.ok(typeof delivery.grantB === "string" && delivery.grantB.length > 0);

          // The control plane actually got called for real: one channel registration, one
          // member call per side, and the portal grant deposit (CADS-Tunnel#514 / sort#20) --
          // not fabricated or skipped.
          assert.equal(received.length, 4);
          assert.equal(received[0].url, "/me/channels");
          assert.equal(received[0].body.channel, channel.toString("hex"));
          const memberCalls = received.slice(1, 3);
          const holders = memberCalls.map((c) => c.body.holder).sort();
          assert.deepEqual(holders, [bridge.holder.pub.toString("hex"), participant.holder.pub.toString("hex")].sort());
          // The deposit call: participant's holder in the path, the SAME grantB the one-shot
          // slot holds in the body -- the durable copy and the fast-path copy must be identical.
          const deposit = received[3];
          assert.equal(deposit.url, `/me/channels/${channel.toString("hex")}/grants/${participant.holder.pub.toString("hex")}`);
          assert.equal(deposit.body.grant, delivery.grantB);
        }
      );
    } finally {
      stub.close();
    }
  }
);

// --- CADS-DEMO-sort#54: the re-arm scan (autoApproveEligiblePendingRequests) ---------------------

/** Builds a real automation environment (the real vendored grant binary + a real local HTTP
 *  server standing in for the control plane), same ethos as the "full automation" test above --
 *  these tests prove the re-arm scan's actual wiring, not a mocked automateApproval.
 *  genParticipant(you) returns a fresh holder/noise identity plus a validly-signed attestation for
 *  THIS harness's channel (needed by any test going through handleJoinRequestSubmit, which
 *  verifies it; autoApproveEligiblePendingRequests itself never re-verifies a queued entry's
 *  attestation -- same as handleJoinRequestApprove doesn't -- so it isn't required there, but a
 *  real one is used throughout anyway for consistency). Caller must `harness.stub.close()` in a
 *  `finally`. */
async function makeAutomationHarness() {
  const genIdentity = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
      pub: publicKey.export({ type: "spki", format: "der" }).subarray(-32),
      priv: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32),
    };
  };
  const operator = genIdentity();
  const bridge = { holder: genIdentity(), noise: genIdentity() };
  const received = [];
  const stub = require("node:http").createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const cpUrl = `http://127.0.0.1:${stub.address().port}`;

  const { channelIdForLink, memberNoiseAttestBytes } = require("./attestation.js");
  function genParticipant(you) {
    const holder = genIdentity();
    const noise = genIdentity();
    const channel = channelIdForLink(operator.pub, bridge.holder.pub, holder.pub);
    const msg = memberNoiseAttestBytes(channel, holder.pub, noise.pub);
    const sigKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), holder.priv]),
      format: "der",
      type: "pkcs8",
    });
    const attestation = crypto.sign(null, msg, sigKey);
    return {
      you,
      label: you,
      holderPub: holder.pub.toString("hex"),
      noisePub: noise.pub.toString("hex"),
      attestation: attestation.toString("hex"),
      channelHex: channel.toString("hex"),
    };
  }

  const operatorKeyFile = tmpFile("operator.key");
  fs.writeFileSync(operatorKeyFile, operator.priv.toString("hex"));

  return {
    stub,
    received,
    genParticipant,
    withVars: {
      SORT_GRANT_BIN: GRANT_BIN_PATH,
      SORT_CHANNEL_OPERATOR_PUBKEY: operator.pub.toString("hex"),
      SORT_CHANNEL_OPERATOR_KEY_FILE: operatorKeyFile,
      SORT_CHANNEL_BRIDGE_HOLDER_KEY: bridge.holder.priv.toString("hex"),
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: bridge.holder.pub.toString("hex"),
      SORT_CHANNEL_BRIDGE_NOISE_KEY: bridge.noise.priv.toString("hex"),
      SORT_CHANNEL_BRIDGE_NOISE_PUBKEY: bridge.noise.pub.toString("hex"),
      SORT_CP_URL: cpUrl,
      SORT_OIDC_TOKEN: "test-token",
      SORT_CHANNEL_BROKER: "test-edge:4435",
      SORT_CHANNEL_RELAY: "test-edge:4436",
    },
  };
}

test("autoApproveEligiblePendingRequests: a no-op when automation isn't configured -- nothing in the queue is touched", async () => {
  delete require.cache[require.resolve("./server.js")];
  const { autoApproveEligiblePendingRequests } = require("./server.js");
  const joinRequests = new Map([
    [
      "waiting",
      {
        you: "waiting",
        label: "Waiting",
        holderPub: vectors.holder_a_pub,
        noisePub: vectors.noise_a_pub,
        attestation: vectors.positive.signature,
        createdAt: Date.now(),
        gateEmail: "user@example.org",
      },
    ],
  ]);
  const participants = new Map();
  const pendingGrantDelivery = new Map();
  const { approved } = await autoApproveEligiblePendingRequests(joinRequests, participants, pendingGrantDelivery);
  assert.deepEqual(approved, []);
  assert.equal(joinRequests.size, 1, "still queued -- automationConfigured() is false in this bare test env");
  assert.equal(participants.size, 0);
});

test(
  "autoApproveEligiblePendingRequests: skips a pending entry with no recorded gateEmail even though " +
    "automation is configured (CADS-DEMO-sort#54 safety constraint -- see the maintainer's comment " +
    "on #54: a drain that approved every entry regardless would bypass the gate check and the " +
    "per-account rate limit the live submit path enforces)",
  { skip: !grantBinAvailable && "grant binary not built (run: cd grant && cargo build --release)" },
  async () => {
    const harness = await makeAutomationHarness();
    try {
      await withEnv(
        {
          ...harness.withVars,
          SORT_PARTICIPANTS_APPROVED_FILE: tmpFile("participants-approved.json"),
          SORT_PENDING_GRANTS_FILE: tmpFile("pending-grants.json"),
          SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
        },
        async () => {
          delete require.cache[require.resolve("./server.js")];
          const { autoApproveEligiblePendingRequests, automationConfigured } = require("./server.js");
          assert.equal(automationConfigured(), true, "sanity: this harness's env really does satisfy automationConfigured()");
          const p = harness.genParticipant("no-gate-email-on-record");
          const joinRequests = new Map([
            [p.you, { you: p.you, label: p.label, holderPub: p.holderPub, noisePub: p.noisePub, attestation: p.attestation, createdAt: Date.now() }],
          ]);
          const participants = new Map();
          const pendingGrantDelivery = new Map();
          const { approved } = await autoApproveEligiblePendingRequests(joinRequests, participants, pendingGrantDelivery);
          assert.deepEqual(approved, []);
          assert.equal(joinRequests.size, 1, "left exactly as it was -- no gateEmail means no authorization to act on");
          assert.equal(participants.size, 0);
          assert.equal(harness.received.length, 0, "the control plane was never even contacted for this entry");
        }
      );
    } finally {
      harness.stub.close();
    }
  }
);

test(
  "autoApproveEligiblePendingRequests: approves a pending entry with a recorded gateEmail once " +
    "automation is configured (CADS-DEMO-sort#54)",
  { skip: !grantBinAvailable && "grant binary not built (run: cd grant && cargo build --release)" },
  async () => {
    const harness = await makeAutomationHarness();
    try {
      const joinFile = tmpFile("join-requests.json");
      await withEnv(
        {
          ...harness.withVars,
          SORT_PARTICIPANTS_APPROVED_FILE: tmpFile("participants-approved.json"),
          SORT_PENDING_GRANTS_FILE: tmpFile("pending-grants.json"),
          SORT_JOIN_REQUESTS_FILE: joinFile,
        },
        async () => {
          delete require.cache[require.resolve("./server.js")];
          const { autoApproveEligiblePendingRequests } = require("./server.js");
          const p = harness.genParticipant("recovered-participant");
          // Simulates the #52 live specimen: queued 20 minutes ago (while automation was down),
          // with the gateEmail this submit-time gate check would have recorded.
          const joinRequests = new Map([
            [
              p.you,
              {
                you: p.you,
                label: p.label,
                holderPub: p.holderPub,
                noisePub: p.noisePub,
                attestation: p.attestation,
                createdAt: Date.now() - 20 * 60 * 1000,
                gateEmail: "recovering-user@example.org",
              },
            ],
          ]);
          const participants = new Map();
          const pendingGrantDelivery = new Map();
          const { approved } = await autoApproveEligiblePendingRequests(joinRequests, participants, pendingGrantDelivery);
          assert.deepEqual(approved, [p.you]);
          assert.equal(joinRequests.size, 0, "removed from the queue -- it's live now, not still pending");
          assert.ok(participants.has(p.you), "a live participant, exactly as a real submit's auto-approve branch would produce");
          assert.ok(pendingGrantDelivery.has(p.you), "the participant's own grant is waiting for their next status poll");
          assert.equal(pendingGrantDelivery.get(p.you).channel, p.channelHex);
          // Persisted, not just updated in-memory -- a bridge restart between the scan and the
          // participant's next poll must not strand this, exactly like sort#26 originally did.
          const onDisk = JSON.parse(fs.readFileSync(joinFile, "utf8"));
          assert.equal(onDisk.length, 0);
        }
      );
    } finally {
      harness.stub.close();
    }
  }
);

test(
  "handleJoinRequestSubmit: a same-id/same-holderPub resubmit gets approved on the spot once " +
    "automation has come back (CADS-DEMO-sort#54 + #55 combined recovery path)",
  { skip: !grantBinAvailable && "grant binary not built (run: cd grant && cargo build --release)" },
  async () => {
    const harness = await makeAutomationHarness();
    try {
      await withEnv(
        {
          ...harness.withVars,
          SORT_PARTICIPANTS_APPROVED_FILE: tmpFile("participants-approved.json"),
          SORT_PENDING_GRANTS_FILE: tmpFile("pending-grants.json"),
          SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
        },
        async () => {
          delete require.cache[require.resolve("./server.js")];
          const { handleJoinRequestSubmit } = require("./server.js");
          const p = harness.genParticipant("was-stuck-now-recovers");
          // The #52 live specimen exactly: queued hours ago, while automation was down.
          const joinRequests = new Map([
            [p.you, { you: p.you, label: p.label, holderPub: p.holderPub, noisePub: p.noisePub, attestation: p.attestation, createdAt: Date.now() - 3 * 3600 * 1000 }],
          ]);
          const participants = new Map();
          const pendingGrantDelivery = new Map();
          const res = fakeRes();
          await handleJoinRequestSubmit(
            fakeReq(
              { you: p.you, holderPub: p.holderPub, noisePub: p.noisePub, attestation: p.attestation },
              { "x-gate-email": "recovering-user@example.org" }
            ),
            res,
            joinRequests,
            participants,
            pendingGrantDelivery
          );
          assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
          assert.equal(JSON.parse(res.body).approved, true, "automation is configured now -- the resubmit takes the auto-approve branch");
          assert.equal(joinRequests.size, 0, "the stale queue entry is gone, not left behind alongside the new live participant");
          assert.ok(participants.has(p.you));
          assert.ok(pendingGrantDelivery.has(p.you));
        }
      );
    } finally {
      harness.stub.close();
    }
  }
);

// --- Join-request status polling (join.js's post-approval GET) --------------------------------

test(
  "handleJoinRequestStatus: delivers the pending grant, and a second read within the grace window " +
    "gets the SAME grant rather than consuming it (CADS-DEMO-sort#57: the first reader of this " +
    "public, unauthenticated route need not be the participant -- a monitoring script or stray " +
    "curl consuming the only copy is an accident waiting to happen, not an attack)",
  () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestStatus } = require("./server.js");
    const joinRequests = new Map();
    const pendingGrantDelivery = new Map([["p1", { channel: "chan-hex", grantB: "grant-hex", createdAt: Date.now() }]]);

    const res = fakeRes();
    handleJoinRequestStatus({}, res, joinRequests, pendingGrantDelivery, "p1");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { status: "approved", channel: "chan-hex", grant: "grant-hex" });
    assert.ok(pendingGrantDelivery.has("p1"), "still present -- delivery does not consume on first read");
    assert.ok(pendingGrantDelivery.get("p1").firstDeliveredAt, "first successful read is timestamped");

    // A second reader (the legitimate participant, or an accidental duplicate -- indistinguishable
    // to the server) within the grace window gets the SAME grant, not "unknown".
    const res2 = fakeRes();
    handleJoinRequestStatus({}, res2, joinRequests, pendingGrantDelivery, "p1");
    assert.deepEqual(
      JSON.parse(res2.body),
      { status: "approved", channel: "chan-hex", grant: "grant-hex" },
      "a second read inside the grace window is idempotent, not a consuming race"
    );
  }
);

test(
  "handleJoinRequestStatus: the grant expires (lazily) once the grace window has passed since first delivery",
  () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestStatus } = require("./server.js");
    const joinRequests = new Map();
    const longAgo = Date.now() - 60_000; // well past GRANT_DELIVERY_GRACE_MS (30s)
    const pendingGrantDelivery = new Map([
      ["p1", { channel: "chan-hex", grantB: "grant-hex", createdAt: longAgo, firstDeliveredAt: longAgo }],
    ]);

    const res = fakeRes();
    handleJoinRequestStatus({}, res, joinRequests, pendingGrantDelivery, "p1");
    assert.deepEqual(JSON.parse(res.body), { status: "unknown" }, "expired after the grace window, not delivered again");
    assert.equal(pendingGrantDelivery.has("p1"), false, "expiry actually clears the entry (lazy, on this read)");
  }
);

test(
  "handleJoinRequestStatus: a connection reset mid-response must NOT destroy the only copy of the grant " +
    "(CADS-DEMO-sort#9: real, reproduced RemoteDisconnected against this same bridge)",
  () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleJoinRequestStatus } = require("./server.js");
    const joinRequests = new Map();
    const pendingGrantDelivery = new Map([["p1", { channel: "chan-hex", grantB: "grant-hex", createdAt: Date.now() }]]);

    // emitFinish: false models exactly what CADS-DEMO-sort#9 observed: end() is called (the
    // handler believes it answered), but the response never actually finishes reaching the
    // client -- the connection reset first.
    const res = fakeRes({ emitFinish: false });
    handleJoinRequestStatus({}, res, joinRequests, pendingGrantDelivery, "p1");
    assert.equal(res.statusCode, 200, "the handler still believes it answered");
    assert.ok(
      pendingGrantDelivery.has("p1"),
      "the grant must survive an unfinished response so a retry can still succeed"
    );

    // The retry that follows a real reset: this time the response actually finishes.
    const res2 = fakeRes();
    handleJoinRequestStatus({}, res2, joinRequests, pendingGrantDelivery, "p1");
    assert.deepEqual(JSON.parse(res2.body), { status: "approved", channel: "chan-hex", grant: "grant-hex" });
    assert.ok(
      pendingGrantDelivery.has("p1"),
      "the retry's own successful delivery stays available for the grace window (#57), not consumed"
    );
  }
);

// --- Durable grant-delivery slot (CADS-DEMO-sort#26: a redeploy must not strand a grant) -------

test(
  "pending-grants persistence: an approved grant survives a bridge restart and is still deliverable " +
    "(CADS-DEMO-sort#26: redeploy between approve and the participant's poll used to wipe it)",
  async () => {
    const file = tmpFile("pending-grants.json");
    await withEnv({ SORT_PENDING_GRANTS_FILE: file }, () => {
      delete require.cache[require.resolve("./server.js")];
      const { loadPendingGrants, persistPendingGrants, handleJoinRequestStatus } = require("./server.js");

      // Approve wrote the slot and persisted it (the ".set() then persistPendingGrants()" pair).
      const atApproveTime = new Map([["p1", { channel: "chan-hex", grantB: "grant-hex", createdAt: 111 }]]);
      persistPendingGrants(atApproveTime);
      assert.ok(fs.existsSync(file), "approve persisted the slot to the durable file");

      // The bridge redeploys -- a brand-new empty in-memory Map is what boot starts with; the fix
      // is that loadPendingGrants() rehydrates it from the file rather than losing the grant.
      const afterRestart = loadPendingGrants();
      assert.deepEqual(
        afterRestart.get("p1"),
        { channel: "chan-hex", grantB: "grant-hex", createdAt: 111, firstDeliveredAt: undefined },
        "the grant survives the restart intact"
      );

      // The participant's first successful poll after the restart still gets their grant...
      const res = fakeRes();
      handleJoinRequestStatus({}, res, new Map(), afterRestart, "p1");
      assert.deepEqual(JSON.parse(res.body), { status: "approved", channel: "chan-hex", grant: "grant-hex" });
      assert.ok(afterRestart.has("p1"), "still present in memory -- within the grace window (#57)");

      // ...and the firstDeliveredAt stamp is itself persisted, so a SECOND redeploy within the
      // grace window still honors the same delivery window rather than resetting it.
      const afterSecondRestart = loadPendingGrants();
      assert.ok(afterSecondRestart.get("p1").firstDeliveredAt, "firstDeliveredAt survives a restart too");
    });
  }
);

test("loadPendingGrants: a missing or malformed file degrades to an empty Map, never throws", async () => {
  await withEnv({ SORT_PENDING_GRANTS_FILE: tmpFile("does-not-exist.json") }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { loadPendingGrants } = require("./server.js");
    assert.equal(loadPendingGrants().size, 0, "no file -> empty, not a crash");
  });
  const bad = tmpFile("corrupt.json");
  fs.writeFileSync(bad, "{ this is not json");
  await withEnv({ SORT_PENDING_GRANTS_FILE: bad }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { loadPendingGrants } = require("./server.js");
    assert.equal(loadPendingGrants().size, 0, "corrupt file -> empty, not a crash");
  });
});

// --- Self-service liveness sweep (CADS-DEMO-sort#28: roster must not fill with dead participants) -

function seedApprovedFile(entries) {
  const file = tmpFile("participants-approved.json");
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}

test("reconcileApprovedParticipants: prunes a self-service entry with no connection in >TTL, keeps a fresh one", async () => {
  const now = 1_000_000_000_000;
  const ttlMs = 24 * 60 * 60 * 1000;
  const file = seedApprovedFile([
    { you: "dead-test", label: "dead", cmd: "x", lastSeenAt: now - ttlMs - 1 },
    { you: "live-one", label: "live", cmd: "y", lastSeenAt: now - 60_000 },
  ]);
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: file, SORT_PARTICIPANTS_FILE: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { reconcileApprovedParticipants } = require("./server.js");
    const participants = new Map([
      ["dead-test", { you: "dead-test", label: "dead", cmd: "x" }],
      ["live-one", { you: "live-one", label: "live", cmd: "y" }],
    ]);
    const { pruned, kept } = reconcileApprovedParticipants(participants, { now, ttlMs, lastSeen: new Map() });
    assert.deepEqual(pruned, ["dead-test"], "the stale entry is pruned");
    assert.equal(participants.has("dead-test"), false, "and removed from the live roster Map");
    assert.equal(participants.has("live-one"), true, "the fresh entry stays live");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(onDisk.map((e) => e.you), ["live-one"], "the approved file no longer lists the dead one");
    assert.equal(kept.length, 1);
  });
});

test("reconcileApprovedParticipants: a recorded connection refreshes liveness so an otherwise-stale entry survives", async () => {
  const now = 1_000_000_000_000;
  const ttlMs = 24 * 60 * 60 * 1000;
  const file = seedApprovedFile([{ you: "p1", label: "p1", cmd: "x", lastSeenAt: now - ttlMs - 1 }]);
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: file, SORT_PARTICIPANTS_FILE: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { reconcileApprovedParticipants } = require("./server.js");
    const participants = new Map([["p1", { you: "p1", label: "p1", cmd: "x" }]]);
    // A real dial just landed: the in-memory map says p1 connected 30s ago, overriding the stale
    // file timestamp -- exactly what seenRecordingCall does on a successful roleCall.
    const { pruned } = reconcileApprovedParticipants(participants, { now, ttlMs, lastSeen: new Map([["p1", now - 30_000]]) });
    assert.deepEqual(pruned, [], "a freshly-seen participant is not pruned");
    assert.equal(participants.has("p1"), true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk[0].lastSeenAt, now - 30_000, "the refreshed timestamp is flushed to disk for restart-durability");
  });
});

test("reconcileApprovedParticipants: never touches a base-file participant; a pruned-but-also-base id falls back to base", async () => {
  const now = 1_000_000_000_000;
  const ttlMs = 24 * 60 * 60 * 1000;
  // 'overridden' is stale in the approved file BUT also defined in the operator's base file.
  const baseFile = tmpFile("participants-base.json");
  fs.writeFileSync(baseFile, JSON.stringify([
    { you: "reference-sorter", label: "Reference", cmd: "ref" },
    { you: "overridden", label: "Base version", cmd: "base-cmd" },
  ]));
  const approvedFile = seedApprovedFile([
    { you: "overridden", label: "Self-service override", cmd: "ss-cmd", lastSeenAt: now - ttlMs - 1 },
  ]);
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: approvedFile, SORT_PARTICIPANTS_FILE: baseFile, SORT_PARTICIPANTS_JSON: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { reconcileApprovedParticipants } = require("./server.js");
    const participants = new Map([
      ["reference-sorter", { you: "reference-sorter", label: "Reference", cmd: "ref" }],
      ["overridden", { you: "overridden", label: "Self-service override", cmd: "ss-cmd" }],
    ]);
    const { pruned } = reconcileApprovedParticipants(participants, { now, ttlMs, lastSeen: new Map() });
    assert.deepEqual(pruned, ["overridden"], "only the approved-file override is pruned");
    assert.equal(participants.has("reference-sorter"), true, "the base-only participant is never even considered");
    assert.equal(participants.get("overridden").cmd, "base-cmd", "pruning the override falls back to the base entry, not deletion");
  });
});

test("reconcileApprovedParticipants: a legacy entry with no lastSeenAt gets a full-TTL grace window from bootTime, not deleted", async () => {
  const now = 1_000_000_000_000;
  const ttlMs = 24 * 60 * 60 * 1000;
  const file = seedApprovedFile([{ you: "legacy", label: "legacy", cmd: "x" }]); // no lastSeenAt
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: file, SORT_PARTICIPANTS_FILE: "" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { reconcileApprovedParticipants } = require("./server.js");
    const participants = new Map([["legacy", { you: "legacy", label: "legacy", cmd: "x" }]]);
    const { pruned } = reconcileApprovedParticipants(participants, { now, ttlMs, bootTime: now, lastSeen: new Map() });
    assert.deepEqual(pruned, [], "legacy entry survives the boot sweep");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk[0].lastSeenAt, now, "and is stamped with bootTime so it ages from the deploy, not forever");
  });
});

test("addApprovedParticipant: stamps lastSeenAt at approval time (approval counts as a connection)", async () => {
  const file = tmpFile("participants-approved.json");
  await withEnv({ SORT_PARTICIPANTS_APPROVED_FILE: file }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { addApprovedParticipant, resetParticipantSeenForTests } = require("./server.js");
    resetParticipantSeenForTests();
    const participants = new Map();
    addApprovedParticipant(participants, { you: "fresh", label: "fresh", cmd: "z" });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.equal(typeof onDisk[0].lastSeenAt, "number", "a lastSeenAt is stamped so the sweep gives it a full TTL window");
  });
});

// --- Self-service leave (CADS-DEMO-sort#30: join is self-service, leaving must be too) ---------

test("handleParticipantLeave: a holder-key-signed request removes the participant; wrong key / unknown id / bad sig are refused", async () => {
  const genIdentity = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
      pub: publicKey.export({ type: "spki", format: "der" }).subarray(-32),
      priv: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32),
    };
  };
  const operator = genIdentity();
  const bridgeHolder = genIdentity();
  const participant = { holder: genIdentity(), noise: genIdentity() };
  const attacker = { holder: genIdentity(), noise: genIdentity() };

  const { channelIdForLink, memberNoiseAttestBytes } = require("./attestation.js");
  const sign = (holderPriv, msg) =>
    crypto.sign(null, msg, crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), holderPriv]),
      format: "der",
      type: "pkcs8",
    }));
  const channel = channelIdForLink(operator.pub, bridgeHolder.pub, participant.holder.pub);
  const goodAttestation = sign(participant.holder.priv, memberNoiseAttestBytes(channel, participant.holder.pub, participant.noise.pub));

  const approvedFile = tmpFile("participants-approved.json");
  fs.writeFileSync(approvedFile, JSON.stringify([
    { you: "leaver", label: "Leaver", cmd: "x", holderPub: participant.holder.pub.toString("hex") },
    { you: "admin-added", label: "Admin", cmd: "y" }, // no holderPub -> not self-leavable
  ]));

  await withEnv({
    SORT_PARTICIPANTS_APPROVED_FILE: approvedFile,
    SORT_PARTICIPANTS_FILE: "",
    SORT_CHANNEL_OPERATOR_PUBKEY: operator.pub.toString("hex"),
    SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: bridgeHolder.pub.toString("hex"),
  }, async () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleParticipantLeave } = require("./server.js");
    const body = (h, n, a) => fakeReq({ holderPub: h.toString("hex"), noisePub: n.toString("hex"), attestation: a.toString("hex") });

    // Unknown id -> 404.
    let res = fakeRes();
    await handleParticipantLeave(body(participant.holder.pub, participant.noise.pub, goodAttestation), res, new Map(), "nobody");
    assert.equal(res.statusCode, 404);

    // Admin-added entry (no stored holderPub) -> 404, never self-leavable.
    res = fakeRes();
    await handleParticipantLeave(body(participant.holder.pub, participant.noise.pub, goodAttestation), res, new Map(), "admin-added");
    assert.equal(res.statusCode, 404);

    // Attacker signs for THEIR own valid identity but submits it against someone else's id -> 403
    // (their holderPub doesn't match the stored one). This is the griefing case the check exists for.
    const attackerChannel = channelIdForLink(operator.pub, bridgeHolder.pub, attacker.holder.pub);
    const attackerAttestation = sign(attacker.holder.priv, memberNoiseAttestBytes(attackerChannel, attacker.holder.pub, attacker.noise.pub));
    res = fakeRes();
    await handleParticipantLeave(body(attacker.holder.pub, attacker.noise.pub, attackerAttestation), res, new Map(), "leaver");
    assert.equal(res.statusCode, 403, "another identity's valid signature must not remove a different participant");

    // Right holderPub but a signature that doesn't verify -> 400.
    res = fakeRes();
    const garbageSig = Buffer.alloc(64, 7);
    await handleParticipantLeave(body(participant.holder.pub, participant.noise.pub, garbageSig), res, new Map(), "leaver");
    assert.equal(res.statusCode, 400);

    // The real thing: correct identity, correct signature -> removed, id freed.
    const participants = new Map([["leaver", { you: "leaver", label: "Leaver", cmd: "x" }]]);
    res = fakeRes();
    await handleParticipantLeave(body(participant.holder.pub, participant.noise.pub, goodAttestation), res, participants, "leaver");
    assert.equal(res.statusCode, 200);
    assert.equal(participants.has("leaver"), false, "removed from the live roster Map");
    const onDisk = JSON.parse(fs.readFileSync(approvedFile, "utf8"));
    assert.equal(onDisk.some((p) => p.you === "leaver"), false, "removed from the approved file too");
    assert.equal(onDisk.some((p) => p.you === "admin-added"), true, "the admin-added entry is untouched");
  });
});

// --- Automation session (admin.html's real login form -> POST /api/admin/oidc-session) --------

test("currentOidcToken: falls back to the static SORT_OIDC_TOKEN when no live session exists", async () => {
  await withEnv({ SORT_OIDC_TOKEN: "static-fallback-token" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { currentOidcToken, resetOidcSessionForTests } = require("./server.js");
    resetOidcSessionForTests();
    assert.equal(currentOidcToken(), "static-fallback-token");
  });
});

test("ensureServiceOidcToken: mints via client_credentials, caches it, and currentOidcToken prefers it (sort#9 durable tier)", async () => {
  // The durable auth tier: a client_credentials grant that survives redeploys, no human re-arm.
  // Stub issuer that returns a real token JSON for a client_credentials POST and records the grant.
  let grantsSeen = [];
  const issuer = require("node:http").createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const params = new URLSearchParams(b);
      grantsSeen.push(params.get("grant_type"));
      if (params.get("grant_type") === "client_credentials" && params.get("client_secret") === "s3cr3t") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "svc-token-xyz", expires_in: 300 }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client" }));
      }
    });
  });
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const issuerBase = `http://127.0.0.1:${issuer.address().port}/realms/ct-demo`;
  try {
    await withEnv(
      {
        SORT_OIDC_ISSUER_BASE: issuerBase,
        SORT_OIDC_CLIENT_ID: "sort-bridge-automation",
        SORT_OIDC_CLIENT_SECRET: "s3cr3t",
        SORT_OIDC_TOKEN: "static-should-not-win",
      },
      async () => {
        delete require.cache[require.resolve("./server.js")];
        const { ensureServiceOidcToken, currentOidcToken, automationConfigured, resetOidcSessionForTests } = require("./server.js");
        resetOidcSessionForTests();
        const t = await ensureServiceOidcToken();
        assert.equal(t, "svc-token-xyz", "minted the service token via client_credentials");
        assert.equal(currentOidcToken(), "svc-token-xyz", "the service token wins over the static fallback");
        // A second call must reuse the cache, not re-grant.
        await ensureServiceOidcToken();
        assert.equal(grantsSeen.filter((g) => g === "client_credentials").length, 1, "second call reused the cache");
      }
    );
  } finally {
    await new Promise((r) => issuer.close(r));
  }
});

test("handleOidcSessionSubmit: fails closed (503) when SORT_ADMIN_EMAILS is unset", async () => {
  await withEnv({ SORT_ADMIN_EMAILS: "" }, async () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleOidcSessionSubmit, resetOidcSessionForTests } = require("./server.js");
    resetOidcSessionForTests();
    const res = fakeRes();
    await handleOidcSessionSubmit(fakeReq({ accessToken: "a", refreshToken: "r", expiresIn: 300, refreshExpiresIn: 1800 }, {}), res);
    assert.equal(res.statusCode, 503);
  });
});

test("handleOidcSessionSubmit: rejects a malformed body (400), never starts a session", async () => {
  await withEnv({ SORT_ADMIN_EMAILS: "operator@example.com" }, async () => {
    delete require.cache[require.resolve("./server.js")];
    const { handleOidcSessionSubmit, currentOidcToken, resetOidcSessionForTests } = require("./server.js");
    resetOidcSessionForTests();
    const res = fakeRes();
    await handleOidcSessionSubmit(
      fakeReq({ accessToken: "a", refreshToken: "r" }, { "x-gate-email": "operator@example.com" }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(currentOidcToken(), undefined);
  });
});

test(
  "handleOidcSessionSubmit: starts a real self-refreshing session -- currentOidcToken reflects a live auto-refresh against a real stub issuer",
  async () => {
    await withEnv(
      { SORT_ADMIN_EMAILS: "operator@example.com", SORT_OIDC_ISSUER_BASE: "placeholder-set-below" },
      async () => {
        // Real HTTP stub standing in for Keycloak's token endpoint: accepts one refresh_token
        // grant, returns a NEW access/refresh token pair so the test can prove the bridge
        // actually replaced the old access token, not just kept using the one it started with.
        const refreshCalls = [];
        const stub = require("node:http").createServer((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            const params = new URLSearchParams(body);
            refreshCalls.push(Object.fromEntries(params));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: "refreshed-access-token", refresh_token: "refreshed-refresh-token", expires_in: 300 }));
          });
        });
        await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
        const issuerBase = `http://127.0.0.1:${stub.address().port}`;
        try {
          await withEnv({ SORT_OIDC_ISSUER_BASE: issuerBase }, async () => {
            delete require.cache[require.resolve("./server.js")];
            const { handleOidcSessionSubmit, currentOidcToken, resetOidcSessionForTests } = require("./server.js");
            resetOidcSessionForTests();
            const res = fakeRes();
            // expiresIn=1 is deliberately far below the 30s refresh margin, so scheduleNext's
            // Math.max(5000, ...) clamp kicks in -- the refresh fires ~5s from now, in real
            // wall-clock time. Short but real; this is the same "verify for real, don't mock the
            // clock" discipline the rest of this file already uses for the grant-binary test.
            await handleOidcSessionSubmit(
              fakeReq(
                { accessToken: "first-access-token", refreshToken: "first-refresh-token", expiresIn: 1, refreshExpiresIn: 1800 },
                { "x-gate-email": "operator@example.com" }
              ),
              res
            );
            assert.equal(res.statusCode, 200, res.body);
            assert.equal(currentOidcToken(), "first-access-token", "access token is live immediately, before any refresh has run");

            await new Promise((resolve) => setTimeout(resolve, 6_000));

            assert.equal(refreshCalls.length, 1, "exactly one real refresh_token grant call happened");
            assert.equal(refreshCalls[0].grant_type, "refresh_token");
            assert.equal(refreshCalls[0].refresh_token, "first-refresh-token");
            assert.equal(currentOidcToken(), "refreshed-access-token", "currentOidcToken reflects the real refreshed value");

            resetOidcSessionForTests();
          });
        } finally {
          stub.close();
        }
      }
    );
  }
);

test("GET /api/channel-info includes the #106 :443 fallback fields when configured, omits them when not", async () => {
  // NOTE (2026-08-13 incident): the handler is now async and the cert is live-fetched from the
  // CP's /pki/ca with the env var as a validated fallback -- in this test env SORT_CP_URL is
  // unset, so the fetch fails and the (valid-hex) env fallback is what gets served.
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: "op-pub",
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: "bridge-holder-pub",
      SORT_CHANNEL_BROKER: "test-edge:4435",
      SORT_CHANNEL_RELAY: "test-edge:4436",
      SORT_CHANNEL_FRONT_DOOR: "test-edge:443",
      SORT_CHANNEL_FRONT_DOOR_CERT: "deadbeef",
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleChannelInfo } = require("./server.js");
      const res = fakeRes();
      await handleChannelInfo({}, res);
      const body = JSON.parse(res.body);
      assert.equal(body.channelBroker, "test-edge:4435");
      assert.equal(body.channelRelay, "test-edge:4436");
      assert.equal(body.channelFrontDoor, "test-edge:443");
      assert.equal(body.channelFrontDoorCert, "deadbeef");
    }
  );

  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: "op-pub",
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: "bridge-holder-pub",
      SORT_CHANNEL_BROKER: "test-edge:4435",
      SORT_CHANNEL_RELAY: "test-edge:4436",
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleChannelInfo } = require("./server.js");
      const res = fakeRes();
      await handleChannelInfo({}, res);
      const body = JSON.parse(res.body);
      assert.equal(body.channelFrontDoor, null, "unconfigured -> null, not a broken/empty string");
      assert.equal(body.channelFrontDoorCert, null);
    }
  );
});

test(
  "handleChannelInfo: deploySha (CADS-DEMO-sort#52) -- null when the image was built without it, " +
    "passed through verbatim when it was",
  async () => {
    await withEnv({ SORT_DEPLOY_SHA: "" }, async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleChannelInfo } = require("./server.js");
      const res = fakeRes();
      await handleChannelInfo({}, res);
      assert.equal(JSON.parse(res.body).deploySha, null, "unset/empty build-arg -> null, not empty string");
    });
    await withEnv({ SORT_DEPLOY_SHA: "a1a18b9" }, async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleChannelInfo } = require("./server.js");
      const res = fakeRes();
      await handleChannelInfo({}, res);
      assert.equal(JSON.parse(res.body).deploySha, "a1a18b9", "passed through verbatim, not reformatted");
    });
  }
);

test("GET /api/channel-info never serves an undecodable (odd-length/non-hex) cert -- the 2026-08-13 incident", async () => {
  // The real outage: a hand-copied env cert was odd-length (3 chars dropped) AND stale after a
  // CA reissue. Every consumer -- join.html participants and the bridge's own role command --
  // died with `CT_CHANNEL_FRONT_DOOR_CERT must be hex DER` (600/600 arena rounds faulted).
  // Contract: a value that fails the hex-DER parity/charset check is NEVER served; the field is
  // null (participants simply lose the optional fallback rung) instead of crashing everyone.
  await withEnv(
    {
      SORT_CHANNEL_OPERATOR_PUBKEY: "op-pub",
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: "bridge-holder-pub",
      SORT_CHANNEL_BROKER: "test-edge:4435",
      SORT_CHANNEL_RELAY: "test-edge:4436",
      SORT_CHANNEL_FRONT_DOOR: "test-edge:443",
      SORT_CHANNEL_FRONT_DOOR_CERT: "abcde", // odd length -- undecodable, like the live incident
    },
    async () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleChannelInfo } = require("./server.js");
      const res = fakeRes();
      await handleChannelInfo({}, res);
      const body = JSON.parse(res.body);
      assert.equal(
        body.channelFrontDoorCert,
        null,
        "an undecodable cert must be withheld, not served to crash every consumer"
      );
    }
  );
});

/** True while `pid` names a live, non-zombie process. Linux-only (/proc), which is what this
 *  bridge runs on and what CI runs. */
function pidAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/** Regression test for the real zombie leak measured in production: the running bridge
 *  accumulated 75 `<defunct>` children in ~1h (one per timed-out `ct-agent channel` dial,
 *  CADS-DEMO-sort#9). `sh -c "VAR=val ct-agent channel"` forks a real grandchild and waits on it,
 *  so SIGKILLing only the direct `sh` left `ct-agent` running and orphaned; since the bridge is
 *  PID 1 in its container the orphan was reparented to the bridge itself, which never waitpid()s
 *  anything it did not spawn, so it stayed a zombie forever.
 *
 *  This asserts the property that actually prevents that — no descendant survives the timeout —
 *  rather than counting zombies, because a zombie only materialises when the parent is PID 1. The
 *  test runner is not PID 1, so here the orphan would be reparented to init and silently reaped;
 *  a zombie-count assertion would pass even against the unfixed code. */
test("PersistentRoleClient: multiplexes calls over ONE held process and reports its pid stably (#19)", async () => {
  // The whole point of #19: call N+1 must reuse the SAME child (one held channel session),
  // not spawn per call. The stub speaks the exact ct-agent v0.4.9 envelope contract: one JSON
  // request per stdin line, one {"ok":true,"output":...} envelope per stdout line -- and embeds
  // its own $$-equivalent (process.pid) in the output so same-process reuse is OBSERVABLE.
  const { PersistentRoleClient } = require("./server.js");
  const stub =
    `node -e '` +
    `const rl=require("readline").createInterface({input:process.stdin});` +
    `rl.on("line",(l)=>{const req=JSON.parse(l);` +
    `console.log(JSON.stringify({ok:true,output:JSON.stringify({pid:process.pid,echo:req.round})}))});` +
    `'`;
  const client = new PersistentRoleClient(async () => stub);
  const a = JSON.parse(await client.call({ round: 1 }, 5000));
  const b = JSON.parse(await client.call({ round: 2 }, 5000));
  const c = JSON.parse(await client.call({ round: 3 }, 5000));
  assert.equal(a.echo, 1);
  assert.equal(b.echo, 2);
  assert.equal(c.echo, 3);
  assert.equal(a.pid, b.pid, "call 2 reused the SAME held process");
  assert.equal(b.pid, c.pid, "call 3 too -- one session per participant, not per round");
  client._kill();
});

test("PersistentRoleClient: a dead child is respawned transparently and an error envelope surfaces as a named error (#19)", async () => {
  const { PersistentRoleClient } = require("./server.js");
  // Stub 1: answers one call, then exits (simulates a mid-run session death between rounds).
  const dieAfterOne =
    `node -e '` +
    `const rl=require("readline").createInterface({input:process.stdin});` +
    `rl.on("line",()=>{console.log(JSON.stringify({ok:true,output:String(process.pid)}));process.exit(0)});` +
    `'`;
  const client = new PersistentRoleClient(async () => dieAfterOne);
  const pid1 = await client.call({ round: 1 }, 5000);
  // The child exited after answering; the next call must respawn (new pid), not fail.
  const pid2 = await client.call({ round: 2 }, 5000);
  assert.notEqual(pid1, pid2, "the second call ran on a RESPAWNED child after the first one died");
  client._kill();

  // An {"ok":false,...} envelope surfaces as a named error (after the one respawn+retry).
  const alwaysErr =
    `node -e '` +
    `const rl=require("readline").createInterface({input:process.stdin});` +
    `rl.on("line",()=>console.log(JSON.stringify({ok:false,error:"service exploded"})));` +
    `'`;
  const failing = new PersistentRoleClient(async () => alwaysErr);
  await assert.rejects(
    () => failing.call({ round: 1 }, 5000),
    /service exploded/,
    "the structured error reason reaches the caller verbatim"
  );
  failing._kill();
});

test("PersistentRoleClient: an IDLE session death triggers a proactive pre-warm respawn (#25)", async () => {
  // The sort#25 regression: a session dying BETWEEN rounds used to be discovered only by the
  // next round call, which then paid the whole dial+pair inside its own timeout budget
  // (measured live: 60-100s round-1 latency vs 110ms on an intact session). The fix pre-warms:
  // the close handler schedules a respawn immediately, so a replacement child exists BEFORE any
  // call arrives. Observable via spawn count: 2 spawns with ZERO calls in between.
  const { PersistentRoleClient } = require("./server.js");
  let spawns = 0;
  // Stub: announces itself with a first envelope nobody consumes, then dies after 150ms --
  // simulating ct-agent's exit-on-session-death. The client must respawn it unprompted.
  const dieQuick =
    `node -e 'setTimeout(()=>process.exit(1),150);setInterval(()=>{},1000)'`;
  const client = new PersistentRoleClient(async () => {
    spawns += 1;
    return dieQuick;
  });
  await client._ensureChild();
  assert.equal(spawns, 1, "first spawn is explicit");
  // Wait past the child's 150ms death + the 500ms initial pre-warm backoff.
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(spawns >= 2, `close handler pre-warmed a replacement with no call in flight (spawns=${spawns})`);
  // Backoff must grow (500 -> 1000 -> ...) rather than hot-loop -- the #250 storm class.
  assert.ok(client.respawnDelayMs > 500, `respawn backoff grew (now ${client.respawnDelayMs}ms)`);
  assert.ok(spawns <= 4, `backoff kept the respawn cadence modest over ~1.2s (spawns=${spawns})`);
  if (client.respawnTimer) clearTimeout(client.respawnTimer);
  client._kill();
});

test("PersistentRoleClient: a stale killed child's late 'close' event must not settle a NEWER call (found live 2026-08-26)", async () => {
  // Live incident: call() times out on a hung child, kills it, and retries on a fresh child --
  // but _kill()'s SIGKILL is asynchronous, so the OLD child's own 'close' event can arrive AFTER
  // the retry has already spawned a new child and moved this.pendingResolve on to it. Without
  // per-call child tracking, that stale close incorrectly rejected the RETRY's promise using the
  // dead child's exit reason, even when the fresh child was about to answer correctly --
  // reproduced live as a participant's run cycling through repeated 30s timeouts against a
  // channel that a moment later proved perfectly dialable. This drives the same real shape (a
  // hung first attempt timing out, a fast-answering retry) end to end through the public call()
  // API and asserts the retry's own real answer wins, not a stale error about the first child.
  const { PersistentRoleClient } = require("./server.js");
  const hangsForever = `node -e 'setInterval(()=>{}, 1000)'`; // never reads stdin, never replies
  const answersInstantly =
    `node -e '` +
    `const rl=require("readline").createInterface({input:process.stdin});` +
    `rl.on("line",()=>console.log(JSON.stringify({ok:true,output:"fresh-child-answer"})));` +
    `'`;
  let calls = 0;
  const client = new PersistentRoleClient(async () => {
    calls += 1;
    return calls === 1 ? hangsForever : answersInstantly;
  });
  const out = await client.call({ round: 1 }, 150); // short timeout: attempt 1 hangs, kills, retries
  assert.equal(out, "fresh-child-answer", "the retry's real answer must win over the first child's stale, later-arriving close event");
  client._kill();
});

test("callHandlerProcess: caps concurrent spawns and queues the rest, without dropping or deadlocking any of them (sort#44)", async () => {
  await withEnv({ SORT_MAX_CONCURRENT_SPAWNS: "3", SORT_MAX_QUEUED_SPAWNS: "50" }, async () => {
    delete require.cache[require.resolve("./server.js")];
    const { callHandlerProcess } = require("./server.js");

    // Each call increments a shared counter on start and decrements on exit, recording the peak
    // it ever observed to its own output line -- a real, measured high-water mark of how many ran
    // AT ONCE, not an assumption. `flock` serializes the read-increment-write so concurrent shells
    // don't race each other updating the same counter file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sort-spawn-cap-"));
    const counterFile = path.join(dir, "counter");
    const peakFile = path.join(dir, "peak");
    fs.writeFileSync(counterFile, "0");
    fs.writeFileSync(peakFile, "0");
    const cmd =
      `flock ${counterFile} -c '` +
      `n=$(($(cat ${counterFile})+1)); echo $n > ${counterFile}; ` +
      `p=$(cat ${peakFile}); [ $n -gt $p ] && echo $n > ${peakFile}; true` +
      `'; ` +
      `sleep 0.3; ` +
      `flock ${counterFile} -c 'echo $(($(cat ${counterFile})-1)) > ${counterFile}'; ` +
      `echo '{"ok":true}'`;

    const N = 9; // 3x the cap, so the queue is genuinely exercised, not just the fast path
    const results = await Promise.all(
      Array.from({ length: N }, () => callHandlerProcess(cmd, { probe: true }, 5000))
    );

    assert.equal(results.length, N, "every queued call must eventually resolve -- none dropped");
    for (const r of results) assert.equal(r.trim(), '{"ok":true}');

    const peak = Number(fs.readFileSync(peakFile, "utf8").trim());
    assert.ok(peak <= 3, `observed ${peak} concurrent handlers running at once, cap was 3`);
    assert.ok(peak >= 1, "sanity: the counter mechanism itself must have recorded something");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("callHandlerProcess: a timeout kills the whole process group, not just the direct `sh` child", async (t) => {
  if (process.platform !== "linux") return t.skip("needs /proc to observe real process state");
  const { callHandlerProcess } = require("./server.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sort-pgroup-"));
  const pidFile = path.join(dir, "grandchild.pid");
  // A real grandchild that outlives a naive kill of just `sh`, structurally like the production
  // `VAR=val ct-agent channel` invocation. The trailing `echo` guarantees the outer shell forks
  // instead of exec-replacing itself (dash exec-optimises a lone final command), and `exec sleep`
  // makes the recorded `$$` the pid of the long-lived process itself.
  const cmd = `CT_MARKER=sort-demo sh -c 'echo $$ > ${pidFile}; exec sleep 30'; echo done`;

  await assert.rejects(() => callHandlerProcess(cmd, { probe: true }, 1500), /timed out/);

  assert.ok(fs.existsSync(pidFile), "handler must actually have forked a grandchild to be a valid test");
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `bad recorded pid: ${grandchildPid}`);

  // SIGKILL is delivered by the kernel, not synchronously with the promise rejection.
  const reaped = await waitUntil(() => !pidAlive(grandchildPid), 5000);
  if (!reaped) {
    try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(reaped, `grandchild ${grandchildPid} survived the timeout -- the process group was not killed`);
});

test(
  "seenRecordingCall: a successful call marks the participant everAnswered, a failed one does not " +
    "(CADS-DEMO-sort#58: GET /participants must be able to tell 'ever completed a real call' apart " +
    "from 'was approved and never answered anything' -- lastSeenAt alone can't, since approval " +
    "stamps it too)",
  async () => {
    delete require.cache[require.resolve("./server.js")];
    const {
      seenRecordingCall,
      hasParticipantEverAnswered,
      resetParticipantEverAnsweredForTests,
    } = require("./server.js");
    resetParticipantEverAnsweredForTests();

    assert.equal(hasParticipantEverAnswered("p1"), false, "starts false -- never seen a call yet");

    // A trivial local (non-channel) command, same "echo JSON" convention as the concurrency test
    // above -- roleCall routes it straight to callHandlerProcess since it doesn't match ct-agent channel.
    const okCall = seenRecordingCall("p1", `echo '{"ok":true}'`);
    await okCall({ probe: true });
    assert.ok(hasParticipantEverAnswered("p1"), "a resolved roleCall marks the participant everAnswered");

    // A different, never-called participant must stay false -- this isn't a global flag.
    assert.equal(hasParticipantEverAnswered("p2"), false, "unrelated participant unaffected");

    // A rejected dial (timeout) must NOT mark everAnswered -- mirrors #28's own rule for lastSeenAt
    // ("a rejected dial deliberately does NOT touch the timestamp"), same reasoning applies here.
    // TIMEOUT_MS is resolved from SORT_ROUND_TIMEOUT_MS at module load, so it needs a fresh require.
    await withEnv({ SORT_ROUND_TIMEOUT_MS: "500" }, async () => {
      delete require.cache[require.resolve("./server.js")];
      const {
        seenRecordingCall: seenRecordingCallShortTimeout,
        hasParticipantEverAnswered: hasEverAnsweredShortTimeout,
        resetParticipantEverAnsweredForTests: resetShortTimeout,
      } = require("./server.js");
      resetShortTimeout();
      const timeoutCall = seenRecordingCallShortTimeout("p3", "sleep 30");
      await assert.rejects(() => timeoutCall({ probe: true }), /timed out/, "sanity: the call actually failed");
      assert.equal(hasEverAnsweredShortTimeout("p3"), false, "a rejected dial must not mark everAnswered");
    });
  }
);

test(
  "getParticipantLastSeen: stays frozen across a run of failed calls, so it distinguishes " +
    "'answered once, now hangs every round' from 'currently healthy' -- everAnswered alone can't " +
    "(CADS-DEMO-sort#58 follow-up: live-reproduced 2026-08-28, two real participants that had once " +
    "answered kept everAnswered:true while timing out every subsequent round)",
  async () => {
    delete require.cache[require.resolve("./server.js")];
    const {
      getParticipantLastSeen,
      recordParticipantSeen,
      resetParticipantSeenForTests,
      seenRecordingCall,
      hasParticipantEverAnswered,
      resetParticipantEverAnsweredForTests,
    } = require("./server.js");
    resetParticipantSeenForTests();
    resetParticipantEverAnsweredForTests();

    assert.equal(getParticipantLastSeen("tobi"), null, "starts null -- never seen a call yet");

    // Mirrors the live case exactly: one successful call (stamps both everAnswered and lastSeenAt)...
    const okCall = seenRecordingCall("tobi", `echo '{"ok":true}'`);
    await okCall({ probe: true });
    assert.ok(hasParticipantEverAnswered("tobi"), "sanity: the one success marks everAnswered");
    const firstSeenAt = getParticipantLastSeen("tobi");
    assert.equal(typeof firstSeenAt, "number", "lastSeenAt is stamped by the successful call");

    // ...then every round since hangs (rejects on timeout). everAnswered stays true (it never
    // decays -- that's finding #58's original gap), but lastSeenAt must NOT advance, because a
    // rejected dial deliberately doesn't touch it (#28's rule, reused here on purpose).
    await withEnv({ SORT_ROUND_TIMEOUT_MS: "500" }, async () => {
      delete require.cache[require.resolve("./server.js")];
      const {
        getParticipantLastSeen: getLastSeenShortTimeout,
        recordParticipantSeen: recordSeenShortTimeout,
        seenRecordingCall: seenRecordingCallShortTimeout,
      } = require("./server.js");
      // Fresh require means a fresh in-memory Map/Set -- seed it back to the same "answered once,
      // now hanging" state under this short-timeout module instance specifically (recordSeenShortTimeout,
      // not the outer recordParticipantSeen, which is bound to the earlier module instance).
      recordSeenShortTimeout("tobi", firstSeenAt);
      const hangingCall = seenRecordingCallShortTimeout("tobi", "sleep 30");
      await assert.rejects(() => hangingCall({ probe: true }), /timed out/, "sanity: this round hangs");
      assert.equal(
        getLastSeenShortTimeout("tobi"),
        firstSeenAt,
        "a hung round must not refresh lastSeenAt -- it must stay pinned to the one real success"
      );
    });

    // A currently-healthy participant, by contrast, keeps refreshing -- this is the pairing that
    // lets a reader tell the two apart: same everAnswered:true, different (fresh vs. stale) lastSeenAt.
    const healthyCall = seenRecordingCall("bennet", `echo '{"ok":true}'`);
    await healthyCall({ probe: true });
    const healthySeenAt = getParticipantLastSeen("bennet");
    await new Promise((r) => setTimeout(r, 5));
    await healthyCall({ probe: true });
    assert.ok(
      getParticipantLastSeen("bennet") >= healthySeenAt,
      "a repeatedly-succeeding participant keeps its lastSeenAt current"
    );
  }
);

test("channelCollisionDetail: explains a holder-pair collision instead of implying a missing permission", () => {
  // 2026-08-17: a tester hit `403 channel owned by another subject`, tried again under a
  // second display name, got the identical error, and reasonably concluded their account
  // had to be authorised for the arena channel. There is nothing to authorise -- every
  // participant gets their OWN channel, and the id is derived from the holder PAIR, so a
  // different NAME cannot change it. The control-plane wording reads like a permission
  // problem; this freezes the wording that says what actually happened and what to do.
  const ch = "ab".repeat(32);
  const msg = require("./server.js").channelCollisionDetail(ch);

  assert.match(msg, /collision, not a missing permission/i, "names the real cause");
  assert.match(msg, /different participant NAME cannot change it/i,
    "pre-empts the retry that the tester actually made twice");
  assert.ok(msg.includes(ch), "names the channel id -- the next step needs it");
  assert.match(msg, new RegExp(`DELETE /me/channels/${ch}`), "gives the exact remedy");
  assert.match(msg, /freshly generated holder keypair/i, "and the cheaper remedy first");
});
