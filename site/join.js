"use strict";
// Sort Arena waiting-room public join form. Generates a real Agent-Fabric channel identity
// (holder + noise keypair) and signs the join-request attestation entirely client-side via
// ct-agent-wasm (`pkg/ct_agent_wasm.js`, wasm-bindgen output of ct-agent's own wasm/ crate --
// the same "ct-agent for the browser" module CADS-webconference-demo already ships) -- no CLI
// install, no copy-pasted commands. The holder/noise PRIVATE keys never leave this browser: they
// stay in localStorage and are shown once for the participant to save, since those are what
// their own `ct-agent channel --serve` process (running on their own machine, per
// docs/onboarding.md Step 4 -- unchanged) needs to actually answer rounds later.

import init, * as wasm from "./pkg/ct_agent_wasm.js";

const STORAGE_KEY = "sort-arena-identity";
const identityBox = document.getElementById("identity-box");
const form = document.getElementById("join-form");
const noteEl = document.getElementById("note");
const submitBtn = form.querySelector("button[type=submit]");

let wasmInitPromise = null;
function ensureWasmInit() {
  return wasmInitPromise || (wasmInitPromise = init({ module_or_path: "./pkg/ct_agent_wasm_bg.wasm" }));
}

// CADS-Tunnel#589: the edge's TCP-fallback connection pool (browser-plane, UDP blocked from
// here) has a hard 1.5s window to hand a request a parked agent connection; each parked
// connection serves exactly one request before the agent has to re-park, so real traffic races
// that window and intermittently fails the CONNECTION ITSELF -- the bridge never sees the
// request at all in that case, so retrying is always safe here, the join POST included, not
// just the GETs. `fetch()` throwing (a TypeError, not an HTTP error response) is exactly this
// failure mode; a real 4xx/5xx from the bridge is a genuine answer and is never retried.
async function fetchResilient(url, opts, retries = 2, backoffMs = 500) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
}

function loadOrCreateIdentity() {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return JSON.parse(existing);
  const holder = wasm.generate_holder_identity();
  const noise = wasm.generate_noise_identity();
  const identity = {
    holderPub: holder.public_hex,
    holderPriv: holder.private_hex,
    noisePub: noise.public_hex,
    noisePriv: noise.private_hex,
    createdAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

// member_noise_attest_bytes (CADS-Tunnel crates/common/src/{channel.rs,preimage.rs}) --
// u32-LE(domain.len()) || domain || channel(32) || holder(32) || noise_pubkey(32). Same byte
// layout bridge/attestation.js verifies server-side; kept independent here (client-side JS has
// no access to that Node module) but must stay byte-identical -- see bridge/attestation.test.js
// for the vectors this was checked against.
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytes: not a valid even-length hex string (got ${JSON.stringify(hex)})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function memberNoiseAttestBytes(channelHex, holderHex, noisePubHex) {
  const domain = new TextEncoder().encode("ct-a2a-noise-attest-v1");
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, domain.length, true);
  return concatBytes(lenPrefix, domain, hexToBytes(channelHex), hexToBytes(holderHex), hexToBytes(noisePubHex));
}

// Tester-reported gap (CADS-DEMO-sort-docs feedback): the .identity-priv blocks are exactly the
// multi-line export text a participant needs to paste into their own shell, and the surrounding
// comments in this file already document real users losing a token to manual selection (a `\`-
// continuation, or an incomplete drag-select of a wrapped block). navigator.clipboard.writeText
// copies the FULL element.textContent in one action, which a manual select can't guarantee.
function addCopyButton(preEl) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = "Copy";
  let resetTimer = null;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(preEl.textContent);
      btn.textContent = "Copied";
      btn.dataset.copied = "1";
    } catch (e) {
      // Clipboard API needs a secure context (https, or localhost) -- both this page's
      // documented deployment (Caddy/https) and the local-testing path (127.0.0.1) qualify, but
      // fail loud rather than silently doing nothing if some other origin ever serves this.
      btn.textContent = "Copy failed — select manually";
    }
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      btn.textContent = "Copy";
      delete btn.dataset.copied;
    }, 2000);
  });
  preEl.insertAdjacentElement("afterend", btn);
  return btn;
}

