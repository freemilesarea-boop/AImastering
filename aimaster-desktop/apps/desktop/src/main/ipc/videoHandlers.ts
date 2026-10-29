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
//
// ── The start timecode is converted by the app's own SMPTE code ─────────────
//
// This file used to carry its own `timecodeToSeconds`, and it accepted `;`
// before the frames — which is precisely how ffprobe marks DROP-FRAME
// timecode — and then counted the frames as if they were non-drop:
//
//     frames = ((hh * 60 + mm) * 60 + ss) * round(fps) + ff
//
// Drop-frame skips frame NUMBERS (00 and 01 at the top of every minute but
// every tenth), so over an hour that formula is 108 frames long: a reel
// starting at `01:00:00;00` was read as 3603.6 s instead of 3600.0, and every
// hit point in the session sat 3.6 seconds off it.  `daw/model/video.ts` had
// the SMPTE rule right the whole time, and `video-selftest` had been checking
// it — against the renderer's copy, which is not the one this handler called.
//
// So the conversion is imported rather than written again.  There is only one
// of it now, and it is the one with the tests.

import type { IpcMain } from 'electron';
import { validateAbsoluteFilePath } from '../utils/ipcValidation.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFFprobePath } from '@aimaster/audio-engine';
import { recordFailure } from '../utils/failureLog.js';
// From `model/timecode.ts`, which imports nothing — see its header.  Not
// from `model/video.ts`: that one carries `DawSession`, and through it the
// plugin types, which speak `AudioNode` a main-process tsconfig has no lib for.
import { parseTimecode } from '../../renderer/daw/model/timecode.js';

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

export function registerVideoHandlers(ipc: IpcMain, packaged: boolean, resourcesPath: string): void {
  ipc.handle('video:probe', async (_e, raw: unknown): Promise<VideoProbeResult> => {
    // Shared validator, not a third copy of the same three checks.
    const resolved = validateAbsoluteFilePath(raw, 'video:probe');
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
        // A file that reports no rate is reported as 0 rather than rejected:
        // it plays fine, and the VIEWER is where the fallback belongs, because
        // it is the thing that can tell the user it had to guess (it fills in
        // 25 and says so).  A default invented here would arrive looking like
        // something ffprobe said.
        fps: fps > 0 ? fps : 0,
        width: video.width ?? 0,
        height: video.height ?? 0,
        // `parseTimecode` reads the drop-frame marker and applies the SMPTE
        // rule; it returns null for anything that is not timecode, which is
        // the same "no start timecode" as a file that carries none.
        startTimecodeSec: timecode ? parseTimecode(timecode, fps > 0 ? fps : 25) ?? 0 : 0,
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
      };
    } catch (err) {
      recordFailure('export', `video:probe failed: ${(err as Error).message}`);
      throw err;
    }
  });
}
