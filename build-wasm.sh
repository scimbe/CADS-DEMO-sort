#!/usr/bin/env bash
# Builds ct-agent-wasm (the browser Agent-Fabric channel primitives -- holder/noise identity
# generation, channel_id_for_link, attestation signing) for the browser (wasm-bindgen --target
# web) into ./site/pkg -- generated build output (gitignored), not source, living under site/
# alongside the rest of what sort-demo-origin-local serves (CADS-DEMO-sort#39: that directory is
# mounted as a whole, not file-by-file, specifically so a rebuild here is picked up without
# recreating the container). ct-agent-wasm is "ct-agent
# for the browser", living in scimbe/ct-agent's own wasm/ workspace member; join.js uses it to
# generate a participant's channel identity and sign their join-request attestation entirely
# client-side, no CLI install needed. Same approach CADS-webconference-demo already ships (its
# own build-wasm.sh), pinned independently here since this repo carries no ct-agent source of its
# own. Hermetic: runs entirely inside a throwaway container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pin by commit SHA, not a branch -- bump deliberately. This is the commit this feature was
# actually built and tested against this session (includes scimbe/ct-agent#9's `channel invite`
# and #14's `--version`/unknown-subcommand fixes).
CT_AGENT_REF="${CT_AGENT_REF:-1f629efe5145555ddfa6746194f81eb2dfbdb602}"
OUT_DIR="$REPO_ROOT/site/pkg"

docker run --rm -m 2g --cpus 2 \
  -v "$REPO_ROOT":/work -w /work \
  -v ct-sort-arena-agent-src:/agent-src \
  -v ct-sort-arena-target:/cargo-target \
  -v ct-sort-arena-cargo-registry:/usr/local/cargo/registry \
  -v ct-sort-arena-rustup:/usr/local/rustup \
  -v ct-sort-arena-wasm-bindgen-cli:/usr/local/cargo/bin-wbg \
  rust:1-slim bash -c '
set -euo pipefail
export PATH=/usr/local/cargo/bin-wbg/bin:$PATH
export CARGO_TARGET_DIR=/cargo-target
apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null

if [ ! -d /agent-src/.git ]; then
  git clone https://github.com/scimbe/ct-agent /agent-src
fi
git -C /agent-src fetch origin
git -C /agent-src checkout "'"$CT_AGENT_REF"'"

cd /agent-src
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
cargo build -p ct-agent-wasm --release --target wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null; then
  cargo install wasm-bindgen-cli --version 0.2.126 --root /usr/local/cargo/bin-wbg
fi
mkdir -p /work/site/pkg
wasm-bindgen --target web --out-dir /work/site/pkg \
  /cargo-target/wasm32-unknown-unknown/release/ct_agent_wasm.wasm
'

echo "built: $OUT_DIR (from ct-agent@$CT_AGENT_REF)"
