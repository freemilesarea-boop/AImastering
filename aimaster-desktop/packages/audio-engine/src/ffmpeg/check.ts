import { execSync } from 'node:child_process';
import type { FFmpegStatus } from '../types/index.js';

function runVersion(bin: string): string | undefined {
  try {
    return execSync(`${bin} -version`, { timeout: 5000, stdio: 'pipe' }).toString().split('\n')[0];
  } catch {
    return undefined;
  }
}

export function checkFFmpeg(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe'): FFmpegStatus {
  const version = runVersion(ffmpegPath);
  const ffprobeVersion = runVersion(ffprobePath);
  return {
    available: version !== undefined,
    version: version?.match(/version\s+(\S+)/)?.[1],
    path: ffmpegPath,
    ffprobeAvailable: ffprobeVersion !== undefined,
  };
}
