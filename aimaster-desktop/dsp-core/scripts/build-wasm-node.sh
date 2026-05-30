#!/usr/bin/env bash
# Build the `nodejs` wasm-bindgen target of `loui-dsp-wasm` so the Electron
# MAIN process (Node) can run the SAME Rust MasteringChain as the realtime
# preview — for the experimental Rust offline export render
# (RUST-OFFLINE-RENDER-1).
#
# Why a nodejs target?
#   The renderer uses `--target web` (browser) and the worklet uses
#   `--target no-modules`.  Neither loads cleanly in Node main.
#   `--target nodejs` emits CommonJS glue that `require`s the `.wasm` via
#   fs — runnable under Node / tsx with no native build.
#
# This is ADDITIVE — it never touches the web / worklet outputs.
#
# Run:  bash dsp-core/scripts/build-wasm-node.sh
#  or:  pnpm --filter @loui/dsp-wasm run build:node

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
DSP_CORE_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="$( cd -- "${DSP_CORE_DIR}/.." && pwd )"
NODE_PKG_DIR="${WORKSPACE_ROOT}/packages/dsp-wasm/pkg-node"

echo "[build-wasm-node] cargo build --release --target wasm32-unknown-unknown"
( cd "${DSP_CORE_DIR}" && cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm )

WASM_IN="${DSP_CORE_DIR}/target/wasm32-unknown-unknown/release/loui_dsp_wasm.wasm"
if [ ! -f "${WASM_IN}" ]; then
  echo "[build-wasm-node] missing wasm artefact: ${WASM_IN}" >&2
  exit 1
fi
if ! command -v wasm-bindgen &> /dev/null; then
  echo "[build-wasm-node] wasm-bindgen CLI not found (cargo install wasm-bindgen-cli)" >&2
  exit 1
fi

echo "[build-wasm-node] wasm-bindgen --target nodejs → ${NODE_PKG_DIR}"
rm -rf "${NODE_PKG_DIR}"
mkdir -p "${NODE_PKG_DIR}"
wasm-bindgen "${WASM_IN}" --out-dir "${NODE_PKG_DIR}" --out-name "loui_dsp_wasm" --target nodejs

# The package is `"type": "module"`, so a `.js` CommonJS file would be
# mis-parsed as ESM.  Rename the glue to `.cjs` so `require()` always works
# in the Electron main process / Node scripts.  (The glue loads the .wasm
# via __dirname + a literal filename, so the rename is safe.)
mv "${NODE_PKG_DIR}/loui_dsp_wasm.js" "${NODE_PKG_DIR}/loui_dsp_wasm.cjs"

echo "[build-wasm-node] done — generated:"
ls -lh "${NODE_PKG_DIR}"

