"use strict";
// Sort Arena waiting-room admin panel. Plain script, no build step, no framework -- matching
// index.html's own convention. Every call here hits an admin-gated bridge route; the bridge
// re-checks X-Gate-Email/SORT_ADMIN_EMAILS itself on every request regardless of what this page
// does client-side (see server.js's requireAdmin), so this file's only job is a clean UI over an
// already-enforced server-side gate, never the gate itself.

const listEl = document.getElementById("pending-list");
const emptyEl = document.getElementById("pending-empty");
const countEl = document.getElementById("pending-count");
const liveListEl = document.getElementById("live-list");
const liveEmptyEl = document.getElementById("live-empty");
const liveCountEl = document.getElementById("live-count");

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

// Approving a request removes it from the server's pending list immediately and, since approval
// is now fully automated (mints both grants, registers the channel + both members for real --
// see handleJoinRequestApprove/automateApproval), the participant is live by the time the API
// call returns. The row still stays visible for a moment as a completed confirmation rather than
// just vanishing. Polling refresh() naively -- clearing and rebuilding the whole list every tick
// -- would wipe that confirmation out from under the operator before they'd seen it. Instead:
// in-flight rows are created ONCE and never touched again by refresh(); only the still-pending
// section is torn down and rebuilt each poll.
const inFlightYous = new Set(); // "you" ids currently rendered as an in-flight approval row

async function refresh() {
  const resp = await api("/api/join-requests");
  const pending = resp.error ? [] : resp.requests || [];
  renderPending(pending);

  const liveResp = await api("/api/participants/approved");
  renderLive(liveResp.error ? [] : liveResp.participants || []);

  await refreshSessionStatus();
}

// --- Automation session: a real login form (see admin.html), not a workaround of anything --
// the operator types their password into a real <input type=password> in their own browser; the
// resulting tokens (never the password) are POSTed to the bridge, which self-refreshes them for
// up to 30 minutes using only the refresh token. See docs/operations.md and server.js's
// handleOidcSessionSubmit for the full design and why this is the legitimate way to do this.
const sessionStatusEl = document.getElementById("session-status");
const sessionStatusTextEl = document.getElementById("session-status-text");
const sessionForm = document.getElementById("session-form");
const sessionEmailInput = document.getElementById("session-email");
const sessionPasswordInput = document.getElementById("session-password");

// Below this remaining-time threshold, flip the dot amber -- the session is still genuinely
// active (Approve will still work), but about to lapse, so the operator sees it coming instead
// of only finding out when an Approve click 502s mid-click.
const SESSION_WARN_MS = 3 * 60 * 1000;

async function refreshSessionStatus() {
  const resp = await api("/api/admin/oidc-session");
  if (resp.error) {
    sessionStatusEl.dataset.active = "false";
    sessionStatusTextEl.textContent = `couldn't check: ${resp.error}`;
    return;
  }
  if (!resp.active) {
    sessionStatusEl.dataset.active = "false";
    sessionStatusTextEl.textContent = "no active session -- Approve will fail closed";
    return;
  }
  const remainingMs = new Date(resp.activeUntil).getTime() - Date.now();
  sessionStatusEl.dataset.active = remainingMs <= SESSION_WARN_MS ? "soon" : "true";
  const remainingMin = Math.max(0, Math.round(remainingMs / 60000));
  sessionStatusTextEl.textContent =
    remainingMs <= SESSION_WARN_MS
      ? `active, but ends in ~${remainingMin} min -- log in again soon to keep it going`
      : `active until ${new Date(resp.activeUntil).toLocaleTimeString()}`;
}

sessionForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const submitBtn = sessionForm.querySelector("button");
  submitBtn.disabled = true;
  sessionStatusTextEl.textContent = "starting…";
  try {
    const info = await api("/api/channel-info");
    if (!info.oidcIssuerBase) {
      sessionStatusTextEl.textContent = "this deployment hasn't set SORT_OIDC_ISSUER_BASE -- see docs/operations.md";
      return;
    }
    // This fetch call is the ONLY place the password is used -- it goes straight from this
    // browser tab to Keycloak's own token endpoint, never through this bridge, never logged.
    // Standard OAuth Resource Owner Password Credentials grant, same request shape
    // mint-oidc-token.sh makes from a terminal -- just typed into a real form instead.
    const tokenResp = await fetch(`${info.oidcIssuerBase.replace(/\/$/, "")}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: info.oidcClientId,
        username: sessionEmailInput.value,
        password: sessionPasswordInput.value,
      }),
    });
    sessionPasswordInput.value = ""; // clear immediately, whether this succeeded or not
    const tokenBody = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok) {
      sessionStatusTextEl.textContent = `login failed: ${tokenBody.error_description || tokenBody.error || `HTTP ${tokenResp.status}`}`;
      return;
    }
    const result = await api("/api/admin/oidc-session", {
      body: {
        accessToken: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token,
        expiresIn: tokenBody.expires_in,
        refreshExpiresIn: tokenBody.refresh_expires_in,
      },
    });
    if (result.error) {
      sessionStatusTextEl.textContent = `session start failed: ${result.error}`;
      return;
    }
    await refreshSessionStatus();
  } catch (e) {
    sessionPasswordInput.value = "";
    sessionStatusTextEl.textContent = `error: ${e.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

function renderLive(entries) {
  liveListEl.innerHTML = "";
  liveEmptyEl.hidden = entries.length > 0;
  liveCountEl.textContent = String(entries.length);
  for (const entry of entries) liveListEl.appendChild(renderLiveRow(entry));
}

function renderLiveRow(entry) {
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "row";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = `${entry.label || entry.you} `;
  const idSpan = document.createElement("span");
  idSpan.className = "id";
  idSpan.textContent = `(${entry.you})`;
  who.appendChild(idSpan);

  const revokeBtn = document.createElement("button");
  revokeBtn.type = "button";
  revokeBtn.className = "revoke";
  revokeBtn.textContent = "Revoke";
  revokeBtn.addEventListener("click", async () => {
    if (!confirm(`Revoke "${entry.you}"? They can submit a new join request afterward.`)) return;
    revokeBtn.disabled = true;
    const result = await api(`/api/participants/approved/${encodeURIComponent(entry.you)}/revoke`, { body: {} });
    if (result.error) {
      revokeBtn.disabled = false;
      showNote(li, `couldn't revoke: ${result.error}`, "error");
      return;
    }
    li.remove();
    updateLiveCount();
  });

  row.append(who, revokeBtn);
  li.appendChild(row);
  return li;
}

function updateLiveCount() {
  const count = liveListEl.querySelectorAll("li").length;
  liveEmptyEl.hidden = count > 0;
  liveCountEl.textContent = String(count);
}

function renderPending(requests) {
  // Only ever remove/rebuild rows tagged .pending-row -- .in-flight-row rows are left alone.
  listEl.querySelectorAll("li.pending-row").forEach((li) => li.remove());
  const total = requests.length + inFlightYous.size;
  emptyEl.hidden = total > 0;
  countEl.textContent = String(total);
  const inFlightAnchor = listEl.firstChild; // pending rows go before whatever in-flight rows exist
  for (const req of requests) listEl.insertBefore(renderRow(req), inFlightAnchor);
}

function updateCount() {
  const pendingCount = listEl.querySelectorAll("li.pending-row").length;
  const total = pendingCount + inFlightYous.size;
  emptyEl.hidden = total > 0;
  countEl.textContent = String(total);
}

// Auto-refresh so a new request shows up without the operator having to reload -- same fixed-
// interval polling shape as CADS-webconference-demo's own admin-facing lists (its incoming-call
// poll). 5s: fast enough to feel live for a low-traffic admin panel, not aggressive enough to
// matter at this scale.
const POLL_INTERVAL_MS = 5000;
setInterval(refresh, POLL_INTERVAL_MS);

function renderRow(req) {
  const li = document.createElement("li");
  li.className = "pending-row";

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
    // Reclassify in place: this exact <li> (already in the DOM) stops being torn down by future
    // renderPending() calls, which only ever touch .pending-row. It's already gone from the
    // server's own pending list at this point, so a poll would otherwise have nothing left to
    // reconstruct it from anyway -- this is the only copy of this row that will ever exist.
    li.className = "in-flight-row";
    inFlightYous.add(resp.you);
    renderApproved(li, resp);
    updateCount();
  });

  return li;
}

function renderApproved(li, resp) {
  // Approval is fully automated -- by the time the API call above returns, the participant is
  // already live (their grant delivered via GET /api/join-requests/:you/status, which their own
  // join.js polls). Nothing left for the operator to do here but confirm it happened; this row
  // also naturally disappears from the panel on the next full page load, since it's already off
  // the server's pending list and renderLive() will pick it up from /api/participants/approved.
  li.querySelector(".actions").remove();
  showNote(li, `"${resp.you}" approved and live (channel ${resp.channel}).`, "ok");
  // Done -- no longer counts as work still in flight; the row stays visible as a completed
  // confirmation rather than vanishing, since renderPending() never touches .in-flight-row rows.
  inFlightYous.delete(resp.you);
  updateCount();
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
