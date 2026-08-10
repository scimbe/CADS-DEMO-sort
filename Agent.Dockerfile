# The PUBLIC-facing Browser-Plane agent that tunnels the Sort Arena page to a real
# bunsenbrenner.org subdomain — NOT related to any participant's own ct-agent process
# (each participant runs their own, separately, per docs/onboarding.md). Same
# standalone-repo shape as CADS-a2a-demo's/CADS-auction-demo's Agent.Dockerfile.

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
ARG CT_AGENT_REF=main
RUN git clone https://github.com/scimbe/ct-agent.git /build && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