function renderIdentity(identity) {
  identityBox.innerHTML = "";

  // CADS-DEMO-sort#30 item 6a: say what this key material IS, in plain language, right next to
  // it -- not in a linked how-to. A newcomer otherwise sees two keypairs and private keys with
  // no way to know why an identity is needed at all.
  const why = document.createElement("p");
  why.className = "version-req";
  why.textContent =
    "Why keys? Your sorter runs on YOUR machine; the arena only ever dials it over an " +
    "end-to-end-encrypted channel. Two keypairs make that work: the holder key is your identity " +
    "(it signs this join request, and later proves to the network that the machine answering is " +
    "really yours), and the noise key encrypts your rounds in transit. The private halves are " +
    "generated in this browser and never leave it -- whoever holds them IS you, which is exactly " +
    "why this page only ever submits the public halves plus a signature.";
  identityBox.appendChild(why);

  const pub = document.createElement("div");
  pub.className = "identity-pub";
  pub.innerHTML = `<strong>Your holder public key</strong><code>${identity.holderPub}</code>`;
  identityBox.appendChild(pub);

  const warn = document.createElement("div");
  warn.className = "identity-warn";
  warn.textContent =
    "Save your PRIVATE keys below now -- you'll need them for your own ct-agent channel --serve " +
    "process once you're admitted (docs/onboarding.md Step 4). They never leave this browser and " +
    "are never submitted anywhere; this page only ever sends your PUBLIC keys + a signature.";
  identityBox.appendChild(warn);

  const priv = document.createElement("pre");
  priv.className = "identity-priv";
  priv.textContent =
    `CT_CHANNEL_HOLDER_KEY=${identity.holderPriv}\n` +
    `CT_CHANNEL_NOISE_KEY=${identity.noisePriv}\n` +
    `CT_CHANNEL_NOISE_PUBKEY=${identity.noisePub}`;
  identityBox.appendChild(priv);
  addCopyButton(priv);

  const regenBtn = document.createElement("button");
  regenBtn.type = "button";
  regenBtn.className = "identity-regen";
  regenBtn.textContent = "Generate a different identity";
  regenBtn.addEventListener("click", () => {
    if (!confirm("This replaces the identity stored in this browser. Only do this before you've been admitted.")) return;
    localStorage.removeItem(STORAGE_KEY);
    boot();
  });
  identityBox.appendChild(regenBtn);
}

function showNote(text, kind) {
  noteEl.textContent = text;
  noteEl.dataset.kind = kind;
}

let currentIdentity = null;
let channelInfo = null;

async function boot() {
  identityBox.textContent = "generating your channel identity…";
  await ensureWasmInit();
  currentIdentity = loadOrCreateIdentity();
  renderIdentity(currentIdentity);

  try {
    const resp = await fetchResilient("/api/channel-info");
    channelInfo = await resp.json();
    if (!channelInfo.operatorPubkey || !channelInfo.bridgeHolderPubkey) {
      showNote("This deployment hasn't configured its channel identity yet -- ask the operator.", "error");
      submitBtn.disabled = true;
    }
  } catch (e) {
    showNote(`Couldn't reach this deployment's /api/channel-info: ${e.message}`, "error");
    submitBtn.disabled = true;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  // Never fail silently (CADS-DEMO-sort#30: "the user sees a form that does nothing"): if the
  // page booted without channel-info (transient outage at load time), say so and offer the fix.
  if (!currentIdentity || !channelInfo) {
    showNote(
      "This page couldn't load the deployment's channel info when it opened (temporary outage?). " +
        "Reload the page and try again.",
      "error"
    );
    return;
  }
  submitBtn.disabled = true;
  showNote("", "");

  try {
    const channelHex = wasm.channel_id_for_link(channelInfo.operatorPubkey, channelInfo.bridgeHolderPubkey, currentIdentity.holderPub);
    const preimage = memberNoiseAttestBytes(channelHex, currentIdentity.holderPub, currentIdentity.noisePub);
    const signature = wasm.holderSign(currentIdentity.holderPriv, preimage);

    const body = {
      you: form.you.value.trim(),
      label: form.label.value.trim() || undefined,
      holderPub: currentIdentity.holderPub,
      noisePub: currentIdentity.noisePub,
      attestation: bytesToHex(signature),
    };
    const resp = await fetchResilient("/api/join-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showNote(result.error || `request failed (HTTP ${resp.status})`, "error");
      submitBtn.disabled = false;
      return;
    }
    // Auto-approval (2026-08-13): a Keycloak-authenticated submit is approved on the spot --
    // the response says so, and the status poll below then returns the grant on its first
    // request instead of after a human review. The waiting-room copy only shows on
    // deployments still running the manual-review flow.
    //
    // CADS-DEMO-sort#56: channelInfo.autoApproveAvailable (fetched at boot, see boot() above)
    // reflects the bridge's automationConfigured() -- and handleJoinRequestApprove ALSO requires
    // that same automationConfigured() (server.js), so when it's false, an operator's approve
    // click fails closed too. There is no separate lower-tech manual path this deployment can fall
    // back to: false means genuinely nobody can approve anyone right now. Previously this field
    // was fetched and silently dropped, so a request queued during exactly that window still saw
    // "Waiting for an operator to review it…" -- implying a review that could not happen.
    if (!result.approved && channelInfo && channelInfo.autoApproveAvailable === false) {
      showNote(
        "Submitted, but this deployment can't approve join requests right now (automation is " +
          "unavailable) -- an operator can't review it either until that's restored. Your request " +
          "stays queued and will be picked up automatically once it is; you don't need to do " +
          "anything, but it may be a while. Keep this tab open to see it resolve.",
        "error"
      );
    } else {
      showNote(
        result.approved
          ? "Approved automatically (your login is your legitimization) — fetching your grant…"
          : "Request submitted. Waiting for an operator to review it…",
        "ok"
      );
    }
    pollStatus(body.you);
  } catch (e) {
    showNote(`request failed: ${e.message}`, "error");
    submitBtn.disabled = false;
  }
});

