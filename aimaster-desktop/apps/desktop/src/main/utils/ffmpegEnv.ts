// ffmpegEnv — point the bundled-binary env overrides at the FFmpeg/FFprobe
// that electron-builder copies into the packaged app's resources.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `@aimaster/audio-engine`'s resolver finds ffmpeg in this order:
//   1. explicit { packaged, resourcesPath } opts  (bundled binary)
//   2. AIMASTER_FFMPEG / AIMASTER_FFPROBE env var override
//   3. platform well-known install dirs
//   4. bare `ffmpeg` / `ffmpeg.exe` resolved via PATH at spawn time
//
// Several main-process consumers call `resolveFFmpegPath()` with NO opts and
// no easy access to `app` / `process.resourcesPath`:
//   • the file:save-audio transcode (utils/audioTranscode.ts)
//   • the Rust offline render (offline/process-audio-file-rust.ts) — which is
//     also exercised by the headless tsx parity harness, so it must NOT import
//     `electron`
//   • the Python engine's ffmpeg_wrapper.py (reads the env vars directly)
//
// Before this helper those consumers depended on `resolvePaths()` in
// audioHandlers having ALREADY run (it set the env vars as a side effect of the
// first analyze/master).  That made resolution order-dependent: on a clean
// machine with no system ffmpeg, the startup `checkFFmpeg()` and an export or
// offline render issued before any master would resolve the bare name, fail to
// spawn, and report "FFmpeg not found" on BOTH Windows and macOS even though
// the bundled binary was sitting in resources the whole time.
//
// Calling `applyBundledFfmpegEnv` once at app startup makes the bundled binary
// discoverable to every consumer regardless of call order.  In dev (not
// packaged) it is a no-op so the resolver's well-known-dir / PATH search picks
// up a system ffmpeg.  Idempotent, and it never clobbers an override the
// user/CI set deliberately.
//
// This module intentionally has NO `electron` import so the pure resolution
// logic can be unit-tested headlessly (Windows `.exe` vs POSIX, the dev no-op,
// the "already set" passthrough) — callers supply `app.isPackaged` /
// `process.resourcesPath` from the Electron side.

import path from 'node:path';

export interface BundledFfmpegEnvOptions {
  /** `app.isPackaged` — only packaged builds carry bundled binaries. */
  packaged: boolean;
  /** `process.resourcesPath` — root of the packaged resources tree. */
  resourcesPath?: string | undefined;
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
  /** Already-present env values; an existing value is never overwritten. */
  existing?: { ffmpeg?: string | undefined; ffprobe?: string | undefined };
}

/**
 * Pure: compute the AIMASTER_FFMPEG / AIMASTER_FFPROBE values that should be
 * set for a packaged build.  Returns an empty object when nothing should
 * change — i.e. in dev, when `resourcesPath` is missing, or when a value is
 * already provided by the environment.
 */
export function resolveBundledFfmpegEnv(opts: BundledFfmpegEnvOptions): {
  AIMASTER_FFMPEG?: string;
  AIMASTER_FFPROBE?: string;
} {
  if (!opts.packaged || !opts.resourcesPath) return {};
  const platform = opts.platform ?? process.platform;
  const ext = platform === 'win32' ? '.exe' : '';
  const binDir = path.join(opts.resourcesPath, 'bin');

  const out: { AIMASTER_FFMPEG?: string; AIMASTER_FFPROBE?: string } = {};
  if (!opts.existing?.ffmpeg)  out.AIMASTER_FFMPEG  = path.join(binDir, `ffmpeg${ext}`);
  if (!opts.existing?.ffprobe) out.AIMASTER_FFPROBE = path.join(binDir, `ffprobe${ext}`);
  return out;
}

let applied = false;

/**
 * Set AIMASTER_FFMPEG / AIMASTER_FFPROBE on `process.env` for a packaged
 * Electron app.  No-op in dev.  Safe to call repeatedly (runs once) and never
 * overwrites a value the environment already provides.
 *
 * @param packaged       Pass `app.isPackaged`.
 * @param resourcesPath  Pass `process.resourcesPath`.
 */
export function applyBundledFfmpegEnv(packaged: boolean, resourcesPath?: string): void {
  if (applied) return;
  applied = true;
  const vars = resolveBundledFfmpegEnv({
    packaged,
    resourcesPath,
    existing: {
      ffmpeg:  process.env['AIMASTER_FFMPEG'],
      ffprobe: process.env['AIMASTER_FFPROBE'],
    },
  });
  if (vars.AIMASTER_FFMPEG)  process.env['AIMASTER_FFMPEG']  = vars.AIMASTER_FFMPEG;
  if (vars.AIMASTER_FFPROBE) process.env['AIMASTER_FFPROBE'] = vars.AIMASTER_FFPROBE;
}

/** Test-only — reset the once-guard so `applyBundledFfmpegEnv` runs again. */
export function resetBundledFfmpegEnvForTests(): void {
  applied = false;
}
