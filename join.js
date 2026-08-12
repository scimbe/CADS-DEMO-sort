"use strict";
// Sort Arena waiting-room public join form. Plain script, no build step, matching this repo's
// existing index.html/admin.html convention.

const cmdEl = document.getElementById("member-material-cmd");
const form = document.getElementById("join-form");
const noteEl = document.getElementById("note");

async function loadChannelInfo() {
  try {
    const resp = await fetch("/api/channel-info");
    const info = await resp.json();
    if (!info.operatorPubkey || !info.bridgeHolderPubkey) {
      cmdEl.textContent = "this deployment hasn't configured its channel identity yet -- ask the operator";
      return;
    }
    cmdEl.textContent =
      `CT_CHANNEL_OPERATOR_PUBKEY=${info.operatorPubkey} \\\n` +
      `CT_CHANNEL_BRIDGE_HOLDER=${info.bridgeHolderPubkey} \\\n` +
      `CT_CHANNEL_HOLDER_KEY=<your holder PRIVATE key, from step 1> \\\n` +
      `CT_CHANNEL_NOISE_PUBKEY=<your noise PUBLIC key, from step 1> \\\n` +
      `ct-agent channel member-material`;
  } catch (e) {
    cmdEl.textContent = `couldn't reach this deployment's /api/channel-info: ${e.message}`;
  }
}

function showNote(text, kind) {
  noteEl.textContent = text;
  noteEl.dataset.kind = kind;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const submitBtn = form.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  showNote("", "");
  const body = {
    you: form.you.value.trim(),
    label: form.label.value.trim() || undefined,
    holderPub: form.holderPub.value.trim().toLowerCase(),
    noisePub: form.noisePub.value.trim().toLowerCase(),
    attestation: form.attestation.value.trim().toLowerCase(),
  };
  try {
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
    form.reset();
    submitBtn.disabled = false;
  } catch (e) {
    showNote(`request failed: ${e.message}`, "error");
    submitBtn.disabled = false;
  }
});

loadChannelInfo();
