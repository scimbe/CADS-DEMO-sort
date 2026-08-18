# The Sort Arena bridge itself is plain Node.js -- role-serving (a participant joining over a
# real Agent-Fabric channel) is each PARTICIPANT's own concern (see docs/onboarding.md and
# templates/*), this bridge only ever shells out to whatever operator-configured handler command
# is listed in SORT_PARTICIPANTS_FILE, PLUS (Phase 2 automation, bridge/server.js's
# automateApproval) its own `ct-agent channel` invocation as the INITIATE side when calling a
# self-service participant each round -- that command is only ever real if the `ct-agent` binary
# itself is actually present in this image, which is what real support case CADS-DEMO-sort#9's
# `windows-selection` fault trace surfaced was NOT true here (every round: `sh: 1: ct-agent: not
# found`, exit 127) -- this Dockerfile built the vendored sort-channel-grant binary but never
# installed ct-agent itself, so every approved self-service participant has been unreachable
# since Phase 2 shipped. Fixed below by building the real ct-agent binary from source, from the
# same repo docs/onboarding.md tells a human participant to download a release of -- NOT by
# fetching that release binary directly: it's linked against a newer glibc than this image's
# Debian bookworm base has (confirmed live: `GLIBC_2.39' not found` against node:20-slim), so a
# from-source build in a bookworm-based Rust stage is what actually guarantees libc compatibility
# with the runtime image, same reasoning as the sort-channel-grant stage below already uses.
#
# Both Rust pieces this image needs -- sort-channel-grant (grant/ -- vendored from
# CADS-webconference-demo's ct-video-call-grant, confirmed fully generic despite the origin
# repo's video-specific name) for local grant-signing, and ct-agent itself for the bridge's own
# initiate-side channel dial -- are built from source here, same Rust-builder-stage pattern
# Agent.Dockerfile already uses for ct-agent elsewhere in this ecosystem.
#
# Build context must be the REPO ROOT (not ./bridge) so this stage can see ../grant/ -- see
# compose.sort-demo.yml's `context: .` for the bridge service.
FROM rust:1-slim-bookworm AS grant-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY grant/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/sort-channel-grant /tmp/sort-channel-grant

# sort#42: this used to pin a fixed tag ("bump this deliberately when a new release is worth pulling
# in"), on the reasoning that `main` is an unreviewed moving target. True, but a fixed pin has the
# opposite failure mode: it goes stale silently. It had drifted from v0.4.15 to ct-agent's actual
# latest, v0.5.4 -- five releases -- by the time this was reviewed, with no fixes/bumps tracked here
# since. The operator's call: track the latest RELEASE TAG automatically instead of either extreme.
# A tag only exists once upstream has cut and (per its own release process) reviewed a release, so
# this keeps the "not `main`" property while never going stale -- and the resolved tag is printed at
# build time, so every build log still records exactly what shipped. CT_AGENT_REF still overrides to
# a specific tag for the rare case that needs pinning (e.g. investigating a regression a new release
# introduced); leave it unset for the normal "always latest release" behavior.
#
# Historical pins that mattered functionally, kept for context (superseded by auto-latest, which
# picks these up automatically going forward):
#   v0.4.4 -> v0.4.6 (2026-08-13): three fixes this bridge's own `ct-agent channel` calls needed,
#   from the ct-agent#15 connectivity investigation -- a low-DPI-visibility `:443` dial rung
#   (`318ec1a`), the dial ladder falling through past a `Refused` rung instead of stopping
#   (`600ed5c`), and the ping-capable `'K'` TCP-fallback role for middleboxes that kill idle
#   ACK-only keepalives (`eb4de4d`, measured on this deployment: ~10-15s idle death, 8s ping
#   interval deliberately under that).
FROM rust:1-slim-bookworm AS ct-agent-builder
ARG CT_AGENT_REF=
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev cmake protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN set -eu; \
    ref="${CT_AGENT_REF:-}"; \
    if [ -z "$ref" ]; then \
      ref="$(git ls-remote --tags --refs --sort='-v:refname' https://github.com/scimbe/ct-agent.git | head -1 | sed 's#.*refs/tags/##')"; \
      [ -n "$ref" ] || { echo "could not resolve the latest ct-agent release tag" >&2; exit 1; }; \
    fi; \
    echo "building ct-agent @ ${ref}"; \
    git clone --depth 1 --branch "$ref" https://github.com/scimbe/ct-agent.git .
# native/ is a member of the workspace rooted at ./Cargo.toml (not its own standalone crate), so
# `cargo build`'s target/ always resolves to the WORKSPACE root regardless of --manifest-path or
# cwd -- confirmed live: a `cd native && cargo build --release` left nothing at native/target/
# release/ct-agent, because it was written to /build/target/release/ct-agent instead.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked --manifest-path native/Cargo.toml \
    && cp target/release/ct-agent /tmp/ct-agent

FROM node:20-slim
WORKDIR /app
COPY bridge/server.js bridge/server.lib.js bridge/attestation.js ./
COPY --from=grant-builder /tmp/sort-channel-grant /usr/local/bin/sort-channel-grant
COPY --from=ct-agent-builder /tmp/ct-agent /usr/local/bin/ct-agent
# python3 is needed by handlers/reference-sorter.sh (the always-on baseline participant);
# harmless to have present even for deployments that don't mount it.
#
# tini is NOT optional here, and not mere hygiene. Without it `node server.js` is PID 1, and a
# PID 1 inherits every orphaned process in the container. Node only ever waitpid()s children it
# spawned itself (libuv reaps per tracked process handle, never waitpid(-1)), so anything it
# inherits stays <defunct> forever. server.js shells out via `sh -c`, and `sh -c "VAR=val
# ct-agent channel"` forks a real ct-agent grandchild -- when the round times out and that
# grandchild is killed, it is an orphan by definition (its `sh` parent dies first), so it lands
# on PID 1. Measured live: 75 zombies in ~1h of timing-out dials (CADS-DEMO-sort#9). tini as PID 1
# reaps them; confirmed by building this image and re-running the reproduction against it.
# Baked into the image rather than left to `docker run --init` / compose `init: true` so the fix
# cannot be silently lost by however this image happens to be launched.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/local/bin/ct-agent --version </dev/null
EXPOSE 8789
# node:20-slim's own docker-entrypoint.sh is kept (it just `exec "$@"`s) so this image behaves
# exactly like its base apart from gaining a reaping init.
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
