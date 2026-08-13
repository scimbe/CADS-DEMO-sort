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

function renderIdentity(identity) {
  identityBox.innerHTML = "";
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
    const resp = await fetch("/api/channel-info");
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
  if (!currentIdentity || !channelInfo) return;
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
    const resp = await fetch("/api/join-requests", {
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
    showNote("Request submitted. Waiting for an operator to review it…", "ok");
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
      ? `CT_CHANNEL_FRONT_DOOR=${channelInfo.channelFrontDoor} \\\n` +
        `CT_CHANNEL_FRONT_DOOR_CERT=${channelInfo.channelFrontDoorCert} \\\n` +
        `CT_CHANNEL_FRONT_DOOR_ONLY=1 \\\n`
      : "";
  // #330 relay gate: the :443-multiplexed gated relay a NAT-only participant needs IN ADDITION
  // to broker/relay -- deliberately a separate protocol from CT_CHANNEL_RELAY, and omitting it
  // fails silently for exactly the networks that need it most (measured on this deployment:
  // 0 sessions in 90s without it vs 3 stable sessions with it, same v0.4.8 + grant). Included
  // whenever the deployment publishes it, same "absent -> omitted" treatment as the front door.
  const relayGateLine =
    channelInfo.channelRelayGate && channelInfo.channelRelayGateCert
      ? `CT_CHANNEL_RELAY_GATE=${channelInfo.channelRelayGate} \\\n` +
        `CT_CHANNEL_RELAY_GATE_CERT=${channelInfo.channelRelayGateCert} \\\n`
      : "";
  pre.textContent =
    `CT_CHANNEL_ROLE=accept CT_CHANNEL_SERVE=1 CT_CHANNEL_RELAY_ONLY=1 \\\n` +
    `CT_CHANNEL_BROKER=${channelInfo.channelBroker || "<ask the operator>"} ` +
    `CT_CHANNEL_RELAY=${channelInfo.channelRelay || "<ask the operator>"} \\\n` +
    frontDoorLine +
    relayGateLine +
    `CT_CHANNEL_GRANT=${grant} \\\n` +
    `CT_CHANNEL_HOLDER_KEY=${currentIdentity.holderPriv} \\\n` +
    `CT_CHANNEL_NOISE_KEY=${currentIdentity.noisePriv} \\\n` +
    `CT_AGENT_SERVICE_HANDLER_CMD=./handler.sh \\\n` +
    `CT_AGENT_SERVICES=text_generation \\\n` +
    `  ct-agent channel`;
  identityBox.appendChild(pre);
}

boot();
