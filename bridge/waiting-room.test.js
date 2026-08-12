"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "testdata", "attestation-vectors.json"), "utf8")
);

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
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers;
    },
    end(body) {
      res.body = body;
    },
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
    assert.deepEqual(onDisk, [{ you: "new-one", label: "New One", cmd: "echo new" }]);

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
    () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestApprove } = require("./server.js");
      const res = fakeRes();
      handleJoinRequestApprove({ headers: { "x-gate-email": "operator@example.com" } }, res, new Map(), "nobody");
      assert.equal(res.statusCode, 404);
    }
  );
});

test("handleJoinRequestApprove: on success, removes the request from the queue and returns the real channel id", async () => {
  await withEnv(
    {
      SORT_ADMIN_EMAILS: "operator@example.com",
      SORT_CHANNEL_OPERATOR_PUBKEY: vectors.operator_pub,
      SORT_CHANNEL_BRIDGE_HOLDER_PUBKEY: vectors.holder_b_pub,
      SORT_JOIN_REQUESTS_FILE: tmpFile("join-requests.json"),
    },
    () => {
      delete require.cache[require.resolve("./server.js")];
      const { handleJoinRequestApprove } = require("./server.js");
      const joinRequests = new Map([
        ["real-participant", { you: "real-participant", label: "RP", holderPub: vectors.holder_a_pub, noisePub: vectors.noise_a_pub, attestation: vectors.positive.signature, createdAt: 1 }],
      ]);
      const res = fakeRes();
      handleJoinRequestApprove({ headers: { "x-gate-email": "operator@example.com" } }, res, joinRequests, "real-participant");
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.channel, vectors.channel_id_for_link_a_b);
      assert.equal(joinRequests.size, 0, "approved request must leave the pending queue");
      assert.ok(Array.isArray(body.manualSteps) && body.manualSteps.length > 0);
    }
  );
});
