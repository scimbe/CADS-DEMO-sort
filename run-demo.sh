#!/usr/bin/env bash
# Enable/disable the sort.bunsenbrenner.org demo — same shape as CADS-a2a-demo/run-demo.sh,
# CADS-auction-demo/run-demo.sh, and CADS-Tunnel's examples/help-site/run-demo.sh.
#
#   ./run-demo.sh up        # enable  (default) — mint token, deploy, wait for HTTPS
#   ./run-demo.sh down      # disable — take the demo offline
#   ./run-demo.sh status    # show container status
#   ./run-demo.sh --selftest  # check local prerequisites only, no network calls
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-up}"
COMPOSE="docker compose -f compose.sort-demo.yml"
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a || true

HOSTNAME_FQDN="${HOSTNAME_FQDN:-sort.bunsenbrenner.org}"
CP_URL="${CP_URL:-${SORT_AGENT_CP_URL:-http://127.0.0.1:8090}}"
EDGE="${EDGE:-${SORT_AGENT_EDGE:-127.0.0.1:4433}}"
# CP_URL/EDGE are this SCRIPT's own host-side reachability checks; the CONTAINERIZED
# agent needs the plane's compose-network service names instead when co-located (e.g.
# control-plane:8090 / edge:4433) — see CADS-a2a-demo/run-demo.sh's own comment for the
# full story on why (host-level Docker port-publish vs. container-network reachability).
CONTAINER_CP_URL="${CONTAINER_CP_URL:-$CP_URL}"
CONTAINER_EDGE="${CONTAINER_EDGE:-$EDGE}"
TENANT="${TENANT:-sort-demo}"
EDGE_ADMIN_URL="${CT_CP_EDGE_ADMIN_URL:-}"
EDGE_ADMIN_TOKEN="${CT_CP_EDGE_ADMIN_TOKEN:-}"

say() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$CMD" = "--selftest" ]; then
  say "Selftest: checking local prerequisites only (no network calls)"
  ok=1
  command -v docker >/dev/null || { echo "  ✗ docker not found"; ok=0; }
  command -v curl >/dev/null || { echo "  ✗ curl not found"; ok=0; }
  [ -f compose.sort-demo.yml ] || { echo "  ✗ compose.sort-demo.yml missing"; ok=0; }
  [ -f Caddyfile ] || { echo "  ✗ Caddyfile missing"; ok=0; }
  [ -f Caddy.Dockerfile ] || { echo "  ✗ Caddy.Dockerfile missing"; ok=0; }
  [ -f Agent.Dockerfile ] || { echo "  ✗ Agent.Dockerfile missing"; ok=0; }
  [ -f bridge/Dockerfile ] || { echo "  ✗ bridge/Dockerfile missing"; ok=0; }
  [ -f bridge/server.js ] || { echo "  ✗ bridge/server.js missing"; ok=0; }
  [ -x handlers/reference-sorter.sh ] || { echo "  ✗ handlers/reference-sorter.sh missing or not executable"; ok=0; }
  [ "$ok" = "1" ] && echo "  ✓ all local prerequisites present" || die "selftest failed — see above"
  exit 0
fi

if [ "$CMD" = "down" ] || [ "$CMD" = "disable" ] || [ "$CMD" = "off" ]; then
  say "Taking the sort-demo offline (stopping bridge + origin + agent)"
  $COMPOSE down
  printf '\033[32m✓ sort-demo is OFFLINE.\033[0m\n'
  exit 0
fi
if [ "$CMD" = "status" ]; then
  $COMPOSE ps
  exit 0
fi
[ "$CMD" = "up" ] || [ "$CMD" = "enable" ] || [ "$CMD" = "on" ] || die "unknown command '$CMD' (use: up | down | status | --selftest)"

say "Checking prerequisites"
SORT_CERT_DIR="${SORT_CERT_DIR:?set SORT_CERT_DIR=<dir with fullchain.pem+privkey.pem from the operator>}"
[ -f "$SORT_CERT_DIR/fullchain.pem" ] && [ -f "$SORT_CERT_DIR/privkey.pem" ] \
  || die "no fullchain.pem/privkey.pem in SORT_CERT_DIR=$SORT_CERT_DIR — ask the operator to authorize $HOSTNAME_FQDN and relay the cert files"