// Approval is fully automated (see server.js's automateApproval) -- once an operator clicks
// Approve, the bridge mints this participant's own grant and stashes it in pendingGrantDelivery
// for exactly one delivery. Poll GET /api/join-requests/:you/status until it shows up (public by
// design: a grant is only usable by whoever already holds the matching CT_CHANNEL_HOLDER_KEY/
// CT_CHANNEL_NOISE_KEY, both of which never left this browser -- see handleJoinRequestStatus).
const STATUS_POLL_MS = 4000;
let statusPollTimer = null;
function pollStatus(you) {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(async () => {
    let result;
    try {
      const resp = await fetch(`/api/join-requests/${encodeURIComponent(you)}/status`);
      result = await resp.json();
    } catch {
      return; // transient network hiccup -- just try again next tick
    }
    if (result.status === "approved") {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
      renderApproved(result.channel, result.grant);
    } else if (result.status === "unknown") {
      // Not pending and no grant waiting -- either declined, or already delivered in an earlier
      // tab/session (delivery is one-shot). Stop polling either way; nothing left to wait for.
      clearInterval(statusPollTimer);
      statusPollTimer = null;
      showNote(
        "No pending request or grant found for this identity — it may have been declined, or " +
          "already delivered in another tab. Submit a new request if you need to.",
        "error",
      );
      submitBtn.disabled = false;
    }
    // "pending": keep polling silently.
  }, STATUS_POLL_MS);
}

