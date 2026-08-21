#!/usr/bin/env bash
# =============================================================================
# verify-macos-binary-arch.sh — architecture gate for macOS packaging
#
# Guards against the P0 class of bug where a macOS x64 package ships arm64
# internal binaries (or vice-versa): the Electron shell is downloaded per-arch
# by electron-builder, but the `extraResources` binaries (engine / ffmpeg /
# ffprobe) are copied verbatim and are NOT arch-transformed.  If they are built
# on a mismatched host, the resulting .app crashes on the target Mac with
# "bad CPU type in executable".
#
# This script inspects the actual Mach-O CPU type of the bundled binaries and
# FAILS (non-zero exit) if any of them does not match the expected arch.  Wire
# it into CI *before* packaging (on public/bin) and *after* packaging (on the
# .app's Contents/Resources/bin) so a wrong-arch build can never be uploaded.
#
# Usage:
#   verify-macos-binary-arch.sh <x64|arm64> <target> [<target> ...]
#
#     <target> is either
#       - a directory: engine, ffmpeg, ffprobe inside it are all checked
#                      (all three are required; a missing one is a failure)
#       - a file:      that single Mach-O is checked (e.g. the main app binary)
#
# PASS condition for each binary: it is a Mach-O whose slices include the
# expected arch — i.e. a native slice OR a universal (fat) binary containing
# the expected slice.  arm64-only in an x64 target (and vice-versa), or any
# non-Mach-O (Linux ELF / Windows PE), fails.
#
# Examples:
#   # pre-package, on the source binaries that will be copied into the app
#   scripts/verify-macos-binary-arch.sh x64 aimaster-desktop/apps/desktop/public/bin
#
#   # post-package, on the built .app (bin dir + main executable)
#   scripts/verify-macos-binary-arch.sh x64 \
#     "out/mac/Louver Mastering AI.app/Contents/Resources/bin" \
#     "out/mac/Louver Mastering AI.app/Contents/MacOS/Louver Mastering AI"
# =============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <x64|arm64> <target> [<target> ...]" >&2
  exit 2
fi

EXPECTED_ARCH="$1"; shift

case "$EXPECTED_ARCH" in
  x64)   EXPECTED_SLICE="x86_64" ;;
  arm64) EXPECTED_SLICE="arm64"  ;;
  *) echo "✗ unknown arch '$EXPECTED_ARCH' (expected x64 or arm64)" >&2; exit 2 ;;
esac

# The three internal binaries that must exist inside a bin directory.  The main
# Electron executable is passed separately as a file target.
BIN_NAMES=(engine ffmpeg ffprobe)

FAILURES=0

fail() { echo "  ✗ $*" >&2; FAILURES=$((FAILURES + 1)); }
ok()   { echo "  ✓ $*"; }

# Return the space-separated list of Mach-O slice archs for a file, using lipo
# when available (macOS) and falling back to parsing `file(1)` output.
slices_of() {
  local f="$1"
  if command -v lipo >/dev/null 2>&1; then
    # `lipo -archs` prints e.g. "x86_64" or "x86_64 arm64"; it errors on
    # non-Mach-O, which we translate to empty so the caller reports it.
    lipo -archs "$f" 2>/dev/null || true
  else
    # `file` describes each slice; normalise its arch tokens to lipo names.
    local desc
    desc="$(file -b "$f" 2>/dev/null || true)"
    local out=""
    [[ "$desc" == *"x86_64"* ]]            && out="$out x86_64"
    [[ "$desc" == *"arm64"* ]]            && out="$out arm64"
    echo "$out"
  fi
}

check_file() {
  local f="$1"
  local label="$2"

  if [[ ! -e "$f" ]]; then
    fail "$label: missing at $f"
    return
  fi

  # Reject anything that is not a Mach-O outright (Linux ELF / Windows PE /
  # a shell wrapper masquerading as the real binary).
  local desc
  desc="$(file -b "$f" 2>/dev/null || echo "unknown")"
  if [[ "$desc" != *"Mach-O"* ]]; then
    fail "$label: not a Mach-O binary — file says: $desc"
    return
  fi

  local archs
  archs="$(slices_of "$f")"
  if [[ -z "${archs// /}" ]]; then
    fail "$label: could not determine Mach-O arch (file: $desc)"
    return
  fi

  if [[ " $archs " == *" $EXPECTED_SLICE "* ]]; then
    if [[ "$(echo "$archs" | wc -w)" -gt 1 ]]; then
      ok "$label: universal [$archs] — contains $EXPECTED_SLICE"
    else
      ok "$label: $archs"
    fi
  else
    fail "$label: arch is [$archs], expected $EXPECTED_SLICE ($EXPECTED_ARCH)"
  fi
}

echo "── macOS binary arch gate — expecting $EXPECTED_ARCH ($EXPECTED_SLICE) ──"

for target in "$@"; do
  if [[ -d "$target" ]]; then
    echo "▶ dir: $target"
    for name in "${BIN_NAMES[@]}"; do
      local_path="$target/$name"
      check_file "$local_path" "$name"
      # Executable bit is required — electron-builder preserves mode, and the
      # main process spawns these directly (see resolvePaths() in audioHandlers).
      if [[ -e "$local_path" && ! -x "$local_path" ]]; then
        fail "$name: not executable (chmod +x required)"
      fi
    done
  elif [[ -e "$target" ]]; then
    echo "▶ file: $target"
    check_file "$target" "$(basename "$target")"
  else
    fail "target not found: $target"
  fi
done

echo ""
if [[ "$FAILURES" -gt 0 ]]; then
  echo "✗ FAIL — $FAILURES binary(ies) did not match $EXPECTED_ARCH. Blocking build." >&2
  exit 1
fi
echo "✓ PASS — all inspected binaries are $EXPECTED_ARCH-compatible."
