# Plain Caddy -- no custom build, no ACME DNS plugin. Cert issued CORE-side, mounted in
# as static files. Same convention as CADS-a2a-demo/CADS-auction-demo/help-site.
FROM caddy:2@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d

# The official image already ships /usr/bin/caddy with cap_net_bind_service set as a file
# capability (confirmed: `getcap /usr/bin/caddy` -> cap_net_bind_service=ep), and /data and
# /config are already world-writable -- so a non-root user can still bind :443 and use Caddy's
# XDG state dirs with no further capability grants. uid/gid 1001 matches the binary's existing
# on-disk owner in the upstream image.
RUN addgroup -g 1001 -S caddy && adduser -u 1001 -S -G caddy -H -s /sbin/nologin caddy
USER caddy

# The static index.html at / (site/, mounted read-only at /srv) is the simplest thing this
# container itself serves -- /healthz is the bridge's own endpoint, proxied through here but not
# meaningful to check without the bridge, which has its own HEALTHCHECK in bridge/Dockerfile.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -ksf https://localhost/ || exit 1
