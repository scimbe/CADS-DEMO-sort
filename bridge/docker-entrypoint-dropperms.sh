#!/bin/sh
# Root-then-drop-privileges entrypoint (CADS-DEMO-sort#45 follow-up).
#
# Why this exists: the bridge's 4 channel-identity secrets are bind-mounted from the host as
# 0600 files owned by the host operator account. That uid is NOT node:20-slim's built-in `node`
# user (uid 1000) -- on this deployment's host, uid 1000 already belongs to a real, unrelated
# login, so chowning the host secrets to it (the "obvious" fix) would hand that other account
# read access to sort's private keys. See ops/deployment-ledger.ndjson
# (2026-08-28T10:25:00Z) and the comment on #45 for the full incident.
#
# This container therefore starts as root (see Dockerfile: no final USER). This script runs
# first, as root: it COPIES each configured secret file into a node-owned, node-only-readable
# location -- never touching the original bind-mounted host file's ownership or permissions --
# re-points the matching *_FILE env var at the copy, then drops privileges via gosu and execs
# the real command as `node`. tini (the container's actual PID 1, see ENTRYPOINT) still wraps
# this whole chain for zombie reaping.
set -eu

READABLE_DIR=/run/secrets-readable
mkdir -p "$READABLE_DIR"
chown node:node "$READABLE_DIR"
chmod 0700 "$READABLE_DIR"

# Keyed by var name (not source basename) so two secrets that happened to share a filename in
# different source directories could never collide in $READABLE_DIR.
for var in \
  SORT_CHANNEL_OPERATOR_KEY_FILE \
  SORT_OIDC_CLIENT_SECRET_FILE \
  SORT_CHANNEL_BRIDGE_HOLDER_KEY_FILE \
  SORT_CHANNEL_BRIDGE_NOISE_KEY_FILE \
; do
  eval "src=\${$var:-}"
  if [ -n "$src" ]; then
    if [ ! -f "$src" ]; then
      echo "docker-entrypoint-dropperms: $var=$src does not exist, skipping" >&2
      continue
    fi
    dest="$READABLE_DIR/$var"
    cp "$src" "$dest"
    chown node:node "$dest"
    chmod 0400 "$dest"
    eval "export $var=\"$dest\""
  fi
done

exec gosu node "$@"