function renderApproved(channel, grant) {
  showNote(`Approved! Channel ${channel}. Run this on your own machine to go live:`, "ok");
  const pre = document.createElement("pre");
  pre.className = "identity-priv";
  // Fully filled in, including broker/relay from /api/channel-info (see handleChannelInfo's own
  // comment -- not secret, every accepted participant needs them regardless) -- copy-paste ready,
  // no cross-referencing docs/onboarding.md for two host:port strings. CT_AGENT_SERVICE_HANDLER_CMD
  // is the one placeholder left: point it at your own verified handler.sh (docs/onboarding.md
  // Step 4 covers the full CT_AGENT_SERVICES=text_generation / role-tag distinction).
  // #106 :443 fallback (for participants whose network blocks the direct broker/relay ports --
  // a real support case: ICMP + :4433 passed, :4435/:4436 didn't) -- included only when this
  // deployment has actually configured it (channelFrontDoor/channelFrontDoorCert both present),
  // same "absent -> omitted" treatment as everywhere else in this flow.
  // CT_CHANNEL_FRONT_DOOR_ONLY=1 (ct-agent v0.4.8+): the edge's :443 front-door pairer and its
  // QUIC/relay pairer (:4436) are separate instances -- two members only pair if they park in
  // the SAME one. The bridge's own half always lands on :443 (its host's UDP is permanently
  // blocked), so without this flag a participant whose own UDP happens to work would park in
  // the QUIC pairer instead, find no partner, and get reaped after 30s (looks like "edge broker
  // refused the channel join" ~32-41s in, not an obvious timeout). Forcing it here keeps this
  // side deterministic until the edge ships transport-unified pairing.
  const frontDoorLine =
    channelInfo.channelFrontDoor && channelInfo.channelFrontDoorCert
      ? `export CT_CHANNEL_FRONT_DOOR=${channelInfo.channelFrontDoor}\n` +
        `export CT_CHANNEL_FRONT_DOOR_CERT=${channelInfo.channelFrontDoorCert}\n` +
        `export CT_CHANNEL_FRONT_DOOR_ONLY=1\n`
      : "";
  // Deliberately NO CT_CHANNEL_RELAY_GATE in this command (retest 4 finding): ct-agent's gate
  // mode still runs its channel-join ADMISSION over QUIC :4436 (the :443 gate only carries the
  // post-admission circuit), which parks the participant in the edge's QUIC pairer -- while
  // the arena bridge, front-door-only, parks in the :443 pairer. The two pairers are disjoint
  // (CADS-Tunnel#495), so a gate-mode participant can NEVER pair with this bridge, however
  // healthy both sides look. Until #495 unifies them, both halves must be front-door-only --
  // exactly what this command (frontDoorLine + FRONT_DOOR_ONLY) produces. The relay-gate
  // values remain published in /api/channel-info for non-arena uses.
  // Export-per-line, NO backslash continuations (CADS-DEMO-sort#30): two independent users in
  // two days lost exactly the token adjacent to a `\`-continuation when copying multi-line
  // blocks through real terminals/wrapping (a cert byte on 08-14; RELAY + RELAY_ONLY on 08-15,
  // which cost two failed serve attempts on the taught path). One export per line has no
  // continuation to mangle, survives partial paste with a clear error naming the missing var,
  // and makes variable-wise diffing against other surfaces trivial.
  pre.textContent =
    `export CT_CHANNEL_ROLE=accept\n` +
    `export CT_CHANNEL_SERVE=1\n` +
    `export CT_CHANNEL_RELAY_ONLY=1\n` +
    `export CT_CHANNEL_BROKER=${channelInfo.channelBroker || "<ask the operator>"}\n` +
    `export CT_CHANNEL_RELAY=${channelInfo.channelRelay || "<ask the operator>"}\n` +
    frontDoorLine +
    `export CT_CHANNEL_GRANT=${grant}\n` +
    `export CT_CHANNEL_HOLDER_KEY=${currentIdentity.holderPriv}\n` +
    `export CT_CHANNEL_NOISE_KEY=${currentIdentity.noisePriv}\n` +
    `export CT_AGENT_SERVICE_HANDLER_CMD=./handler.sh\n` +
    `export CT_AGENT_SERVICES=text_generation\n` +
    // `./ct-agent`, not bare `ct-agent` (tester-reported, CADS-DEMO-sort-docs feedback): every
    // download path this project documents puts the binary in the participant's own directory,
    // never on PATH -- same reasoning as CT_AGENT_SERVICE_HANDLER_CMD=./handler.sh two lines up.
    // A bare `ct-agent` here fails "command not found" for anyone who followed the docs exactly.
    `./ct-agent channel`;
  identityBox.appendChild(pre);
  addCopyButton(pre);

  // CADS-DEMO-sort#27: name the ct-agent minimum version right where the serve command is, not
  // only in the docs how-tos. An older binary hits the CADS-Tunnel#494 ack-deadlock -- 45-100s
  // stall on the first pairing after every start -- which looks like a broken setup and gets
  // reported as a bug. This is the surface every participant actually uses, so the requirement
  // belongs here. Links open in a new tab; the grant/keys above live in the page body, never in a
  // URL, so rel=noopener leaks nothing.
  const versionReq = document.createElement("p");
  versionReq.className = "version-req";
  versionReq.innerHTML =
    'Requires <strong>ct-agent v0.4.16 or newer</strong>; <strong>v0.5.0 recommended</strong> — the first ' +
    'release with binaries for all 8 platforms ' +
    '(<a href="https://github.com/scimbe/ct-agent/releases" target="_blank" rel="noopener">releases</a>). ' +
    'Versions before v0.4.16 stall 45–100 s on their first pairing after every start ' +
    '(<a href="https://github.com/scimbe/CADS-Tunnel/issues/494" target="_blank" rel="noopener">CADS-Tunnel#494</a>) ' +
    '— that looks like a broken setup but isn’t.';
  identityBox.appendChild(versionReq);
}

boot();
