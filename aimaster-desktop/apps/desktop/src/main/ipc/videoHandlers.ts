// What a video file actually is, according to ffprobe.
//
// The renderer could load the file into a `<video>` and read `duration` off
// it, and that would be enough to draw something — but not enough to spot to
// picture, because the one number that matters most is the one a `<video>`
// element will not tell you: the FRAME RATE.
//
// Guessing it is not an option.  23.976 and 25 differ by 4 %, which is four
// seconds over a ninety-minute reel, and a hit point placed on the wrong
// frame rate is wrong by a growing amount the further into the film you get.
// ffprobe is already bundled for the decode path, so it answers here too.

import type { IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFFprobePath } from '@aimaster/audio-engine';
import { recordFailure } from '../utils/failureLog.js';

export interface VideoProbeResult {
  path: string;
  name: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  /** The reel's start timecode in seconds, when the file carries one. */
  startTimecodeSec: number;
  hasAudio: boolean;
}

const PROBE_TIMEOUT_MS = 20_000;

function collectText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ffprobe: 시간이 초과되었습니다'));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * `"24000/1001"` → 23.976.
 *
 * ffprobe reports the rate as an exact rational and that is the honest form:
 * 24000/1001 is not 23.976, it only rounds to it, and the difference is a
 * frame every forty seconds.  The division happens once, here, rather than the
 * app carrying a rounded number around.
 */
function parseRational(text: string | undefined): number {
  if (!text) return 0;
  const [num, den] = text.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** `01:00:00:00` or `01:00:00;00` → seconds, at the file's own rate. */
function timecodeToSeconds(text: string | undefined, fps: number): number {
  if (!text || !(fps > 0)) return 0;
  const match = /^(\d{1,2})[:;](\d{1,2})[:;](\d{1,2})[:;](\d{1,2})$/.exec(text.trim());
  if (!match) return 0;
  const nominal = Math.round(fps);
  const frames = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * nominal
    + Number(match[4]);
  return frames / fps;
}

export function registerVideoHandlers(ipc: IpcMain, packaged: boolean, resourcesPath: string): void {
  ipc.handle('video:probe', async (_e, raw: unknown): Promise<VideoProbeResult> => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
      throw new Error('video:probe: 경로가 잘못됐습니다');
    }
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('video:probe: 파일을 찾을 수 없습니다');
    }

    try {
      const text = await collectText(resolveFFprobePath({ packaged, resourcesPath }), [
        '-v', 'error',
        '-show_entries',
        // `avg_frame_rate` over `r_frame_rate`: the latter reports the TIME
        // BASE, which for a variable-rate phone recording is often 600 or
        // 90000 and would make every hit point nonsense.
        'stream=codec_type,avg_frame_rate,width,height:'
        + 'format=duration:stream_tags=timecode:format_tags=timecode',
        '-of', 'json',
        resolved,
      ]);

      const parsed = JSON.parse(text) as {
        streams?: Array<{
          codec_type?: string; avg_frame_rate?: string;
          width?: number; height?: number;
          tags?: { timecode?: string };
        }>;
        format?: { duration?: string; tags?: { timecode?: string } };
      };

      const streams = parsed.streams ?? [];
      const video = streams.find((s) => s.codec_type === 'video');
      if (!video) throw new Error('video:probe: 영상 트랙이 없습니다');

      const fps = parseRational(video.avg_frame_rate);
      const durationSec = Number(parsed.format?.duration ?? 0);
      const timecode = video.tags?.timecode ?? parsed.format?.tags?.timecode;

      return {
        path: resolved,
        name: path.basename(resolved),
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
        // A file that reports no rate is not rejected — it plays fine, and
        // 25 is the least wrong default.  The UI lets the user set it, and
        // says that it had to guess.
        fps: fps > 0 ? fps : 0,
        width: video.width ?? 0,
        height: video.height ?? 0,
        startTimecodeSec: timecodeToSeconds(timecode, fps > 0 ? fps : 25),
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
      };
    } catch (err) {
      recordFailure('export', `video:probe failed: ${(err as Error).message}`);
      throw err;
    }
  });
}
