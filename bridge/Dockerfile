# The Sort Arena bridge itself is plain Node.js -- role-serving (a participant joining over a
# real Agent-Fabric channel) is each PARTICIPANT's own concern (see docs/onboarding.md and
# templates/*), this bridge only ever shells out to whatever operator-configured handler command
# is listed in SORT_PARTICIPANTS_FILE. The one piece of Rust this image DOES need is
# sort-channel-grant (grant/ -- vendored from CADS-webconference-demo's ct-video-call-grant,
# confirmed fully generic despite the origin repo's video-specific name), which the waiting
# room's approve flow shells out to for real local grant-signing -- same Rust-builder-stage
# pattern Agent.Dockerfile already uses, just building from this repo's own local source instead
# of a git clone.
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

FROM node:20-slim
WORKDIR /app
COPY bridge/server.js bridge/server.lib.js bridge/attestation.js ./
COPY --from=grant-builder /tmp/sort-channel-grant /usr/local/bin/sort-channel-grant
# python3 is needed by handlers/reference-sorter.sh (the always-on baseline participant);
# harmless to have present even for deployments that don't mount it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 8789
CMD ["node", "server.js"]