SORT_PARTICIPANTS_CONFIG="${SORT_PARTICIPANTS_CONFIG:?set SORT_PARTICIPANTS_CONFIG=<path to a participants.json — see handlers/README.md>}"
[ -f "$SORT_PARTICIPANTS_CONFIG" ] || die "SORT_PARTICIPANTS_CONFIG=$SORT_PARTICIPANTS_CONFIG does not exist"
command -v docker >/dev/null || die "docker not found."
curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 || curl -fsS "$CP_URL/status" >/dev/null 2>&1 \
  || die "control-plane not reachable at $CP_URL (is the plane running?). Set CP_URL."

RESOLVED="$(getent hosts "$HOSTNAME_FQDN" 2>/dev/null | awk '{print $1; exit}')" || true
[ -n "$RESOLVED" ] && echo "   $HOSTNAME_FQDN -> $RESOLVED" \
  || echo "   ! $HOSTNAME_FQDN does not resolve yet (deSEC NS may still be propagating)."

if [ -n "${SORT_JOIN_TOKEN:-}" ]; then
  say "Using pre-minted SORT_JOIN_TOKEN (skipping /enroll/issue — no admin token needed)"
  TOKEN="$SORT_JOIN_TOKEN"
else
  say "Minting a join token at $CP_URL/enroll/issue"
  if [ -n "$EDGE_ADMIN_TOKEN" ]; then
    TOKEN="$(curl -fsS -X POST "$CP_URL/enroll/issue" -H 'content-type: application/json' \
              -H "x-ct-admin-token: $EDGE_ADMIN_TOKEN" -d "{\"tenant\":\"$TENANT\"}" \
              | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p')"
  else
    TOKEN="$(curl -fsS -X POST "$CP_URL/enroll/issue" -H 'content-type: application/json' \
              -d "{\"tenant\":\"$TENANT\"}" | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p')"
  fi
  [ -n "$TOKEN" ] || die "could not mint a join token (if the CP gates /enroll/issue, set CT_CP_EDGE_ADMIN_TOKEN in $ENV_FILE, or set SORT_JOIN_TOKEN to a pre-minted one)"
fi
echo "   token minted (single-use; not printed)"

SORT_AGENT_TOKEN=""
if [ -n "$EDGE_ADMIN_URL" ] && [ -n "$EDGE_ADMIN_TOKEN" ]; then
  command -v openssl >/dev/null || die "openssl needed to mint a routing token (or unset CT_CP_EDGE_ADMIN_URL to use BP4a)."
  SORT_AGENT_TOKEN="$(openssl rand -hex 32)"
  say "Authorizing $HOSTNAME_FQDN at the edge (hostname-ownership, BP4b)"
  curl -fsS -X POST "${EDGE_ADMIN_URL%/}/admin/authorize-host/$SORT_AGENT_TOKEN/$HOSTNAME_FQDN" \
       -H "x-ct-admin-token: $EDGE_ADMIN_TOKEN" >/dev/null \
    || die "edge authorize-host failed (check CT_CP_EDGE_ADMIN_URL / token / edge admin listener)."
  echo "   authorized — agent registers under this routing token."
else
  echo "   ! edge host-auth not configured — relying on BP4a (fine for one hostname)."
fi

say "Starting the bridge + Caddy origin + Browser-Plane agent"
SORT_JOIN_TOKEN="$TOKEN" \
SORT_AGENT_TOKEN="$SORT_AGENT_TOKEN" \
SORT_AGENT_EDGE="$CONTAINER_EDGE" \
SORT_AGENT_CP_URL="$CONTAINER_CP_URL" \
SORT_AGENT_EDGE_CERT_URL="${SORT_AGENT_EDGE_CERT_URL:-$CONTAINER_CP_URL}" \
SORT_CERT_DIR="$SORT_CERT_DIR" \
SORT_PARTICIPANTS_CONFIG="$SORT_PARTICIPANTS_CONFIG" \
  $COMPOSE up --build -d

say "Waiting for https://$HOSTNAME_FQDN/ (Caddy completes the deSEC DNS-01 challenge first) …"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$HOSTNAME_FQDN/" >/dev/null 2>&1; then
    printf '\033[32m✓ LIVE — https://%s/ serves the live Sort Arena.\033[0m\n' "$HOSTNAME_FQDN"
    exit 0
  fi
  sleep 5
done
echo "   Not reachable yet. Check:"
echo "     - DNS:     dig +short A $HOSTNAME_FQDN @1.1.1.1   (must be this host)"
echo "     - cert:    $COMPOSE logs sort-demo-origin"
echo "     - agent:   $COMPOSE logs sort-demo-agent"
echo "     - bridge:  $COMPOSE logs sort-demo-bridge"
die "demo not live within the timeout (see hints above)."
