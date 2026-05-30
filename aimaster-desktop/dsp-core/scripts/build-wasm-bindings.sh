#!/usr/bin/env bash
# Build `loui-dsp-wasm` and post-process it into the `@loui/dsp-wasm`
# workspace package consumable by the renderer.
#
# One-time setup:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli
#
# Run:
#   bash dsp-core/scripts/build-wasm-bindings.sh
# or:
#   pnpm --filter @loui/dsp-wasm run build

set -euo pipefail

# Repo locations (resolved relative to this script).
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
DSP_CORE_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="$( cd -- "${DSP_CORE_DIR}/.." && pwd )"
WASM_PKG_DIR="${WORKSPACE_ROOT}/packages/dsp-wasm/pkg"

# 1) Build loui-dsp-wasm.
echo "[build-wasm] cargo build --release --target wasm32-unknown-unknown"
( cd "${DSP_CORE_DIR}" && cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm )

# 2) wasm-bindgen post-process.
WASM_IN="${DSP_CORE_DIR}/target/wasm32-unknown-unknown/release/loui_dsp_wasm.wasm"
if [ ! -f "${WASM_IN}" ]; then
  echo "[build-wasm] missing wasm artefact: ${WASM_IN}" >&2
  exit 1
fi
if ! command -v wasm-bindgen &> /dev/null; then
  echo "[build-wasm] wasm-bindgen CLI not found." >&2
  echo "[build-wasm] install with: cargo install wasm-bindgen-cli" >&2
  exit 1
fi

echo "[build-wasm] wasm-bindgen --target web → ${WASM_PKG_DIR}"
rm -rf "${WASM_PKG_DIR}"
mkdir -p "${WASM_PKG_DIR}"
wasm-bindgen "${WASM_IN}" --out-dir "${WASM_PKG_DIR}" --target web

echo "[build-wasm] done — generated:"
ls -lh "${WASM_PKG_DIR}"
