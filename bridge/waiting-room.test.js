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
        },
        async () => {
          delete require.cache[require.resolve("./server.js")];
          const { handleJoinRequestApprove } = require("./server.js");
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
          assert.match(cmd, new RegExp(`CT_CHANNEL_HOLDER_KEY=${bridge.holder.priv.toString("hex")}`));
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

          // The control plane actually got called for real: one channel registration, then one
          // member call per side (not fabricated or skipped).
          assert.equal(received.length, 3);
          assert.equal(received[0].url, "/me/channels");
          assert.equal(received[0].body.channel, channel.toString("hex"));
          const memberCalls = received.slice(1);
          const holders = memberCalls.map((c) => c.body.holder).sort();
          assert.deepEqual(holders, [bridge.holder.pub.toString("hex"), participant.holder.pub.toString("hex")].sort());
        }
      );
    } finally {
      stub.close();
    }
  }
);

// --- Join-request status polling (join.js's post-approval GET) --------------------------------

test("handleJoinRequestStatus: delivers the pending grant once and clears it on success", () => {
  delete require.cache[require.resolve("./server.js")];
  const { handleJoinRequestStatus } = require("./server.js");
  const joinRequests = new Map();
  const pendingGrantDelivery = new Map([["p1", { channel: "chan-hex", grantB: "grant-hex", createdAt: Date.now() }]]);

  const res = fakeRes();
  handleJoinRequestStatus({}, res, joinRequests, pendingGrantDelivery, "p1");

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: "approved", channel: "chan-hex", grant: "grant-hex" });
  assert.equal(pendingGrantDelivery.has("p1"), false, "delivered successfully, so single-delivery clears it");

  const res2 = fakeRes();
  handleJoinRequestStatus({}, res2, joinRequests, pendingGrantDelivery, "p1");
  assert.deepEqual(JSON.parse(res2.body), { status: "unknown" }, "second poll finds nothing left to deliver");
});

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
    assert.equal(pendingGrantDelivery.has("p1"), false, "the retry's own successful delivery clears it");
  }
);

// --- Automation session (admin.html's real login form -> POST /api/admin/oidc-session) --------

test("currentOidcToken: falls back to the static SORT_OIDC_TOKEN when no live session exists", async () => {
  await withEnv({ SORT_OIDC_TOKEN: "static-fallback-token" }, () => {
    delete require.cache[require.resolve("./server.js")];
    const { currentOidcToken, resetOidcSessionForTests } = require("./server.js");
    resetOidcSessionForTests();
    assert.equal(currentOidcToken(), "static-fallback-token");
  });
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
      handleChannelInfo({}, res);
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
      handleChannelInfo({}, res);
      const body = JSON.parse(res.body);
      assert.equal(body.channelFrontDoor, null, "unconfigured -> null, not a broken/empty string");
      assert.equal(body.channelFrontDoorCert, null);
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
