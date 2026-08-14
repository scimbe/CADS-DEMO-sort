# Status -- sort arena (generated, do not hand-edit)

Generated: `2026-08-14T12:08:40Z` by `ops/generate-status.py` from the deployment ledger, live probes, and the `state:` label family. Stale timestamps mean nobody ran the generator, not that nothing happened -- check the ledger's own tail when in doubt.

## Components (last ledger entry per component)

| Component | Artifact | When | Verification |
|---|---|---|---|
| bridge | sort-demo-bridge:v0415-svcaccount @ HEAD (ct-agent 0.4.15) | 2026-08-14T12:08:40Z | image ct-agent 0.4.15; local run finishedCorrectly; external 3/3 200; service-account tier intact |
| ledger | ops/generate-status.py + STATUS.md snapshot @ HEAD | 2026-08-14T07:23:24Z | generated STATUS.md renders all three sources; live probe 200 |
| origin-caddy | container recreate @ HEAD (Stop-button index.html fix live) | 2026-08-14T11:57:27Z | join.html 302 gate; index.html serves rosterLoaded guard (3 occurrences); participants 200 |

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
