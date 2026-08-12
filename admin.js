"use strict";
// Sort Arena waiting-room admin panel. Plain script, no build step, no framework -- matching
// index.html's own convention. Every call here hits an admin-gated bridge route; the bridge
// re-checks X-Gate-Email/SORT_ADMIN_EMAILS itself on every request regardless of what this page
// does client-side (see server.js's requireAdmin), so this file's only job is a clean UI over an
// already-enforced server-side gate, never the gate itself.

const listEl = document.getElementById("pending-list");
const emptyEl = document.getElementById("pending-empty");
const countEl = document.getElementById("pending-count");

async function api(path, opts) {
  const resp = await fetch(path, {
    method: opts && opts.body ? "POST" : "GET",
    headers: opts && opts.body ? { "content-type": "application/json" } : undefined,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await resp.json();
  } catch {
    /* no body */
  }
  if (!resp.ok) return { error: (body && body.error) || `HTTP ${resp.status}` };
  return body || {};
}

async function refresh() {
  const resp = await api("/api/join-requests");
  render(resp.error ? [] : resp.requests || []);
}

function render(requests) {
  listEl.innerHTML = "";
  emptyEl.hidden = requests.length > 0;
  countEl.textContent = String(requests.length);
  for (const req of requests) renderRow(req);
}

function renderRow(req) {
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "row";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = `${req.label || req.you} `;
  const idSpan = document.createElement("span");
  idSpan.className = "id";
  idSpan.textContent = `(${req.you})`;
  who.appendChild(idSpan);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = new Date(req.createdAt).toLocaleString();
  const left = document.createElement("div");
  left.append(who, meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "approve";
  approveBtn.textContent = "Approve";
  const declineBtn = document.createElement("button");
  declineBtn.type = "button";
  declineBtn.className = "decline";
  declineBtn.textContent = "Decline";
  actions.append(approveBtn, declineBtn);

  row.append(left, actions);
  li.appendChild(row);

  declineBtn.addEventListener("click", async () => {
    declineBtn.disabled = true;
    approveBtn.disabled = true;
    await api(`/api/join-requests/${encodeURIComponent(req.you)}/decline`, { body: {} });
    refresh();
  });

  approveBtn.addEventListener("click", async () => {
    approveBtn.disabled = true;
    declineBtn.disabled = true;
    const resp = await api(`/api/join-requests/${encodeURIComponent(req.you)}/approve`, { body: {} });
    if (resp.error) {
      approveBtn.disabled = false;
      declineBtn.disabled = false;
      showNote(li, `couldn't approve: ${resp.error}`, "error");
      return;
    }
    renderManualSteps(li, resp);
  });
}

function renderManualSteps(li, resp) {
  // Row survives approval (it's already removed from the pending queue server-side) so the
  // operator can run the printed commands and finish here, rather than the row just vanishing
  // and leaving them with nothing to act on.
  li.querySelector(".actions").remove();
  const steps = document.createElement("div");
  steps.className = "steps";
  const heading = document.createElement("div");
  heading.textContent = `Run these once, then paste the resulting cmd for "${resp.you}" below:`;
  steps.appendChild(heading);
  for (const step of resp.manualSteps || []) {
    const pre = document.createElement("pre");
    pre.textContent = step;
    steps.appendChild(pre);
  }

  const finish = document.createElement("div");
  finish.className = "finish";
  const cmdInput = document.createElement("input");
  cmdInput.placeholder = "cmd, e.g. CT_CHANNEL_ROLE=initiate ... ct-agent channel";
  const goLiveBtn = document.createElement("button");
  goLiveBtn.type = "button";
  goLiveBtn.className = "approve";
  goLiveBtn.textContent = "Go live";
  finish.append(cmdInput, goLiveBtn);
  steps.appendChild(finish);

  const note = document.createElement("div");
  note.className = "note";
  note.id = "note";
  steps.appendChild(note);

  goLiveBtn.addEventListener("click", async () => {
    if (!cmdInput.value.trim()) {
      showNote(li, "cmd is required", "error");
      return;
    }
    goLiveBtn.disabled = true;
    const result = await api("/api/participants/approved", {
      body: { you: resp.you, label: resp.label, cmd: cmdInput.value.trim() },
    });
    if (result.error) {
      goLiveBtn.disabled = false;
      showNote(li, `couldn't go live: ${result.error}`, "error");
      return;
    }
    showNote(li, `"${resp.you}" is live.`, "ok");
    goLiveBtn.remove();
    cmdInput.disabled = true;
  });

  li.appendChild(steps);
}

function showNote(li, text, kind) {
  let note = li.querySelector(".note");
  if (!note) {
    note = document.createElement("div");
    note.className = "note";
    li.appendChild(note);
  }
  note.textContent = text;
  note.dataset.kind = kind;
}

refresh();
