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
    showNote("Request submitted. An operator will review it — check back or wait to hear from them.", "ok");
    submitBtn.disabled = false;
  } catch (e) {
    showNote(`request failed: ${e.message}`, "error");
    submitBtn.disabled = false;
  }
});

boot();
