# Operating a Sort Arena deployment (operator-only)

This is for whoever runs `sort-demo-bridge`/`sort-demo-origin` — not participants. If you're
trying to join the arena, see [`docs/onboarding.md`](onboarding.md) or the
[Join as a participant](https://scimbe.github.io/CADS-DEMO-sort-docs/how-to/join-as-a-participant/)
how-to instead.

## Opening a live-automation testing window (SORT_OIDC_TOKEN)

`admin.html`'s Approve button mints both channel grants and registers the channel + both members
with the control plane automatically (`bridge/server.js`'s `automateApproval`) — but that needs a
control-plane bearer token (`SORT_OIDC_TOKEN`), and the only credential this deployment currently
has for that is a **Keycloak password grant against a real human account, valid roughly 5
minutes**. There is no long-lived service-account/`client_credentials` option today (see
"Known limitation" below). So "opening automation" is a manual, short-lived action you repeat
whenever you actually want to test or admit someone live — it is not something to leave configured
permanently as-is.

### Step 1 — mint a token yourself

**Do this in your own terminal. Never paste your password into a chat with an AI agent, and never
let one run a script with your password as an argument or env var** — that pattern is (correctly)
blocked by responsible-AI tooling, and for good reason: a scripted credential exchange is exactly
what you don't want an agent doing on your behalf, browser-automated or otherwise.

```bash
export OIDC_PASSWORD='<your real password>'   # your terminal, not anyone else's
OIDC_ISSUER_BASE=https://auth.bunsenbrenner.org/realms/ct-demo \
OIDC_USERNAME=<your account email> \
scripts/channel-ops/mint-oidc-token.sh   # from a CADS-Tunnel checkout; see that repo
```

This prints one bare access-token line (nothing else), valid for a few minutes from the moment
it's minted — check the token's own `exp` claim if you need the exact number for your realm.

### Step 2 — get it to the bridge

The bridge already supports the standard `_FILE` secrets convention
(`readSecret()` in `bridge/server.js`): if `SORT_OIDC_TOKEN_FILE` is set, it reads the token from
that file on every request rather than a fixed env var — so refreshing the file's contents takes
effect immediately, no restart needed, as long as the container was originally started with
`SORT_OIDC_TOKEN_FILE` pointing at a real path.

```bash
# write the freshly minted token to whatever path SORT_OIDC_TOKEN_FILE points at
echo -n "$TOKEN" > /path/to/sort-oidc-token
docker cp /path/to/sort-oidc-token sort-demo-bridge:/run/secrets/sort-oidc-token
```

If the container was never started with `SORT_OIDC_TOKEN_FILE` set at all (first time enabling
automation), you need a one-time `docker rm -f sort-demo-bridge && docker run ...` with
`-v <path>:/run/secrets/sort-oidc-token:ro -e SORT_OIDC_TOKEN_FILE=/run/secrets/sort-oidc-token`
added, alongside the channel-identity env vars documented in `compose.sort-demo.yml`'s own
comments (`SORT_CHANNEL_OPERATOR_KEY_FILE`, `SORT_CHANNEL_BRIDGE_HOLDER_KEY_FILE`,
`SORT_CHANNEL_BRIDGE_NOISE_KEY_FILE`, `SORT_CP_URL`, `SORT_CHANNEL_BROKER`, `SORT_CHANNEL_RELAY`).
After that first setup, every later refresh is just the `docker cp` above — no restart, no
downtime, no dropped in-flight requests.

### Step 3 — confirm it actually took

```bash
docker exec sort-demo-bridge node -e "const s=require('./server.js'); console.log(s.automationConfigured())"
```

`true` means the next Approve click will actually go through. Once the token's real lifetime
elapses, `automateApproval()` starts failing with a real 502 from the control plane (not a silent
false-success) — `automationConfigured()` itself doesn't check token *validity*, only that one is
*present*, so a pending Approve failing right after a window closes is expected, not a bug.

## Known limitation: no long-lived credential yet

This whole dance exists because the only credential wired up is a real human's password grant.
The right fix is a Keycloak **service account** for this bridge (`client_credentials` grant,
`service-account` roles scoped to exactly `POST /me/channels` and
`/me/channels/:channel/members`, nothing else) — that would make `SORT_OIDC_TOKEN` a
long-lived, non-human credential the bridge could refresh itself on a timer, closing this gap
for good. That's a CADS-Tunnel-side change (realm/client configuration), not something
`CADS-DEMO-sort` can add on its own — worth filing there if this keeps being a recurring
friction point.

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
