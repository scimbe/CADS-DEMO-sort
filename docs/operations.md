# Operating a Sort Arena deployment (operator-only)

This is for whoever runs `sort-demo-bridge`/`sort-demo-origin` — not participants. If you're
trying to join the arena, see [`docs/onboarding.md`](onboarding.md) or the
[Join as a participant](https://scimbe.github.io/CADS-DEMO-sort-docs/how-to/join-as-a-participant/)
how-to instead.

## Control-plane authentication: three tiers

`admin.html`'s Approve button mints both channel grants and registers the channel + both members
with the control plane automatically (`bridge/server.js`'s `automateApproval`) — and every one of
those control-plane calls needs a bearer token. The bridge has **three** ways to obtain one, tried
in a fixed precedence order on every call (`cpFetch` → `ensureServiceOidcToken()` +
`currentOidcToken()` in `bridge/server.js`):

1. **Service-account token** (`client_credentials`) — if a valid cached one exists (or can be
   minted), it wins.
2. **Browser session** started via `admin.html` — used if no service token is available and the
   session's access token hasn't expired.
3. **Static `SORT_OIDC_TOKEN`** — the last-resort fallback when neither of the above is live.

Before each control-plane call, `cpFetch` first tries to warm the service-token cache
(a no-op when no client secret is configured; a mint failure logs to stderr and falls through),
then picks a token by the precedence above. Configure tier 1 and you can ignore the other two.

### Tier 1 — service account (`client_credentials`): preferred, durable

This is the fix for the recurring "approvals silently break after every bridge redeploy" incident
(CADS-DEMO-sort#9, #24). Configure a confidential Keycloak client and the bridge re-mints its own
access token on demand — **it survives redeploys with no human re-arm**, and no refresh token is
involved.

Environment:

| Variable | Meaning |
|---|---|
| `SORT_OIDC_CLIENT_ID` | Client id for the `client_credentials` grant. Defaults to `sort-bridge-automation`. |
| `SORT_OIDC_CLIENT_SECRET_FILE` | Path to the client secret, mounted as a Docker secret. Read via the standard `_FILE` convention (`readSecret()`); a plain `SORT_OIDC_CLIENT_SECRET` env var also works but keeps the secret in `docker inspect` output — prefer the `_FILE` form. |
| `SORT_OIDC_ISSUER_BASE` | Keycloak realm base URL (e.g. `https://auth.bunsenbrenner.org/realms/ct-demo`). Required — without it this tier is silently skipped. |

Behavior (`ensureServiceOidcToken()`):

- Tokens are minted from `<issuer>/protocol/openid-connect/token` with
  `grant_type=client_credentials` and cached in memory.
- The cache is reused until **30 seconds before** the token's real expiry (safety margin so an
  in-flight control-plane call never races expiry), then re-minted on the next call.
- A failed mint throws inside `ensureServiceOidcToken()`; `cpFetch` catches it, logs
  `service token mint failed, falling back`, and drops to tiers 2/3 — the failure is visible in
  the bridge's stderr, not hidden.

Note that `automationConfigured()` treats a configured client secret + issuer base as a valid
token source **even before the first mint has happened** — so automation reports as armed
immediately after a redeploy, instead of the false "not configured" that used to make a fresh
deploy look broken.

### Tier 2 — `admin.html` browser session: interim/manual

If no service account is wired up, an operator can arm automation by logging in at `admin.html`.
The login form runs the password grant **in the operator's own browser**; only the resulting
access + refresh tokens are then POSTed to `/api/admin/oidc-session`
(`handleOidcSessionSubmit`) — the password itself never reaches the bridge process.

Once started, the bridge self-refreshes the access token on a timer using only the refresh token,
until the refresh token's own lifetime runs out (realm-dependent; typically **~30 minutes**), then
fails closed and automation goes back to unarmed. A failed refresh also ends the session
immediately — no fake success.

> **Important:** this session lives **in memory only** and is **wiped on every bridge
> redeploy/restart** — deliberately, like any other web session. This is exactly why the
> service-account tier exists and is preferred: with only a browser session armed, every redeploy
> silently disarms approvals until a human logs in again (the #9/#24 incident pattern).

Requires `SORT_OIDC_ISSUER_BASE` to be set (the endpoint answers 503 otherwise). The refresh
calls use `SORT_OIDC_CLIENT_ID` too, defaulting to `admin-cli` in this path — if you override
`SORT_OIDC_CLIENT_ID` for the service-account tier, the refresh token must have been minted for
that same client id or the session's auto-refresh will fail.

### Tier 3 — static `SORT_OIDC_TOKEN`: last resort

A single hand-pasted access token, read via `readSecret()` (so `SORT_OIDC_TOKEN_FILE` works too).
It expires on the realm's normal access-token lifetime — **typically minutes, not hours** — and
nothing refreshes it. Documented for completeness; use tier 1 instead whenever you can. If you do
need it (e.g. before a service-account client exists for the realm):

**Mint the token yourself, in your own terminal. Never paste your password into a chat with an AI
agent, and never let one run a script with your password as an argument or env var** — that
pattern is (correctly) blocked by responsible-AI tooling, and for good reason: a scripted
credential exchange is exactly what you don't want an agent doing on your behalf,
browser-automated or otherwise.

```bash
export OIDC_PASSWORD='<your real password>'   # your terminal, not anyone else's
OIDC_ISSUER_BASE=https://auth.bunsenbrenner.org/realms/ct-demo \
OIDC_USERNAME=<your account email> \
scripts/channel-ops/mint-oidc-token.sh   # from a CADS-Tunnel checkout; see that repo
```

This prints one bare access-token line (nothing else), valid for a few minutes from the moment
it's minted — check the token's own `exp` claim if you need the exact number for your realm.

To get it to the bridge: if the container was started with `SORT_OIDC_TOKEN_FILE` pointing at a
real path, refreshing that file's contents takes effect on the next request — no restart needed:

```bash
# write the freshly minted token to whatever path SORT_OIDC_TOKEN_FILE points at
echo -n "$TOKEN" > /path/to/sort-oidc-token
docker cp /path/to/sort-oidc-token sort-demo-bridge:/run/secrets/sort-oidc-token
```

If the container was never started with `SORT_OIDC_TOKEN_FILE` set at all, you need a one-time
`docker rm -f sort-demo-bridge && docker run ...` with
`-v <path>:/run/secrets/sort-oidc-token:ro -e SORT_OIDC_TOKEN_FILE=/run/secrets/sort-oidc-token`
added, alongside the channel-identity env vars documented in `compose.sort-demo.yml`'s own
comments (`SORT_CHANNEL_OPERATOR_KEY_FILE`, `SORT_CHANNEL_BRIDGE_HOLDER_KEY_FILE`,
`SORT_CHANNEL_BRIDGE_NOISE_KEY_FILE`, `SORT_CP_URL`, `SORT_CHANNEL_BROKER`, `SORT_CHANNEL_RELAY`).

### Confirming automation is armed

```bash
docker exec sort-demo-bridge node -e "const s=require('./server.js'); console.log(s.automationConfigured())"
```

`true` means the next Approve click will actually go through. Note the semantics:
`automationConfigured()` checks that a token *source* is present (a configured service-account
secret counts, even before the first mint), plus the channel-identity keys, `SORT_CP_URL`,
`SORT_CHANNEL_BROKER`, and `SORT_CHANNEL_RELAY`. It does **not** validate any token — with only a
static tier-3 token configured, an Approve after the token's real lifetime elapses fails with a
real 502 from the control plane (not a silent false-success); that's expected, not a bug. With
the service-account tier configured, expired-token failures should not occur at all — a 401/403
there means the client secret or the client's realm roles are wrong.

## Outlook: portal-hosted claim flow may remove bridge-held credentials entirely

With the service-account tier in place, the day-to-day "re-arm automation by hand" dance is gone.
What remains open is a CADS-Tunnel-side change that could remove the need for the bridge to hold
*any* control-plane credential:

**A portal-hosted `/portal/channels/:channel/claim` flow (announced 2026-08-12, not live yet).**
A member submits their public holder key + noise key + attestation there (same
`ct-agent channel member-material` data this repo's `join.html` already generates client-side and
verifies today) and, on success, the portal itself displays a ready-to-run onboarding block — a
real, server-issued `CT_CHANNEL_GRANT`, real broker/relay addresses, and Bash/PowerShell
start-command tabs, with `CT_CHANNEL_HOLDER_KEY`/`_NOISE_KEY` left as clearly marked blanks
(private keys never transit the server, same discipline this repo already follows).

If/when that lands, the portal mints the grant itself using its own auth, so this bridge would no
longer need any of the three tiers above (`ensureServiceOidcToken`, the automation-session panel
in `admin.html`, `SORT_OIDC_TOKEN` — all of it goes away). `bridge/server.js`'s
`mintGrants`/`cpFetch`/`automateApproval` and the vendored `grant/sort-channel-grant` binary would
also become dead code to remove.

**What's genuinely unclear until it's live, and blocks fully wiring this in now**: whether
`/portal/channels/:channel/claim` has any concept of operator gating (only claimable against a
channel id the operator pre-registered) or is open to anyone who can compute/knows the channel
id. This repo's whole waiting-room design exists specifically so an operator reviews and approves
*before* someone goes live (CADS-DEMO-sort#9) — if claim is unconditionally open, `join.html`/
`admin.html` still need to exist as a review gate *in front of* the claim step, just without
doing the grant-minting themselves anymore. If claim already requires an operator-created channel,
the review gate could move earlier (approve first, hand back a claim link) instead. Don't guess
at this — confirm the real shape once the mechanism is live before restructuring anything.

**Do not implement against this early** — no endpoint exists yet to test against, and guessing at
request/response shapes risks building something that has to be redone once the real API lands.
This section exists so whoever picks this up (a future session, possibly this same one) has the
full context immediately instead of rediscovering it.

## Redeploying after a code change

Both `sort-demo-bridge` and `sort-demo-origin` are typically run with bind mounts for
fast-iterating files (`admin.js`, `join.js`, `index.html`, etc.) and a built image for
`bridge/server.js` and friends. **Editing a bind-mounted file in place does not take effect on
the running container** without a restart, and a plain `docker restart` is not always enough
either if the file was replaced (not edited in place) between container start and restart --
prefer a full recreate (`docker rm -f <name> && docker run ...` with the same flags) whenever in
doubt, especially after any `server.js`/`Dockerfile` change (which need an image rebuild first:
`docker build -f bridge/Dockerfile -t sort-demo-bridge:latest .` -- **from the repo root**, not
`bridge/`, since the Rust `grant-builder` stage needs to see `../grant/`).
