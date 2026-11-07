// shipped-binaries — which ffmpeg and which ffprobe does this repository have?
//
// Not "which are installed": this project does not install them, it SHIPS
// them.  `scripts/prebuild.cjs` copies a pair into the desktop app's
// public/bin for packaging; `ffmpeg-static` and `@ffprobe-installer` unpack
// the other copies into node_modules; `boot.sh` has resolved them that way
// for the smoke runs since the first one.
//
// Several selftests answered the question themselves and answered it with
// PATH, which works on every developer machine and on no CI runner.  The
// first CI run of the suite walked through them one at a time — step 141
// (pytest's own resolution), 142 (the engine's ffprobe), 146 (a selftest that
// drives the real ffprobe to get real stderr) — each one a different file
// reaching the same wrong way.  So the answer lives here once.
//
// `ffmpeg-static` ships ONLY ffmpeg: looking for an ffprobe beside it, which
// is what audio-engine-selftest did, finds nothing and falls back to a bare
// name.  That is why ffprobe has its own package in the candidate list.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
/** apps/desktop, from apps/desktop/scripts/lib. */
const DESKTOP = path.resolve(__dirname, '..', '..');

function firstFile(candidates: (() => string | null)[]): string | null {
  for (const candidate of candidates) {
    let value: string | null = null;
    try { value = candidate(); } catch { value = null; }
    if (value === null || value === '') continue;
    for (const full of [value, `${value}.exe`]) {
      try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
    }
  }
  return null;
}

/** The ffmpeg this repository has, or null when it has none. */
export function shippedFfmpeg(): string | null {
  return firstFile([
    () => process.env['AIMASTER_FFMPEG'] ?? null,
    () => req('ffmpeg-static') as string,
    () => path.join(DESKTOP, 'public', 'bin', 'ffmpeg'),
  ]);
}

/** The ffprobe this repository has, or null when it has none. */
export function shippedFfprobe(): string | null {
  return firstFile([
    () => process.env['AIMASTER_FFPROBE'] ?? null,
    () => (req('@ffprobe-installer/ffprobe') as { path: string }).path,
    () => path.join(DESKTOP, 'public', 'bin', 'ffprobe'),
  ]);
}

/**
 * Put both into the environment, for a child that resolves them itself —
 * the Python engine does, and `audioHandlers` does the same thing for the
 * app with `applyBundledFfmpegEnv()`.
 *
 * A name it cannot resolve is left unset rather than set to a guess: an
 * absent variable leaves the child's own resolution intact, which is the
 * right outcome on a machine that has ffmpeg on PATH.
 */
export function applyShippedFfmpegEnv(): { ffmpeg: string | null; ffprobe: string | null } {
  const ffmpeg = shippedFfmpeg();
  const ffprobe = shippedFfprobe();
  if (ffmpeg !== null) process.env['AIMASTER_FFMPEG'] = ffmpeg;
  if (ffprobe !== null) process.env['AIMASTER_FFPROBE'] = ffprobe;
  return { ffmpeg, ffprobe };
}
