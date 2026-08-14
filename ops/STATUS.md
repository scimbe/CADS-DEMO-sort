# Status -- sort arena (generated, do not hand-edit)

Generated: `2026-08-14T11:51:37Z` by `ops/generate-status.py` from the deployment ledger, live probes, and the `state:` label family. Stale timestamps mean nobody ran the generator, not that nothing happened -- check the ledger's own tail when in doubt.

## Components (last ledger entry per component)

| Component | Artifact | When | Verification |
|---|---|---|---|
| bridge | sort-demo-bridge:v0413-svcaccount @ dce63c6 | 2026-08-14T11:48:11Z | 82/82 tests incl. client_credentials grant test; local run finishedCorrectly; external 200; secret m |
| ledger | ops/generate-status.py + STATUS.md snapshot @ HEAD | 2026-08-14T07:23:24Z | generated STATUS.md renders all three sources; live probe 200 |
| origin-caddy | container recreate, Caddyfile+statics @ 6f23c0e checkout | 2026-08-14T05:46:00Z | curl -skI /join.html -> 302 gate/start; /participants -> 200 public |

## Live probe

- `https://sort.bunsenbrenner.org/participants`: HTTP 200 -- OK

## Issues by state

### `state: awaiting-user-approval` **<-- the operator's queue**
- #23 bug: sort-Agent ist am Edge nicht registriert — sort.bunsenbrenner.org

### `state: fix-proposed`
- (none)

### `state: deployed`
- #22 Naive-user validation pass of the docs site: arena down most of a 50-m
- #9 Self-service participants register and appear in the roster, but can't

### `state: investigating`
- #24 Retrospective & RFC: LLM-driven development process — collecting what 
- #20 Migrate waiting-room grant automation to the upcoming portal /portal/c

### `state: verified`
- (none)
