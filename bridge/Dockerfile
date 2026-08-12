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

# CT_AGENT_REF pins a real tag, not `main`, so this image doesn't silently pick up an unreleased
# breaking change -- bump this deliberately when a new ct-agent release is worth pulling in.
FROM rust:1-slim-bookworm AS ct-agent-builder
ARG CT_AGENT_REF=v0.4.4
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev cmake protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch "$CT_AGENT_REF" https://github.com/scimbe/ct-agent.git .
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
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/local/bin/ct-agent --version </dev/null
EXPOSE 8789
CMD ["node", "server.js"]
