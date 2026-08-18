#!/usr/bin/env bash
# Build the `no-modules` wasm-bindgen target of `loui-dsp-wasm` so the
# Rust MasteringChain can be loaded INSIDE an AudioWorkletProcessor.
#
# Why a second target?
#   The renderer's main-thread build uses `--target web` (ES-module glue
#   that fetches its own `.wasm` via `import.meta.url`).  That glue cannot
#   run in `AudioWorkletGlobalScope` — there is no `import.meta`, no
#   `fetch`, no dynamic `import`.  `--target no-modules` emits glue that
#   defines a single `wasm_bindgen` value and supports SYNCHRONOUS
#   instantiation (`initSync`) from a pre-compiled `WebAssembly.Module`,
#   which is exactly what the worklet needs (its constructor cannot await).
#
# This script is ADDITIVE — it never touches the `--target web` output in
# `packages/dsp-wasm/pkg` that the renderer imports today.
#
# One-time setup (same as the web build):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli
#
# Run:
#   bash dsp-core/scripts/build-wasm-worklet.sh
# or:
#   pnpm --filter @loui/dsp-wasm run build:worklet

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
DSP_CORE_DIR="${SCRIPT_DIR}/.."
WORKSPACE_ROOT="$( cd -- "${DSP_CORE_DIR}/.." && pwd )"

# Staging area inside the dsp-wasm package (build output, gitignored).
WORKLET_PKG_DIR="${WORKSPACE_ROOT}/packages/dsp-wasm/pkg-worklet"
# Final home for the worklet-loadable assets: the renderer's Vite
# `public/` dir — copied verbatim into the bundle, served at a stable
# root-relative URL (same convention as analyzer-tap.worklet.js).
RENDERER_PUBLIC_DIR="${WORKSPACE_ROOT}/apps/desktop/src/renderer/public"

# Asset names (must match the renderer's mastering-worklet-assets.ts).
GLUE_NAME="loui-mastering-wasm.nomodules.js"
WASM_NAME="loui-mastering-wasm.nomodules.wasm"
WORKLET_SRC="${WORKSPACE_ROOT}/apps/desktop/src/renderer/audio/mastering-chain.worklet.js"
WORKLET_NAME="mastering-chain.worklet.js"

# 1) Build loui-dsp-wasm for wasm32 (reuses the web build's artefact).
echo "[build-wasm-worklet] cargo build --release --target wasm32-unknown-unknown"
( cd "${DSP_CORE_DIR}" && cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm )

WASM_IN="${DSP_CORE_DIR}/target/wasm32-unknown-unknown/release/loui_dsp_wasm.wasm"
if [ ! -f "${WASM_IN}" ]; then
  echo "[build-wasm-worklet] missing wasm artefact: ${WASM_IN}" >&2
  exit 1
fi
if ! command -v wasm-bindgen &> /dev/null; then
  echo "[build-wasm-worklet] wasm-bindgen CLI not found." >&2
  echo "[build-wasm-worklet] install with: cargo install wasm-bindgen-cli" >&2
  exit 1
fi

# 2) wasm-bindgen --target no-modules.
echo "[build-wasm-worklet] wasm-bindgen --target no-modules → ${WORKLET_PKG_DIR}"
rm -rf "${WORKLET_PKG_DIR}"
mkdir -p "${WORKLET_PKG_DIR}"
wasm-bindgen "${WASM_IN}" \
  --out-dir "${WORKLET_PKG_DIR}" \
  --out-name "loui_dsp_wasm" \
  --target no-modules \
  --no-modules-global "wasm_bindgen"

GLUE_IN="${WORKLET_PKG_DIR}/loui_dsp_wasm.js"
WASM_BG="${WORKLET_PKG_DIR}/loui_dsp_wasm_bg.wasm"
if [ ! -f "${GLUE_IN}" ] || [ ! -f "${WASM_BG}" ]; then
  echo "[build-wasm-worklet] expected no-modules output missing" >&2
  ls -la "${WORKLET_PKG_DIR}" >&2
  exit 1
fi

# 3) Append the worklet bootstrap epilogue to the glue.
#
#    The no-modules glue evaluates as a module inside AudioWorkletGlobalScope
#    and keeps `wasm_bindgen` in module scope.  We expose a tiny synchronous
#    initialiser on `globalThis` so the (separately-evaluated) processor
#    module can construct a chain from the pre-compiled WebAssembly.Module
#    handed to it via `processorOptions`.  See mastering-chain.worklet.js.
GLUE_OUT="${WORKLET_PKG_DIR}/${GLUE_NAME}"
cat "${GLUE_IN}" > "${GLUE_OUT}"
cat >> "${GLUE_OUT}" <<'EPILOGUE'

// ── Loui worklet bootstrap (appended by build-wasm-worklet.sh) ────────
// Exposes a synchronous initialiser on the worklet global scope.  The
// processor's constructor calls this with the WebAssembly.Module compiled
// on the main thread (the audio thread cannot fetch / await).
globalThis.__loui_wasm_bindgen = wasm_bindgen;

// The module is instantiated ONCE per worklet global scope; every chain
// after the first is built from that same instance.
//
// `initSync` does not just wire imports — it creates a new
// WebAssembly.Instance and rebinds the glue's module-scoped `wasm` to it.
// Calling it a second time therefore replaces the linear memory that every
// chain already handed out pointers into, and the next `processStereo` on an
// older chain dereferences an address that now means something else. The
// renderer dies with SIGSEGV (exit code 11), which is what happened the
// moment a session ran one chain per track: the loader constructs one node
// to prove the processor registered, and the first per-track node was
// already the second instantiation.
//
// One instance, many chains, is also what the Rust side expects — a
// `LouiMasteringChain` owns its own state and nothing is shared between
// them except the module's code.
var __loui_wasm_ready = false;
globalThis.__loui_init_mastering = function (wasmModule, sr) {
  if (!__loui_wasm_ready) {
    wasm_bindgen.initSync({ module: wasmModule });
    __loui_wasm_ready = true;
  }
  return new wasm_bindgen.LouiMasteringChain(sr);
};
EPILOGUE

# 4) Copy worklet-loadable assets into the renderer public dir.
mkdir -p "${RENDERER_PUBLIC_DIR}"
cp "${GLUE_OUT}"    "${RENDERER_PUBLIC_DIR}/${GLUE_NAME}"
cp "${WASM_BG}"     "${RENDERER_PUBLIC_DIR}/${WASM_NAME}"
cp "${WORKLET_SRC}" "${RENDERER_PUBLIC_DIR}/${WORKLET_NAME}"

echo "[build-wasm-worklet] done — worklet assets in ${RENDERER_PUBLIC_DIR}:"
ls -lh "${RENDERER_PUBLIC_DIR}/${GLUE_NAME}" \
       "${RENDERER_PUBLIC_DIR}/${WASM_NAME}" \
       "${RENDERER_PUBLIC_DIR}/${WORKLET_NAME}"
