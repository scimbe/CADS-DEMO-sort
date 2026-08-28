# The PUBLIC-facing Browser-Plane agent that tunnels the Sort Arena page to a real
# bunsenbrenner.org subdomain — NOT related to any participant's own ct-agent process
# (each participant runs their own, separately, per docs/onboarding.md). Same
# standalone-repo shape as CADS-a2a-demo's/CADS-auction-demo's Agent.Dockerfile.

FROM rust:1-slim-bookworm@sha256:1469a27c125cb5a3aebfa4f4e4665d935b02fb72cc093b2c974b3d740e43f157 AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# sort#42: this used to default to `main` (an unreviewed, unversioned moving target — any commit
# merged upstream landed in the public tunnel agent on the next build, with no changelog and no
# reproducibility). The operator's call: don't pin to a fixed version either, since that goes stale
# (bridge/Dockerfile's own v0.4.15 pin had drifted 5 releases behind ct-agent's real latest, v0.5.4,
# by the time this was reviewed) -- track the latest RELEASE TAG instead. A tag only exists once
# upstream has actually cut a release, so this is real version tracking, not `main`'s arbitrary-commit
# exposure -- and the resolved tag is printed below, so every build log records exactly what shipped.
# CT_AGENT_REF still overrides to a specific tag when that's ever needed (a bad release, a pin during
# investigation); leave it unset for the normal "always latest release" behavior.
ARG CT_AGENT_REF=
RUN set -eu; \
    ref="${CT_AGENT_REF:-}"; \
    if [ -z "$ref" ]; then \
      ref="$(git ls-remote --tags --refs --sort='-v:refname' https://github.com/scimbe/ct-agent.git | head -1 | sed 's#.*refs/tags/##')"; \
      [ -n "$ref" ] || { echo "could not resolve the latest ct-agent release tag" >&2; exit 1; }; \
    fi; \
    echo "building ct-agent @ ${ref}"; \
    git clone --depth 1 --branch "$ref" https://github.com/scimbe/ct-agent.git /build
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
# debian:bookworm-slim has no unprivileged user by default -- add one. ct-agent only ever dials
# OUT (CT_AGENT_EDGE) and writes its own state (CT_AGENT_STATE_DIR=/var/lib/ct-agent, mounted as
# the sort_demo_agent_state volume) and capability file (CT_AGENT_CAPABILITY_OUT, under /tmp,
# already world-writable) -- it never needs to bind a privileged port, so no special capability
# is required here (contrast Caddy.Dockerfile, which does bind :443).
RUN groupadd --gid 10001 ctagent \
    && useradd --uid 10001 --gid ctagent --no-create-home --shell /usr/sbin/nologin ctagent \
    && mkdir -p /var/lib/ct-agent \
    && chown ctagent:ctagent /var/lib/ct-agent
USER ctagent
CMD ["ct-agent"]
