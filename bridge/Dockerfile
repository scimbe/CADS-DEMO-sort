# The Sort Arena bridge itself is plain Node.js — no ct-agent compilation needed here.
# Production role-serving (a participant joining over a real Agent-Fabric channel) is
# each PARTICIPANT's own concern (see docs/onboarding.md and templates/*) — this bridge
# only ever shells out to whatever operator-configured handler command is listed in
# SORT_PARTICIPANTS_FILE, whether that command itself dials ct-agent or not.
FROM node:20-slim
WORKDIR /app
COPY server.js server.lib.js ./
# python3 is needed by handlers/reference-sorter.sh (the always-on baseline participant);
# harmless to have present even for deployments that don't mount it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 8789
CMD ["node", "server.js"]
