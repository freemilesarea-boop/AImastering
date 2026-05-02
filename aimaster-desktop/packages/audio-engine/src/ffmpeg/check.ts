/**
 * FFmpeg availability check — used at app startup.
 *
 * Uses resolveFFmpegPath/resolveFFprobePath so the check honours the same
 * resolution order (bundled → env var → well-known dirs → PATH) as all
 * other ffmpeg calls.
 */

import { spawnSync } from 'node:child_process';
import { resolveFFmpegPath, resolveFFprobePath, type ResolveBinOptions } from './resolver.js';
import type { FFmpegStatus } from '../types/index.js';

function runVersion(bin: string): string | undefined {
  try {
    const result = spawnSync(bin, ['-version'], {
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
      // shell: false is the default for spawnSync — safe for binary paths with spaces
    });
    if (result.status !== 0 || result.error) return undefined;
    return (result.stdout as string).split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * Check whether ffmpeg and ffprobe are available and return their versions.
 *
 * @param opts  Binary resolution options (pass `{ packaged, resourcesPath }`
 *              when running inside a packaged Electron app).
 */
export function checkFFmpeg(opts: ResolveBinOptions = {}): FFmpegStatus {
  const ffmpegPath  = resolveFFmpegPath(opts);
  const ffprobePath = resolveFFprobePath(opts);

  const ffmpegVersion  = runVersion(ffmpegPath);
  const ffprobeVersion = runVersion(ffprobePath);

  const parsedVersion = ffmpegVersion?.match(/version\s+(\S+)/)?.[1];
  return {
    available:        ffmpegVersion !== undefined,
    ...(parsedVersion ? { version: parsedVersion } : {}),
    path:             ffmpegPath,
    ffprobeAvailable: ffprobeVersion !== undefined,
  };
}
