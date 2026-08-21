/**
 * The DAW's audio store: FFmpeg decodes a source once, and the result lives on
 * disk as raw float32 that everything else reads from.
 *
 * -- Why the renderer never decodes --------------------------------------
 * `AudioContext.decodeAudioData` is native Chromium code, and on macOS it
 * takes the whole renderer process down with SIGSEGV on real songs:
 *
 *     [audio-cache] decode 31.6MB - I Like You.wav
 *     [CRASH] render-process-gone reason=crashed exit=11
 *
 * There is nothing to catch.  The window is left painted in its own
 * background colour - the black screen - because the process that would have
 * reported the error no longer exists.  A renderer cannot defend itself
 * against a crash inside a call it makes, so it does not make that call.
 *
 * -- Why the samples live in a file --------------------------------------
 * A four-minute stereo song is 92 MB of float32.  Returning that from
 * `ipcMain.handle` costs ~4.5 s - structure-cloned and copied several times -
 * against 1.4 s for FFmpeg to decode the song in the first place.
 *
 * FFmpeg writes straight to the store instead.  What comes back over IPC is a
 * path and a few numbers.  The renderer reads samples through the
 * `aimaster-local://` protocol, which serves HTTP ranges: a 512 KB block -
 * 1.37 seconds of stereo audio - anywhere in the file in about 6 ms.  That is
 * what makes playback streamable instead of resident.
 *
 * -- Why it is a store and not a scratch file ----------------------------
 * Keyed on the source's path, mtime and size, so re-opening a session costs
 * nothing: the decode already happened, possibly days ago.  The peak envelope
 * is computed here too and stored beside the samples, so drawing a timeline
 * needs a 32 KB sidecar rather than 92 MB of PCM per track.  This is what
 * Pro Tools' converted files and Ableton's .asd files are.
 */

import { app, type IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFFmpegPath, resolveFFprobePath } from '@aimaster/audio-engine';
import { log } from '../utils/logger.js';

export interface PcmSourceRequest {
  /** Absolute path of the source file. */
  path: string;
  /** Sample rate to resample to - the session's rate. */
  sampleRate: number;
}

export interface PcmSourceResult {
  /** Store key - stable across runs for the same source. */
  key: string;
  /** Absolute path of the interleaved float32 store file. */
  pcmPath: string;
  sampleRate: number;
  channels: number;
  frames: number;
  /** Peak envelope for waveform drawing, 0..1, computed while decoding. */
  peaks: number[];
}

interface Sidecar {
  sampleRate: number;
  channels: number;
  frames: number;
  peaks: number[];
}

/** Stereo is the ceiling: the DAW's clip model is mono or stereo. */
const MAX_CHANNELS = 2;
/** Refuse absurd inputs rather than trying to store them. */
const MAX_SECONDS = 3 * 60 * 60;
/** Peak envelope resolution - matches the renderer's waveform buckets. */
const PEAK_BUCKETS = 4096;
/** How much decoded audio to keep on disk before dropping the oldest. */
const STORE_CAP_BYTES = 12 * 1024 * 1024 * 1024;

function storeDir(): string {
  return path.join(app.getPath('userData'), 'pcm-store');
}

/**
 * Identify a decode by what would change its samples: which file, which
 * version of it, and the rate it was resampled to.
 */
function storeKey(filePath: string, mtimeMs: number, size: number, sampleRate: number): string {
  return crypto.createHash('sha1')
    .update(`${filePath} ${Math.round(mtimeMs)} ${size} ${sampleRate}`)
    .digest('hex');
}

/** Drop the least recently used stores until the directory is inside its cap. */
function sweepStore(): void {
  const dir = storeDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }

  const entries: Array<{ file: string; bytes: number; atime: number }> = [];
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.f32')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      entries.push({ file, bytes: stat.size, atime: stat.atimeMs });
      total += stat.size;
    } catch { /* vanished */ }
  }
  if (total <= STORE_CAP_BYTES) return;

  entries.sort((a, b) => a.atime - b.atime);
  for (const entry of entries) {
    if (total <= STORE_CAP_BYTES) break;
    try {
      fs.unlinkSync(entry.file);
      fs.rmSync(entry.file.slice(0, -4) + '.json', { force: true });
      total -= entry.bytes;
    } catch { /* another run got there first */ }
  }
}

function collectText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

interface ProbeResult { channels: number; durationSec: number }

async function probe(bin: string, filePath: string): Promise<ProbeResult> {
  const out = await collectText(bin, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=channels:format=duration',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(out) as {
    streams?: Array<{ channels?: number }>;
    format?: { duration?: string };
  };
  const channels = parsed.streams?.[0]?.channels ?? 2;
  const durationSec = Number(parsed.format?.duration ?? 0);
  return {
    channels: Math.min(MAX_CHANNELS, Math.max(1, channels)),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
  };
}

function runFFmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

/**
 * Peak envelope, read back from the store in chunks.
 *
 * Streamed rather than loaded: the point of the store is that a 92 MB song
 * never has to be resident anywhere, and that has to hold for the process
 * that wrote it too.
 */
async function computePeaks(
  pcmPath: string, frames: number, channels: number, buckets = PEAK_BUCKETS,
): Promise<number[]> {
  const peaks = new Float32Array(buckets);
  const framesPerBucket = frames / buckets;
  const bytesPerFrame = channels * 4;
  const stream = fs.createReadStream(pcmPath, { highWaterMark: 1 << 20 });

  let carry: Buffer = Buffer.alloc(0);
  let frameIndex = 0;

  for await (const chunk of stream) {
    const buf: Buffer = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    const whole = Math.floor(buf.length / bytesPerFrame);
    for (let f = 0; f < whole; f++) {
      const base = f * bytesPerFrame;
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const v = Math.abs(buf.readFloatLE(base + c * 4));
        if (v > peak) peak = v;
      }
      const bucket = Math.min(buckets - 1, Math.floor((frameIndex + f) / framesPerBucket));
      if (peak > peaks[bucket]!) peaks[bucket] = peak;
    }
    frameIndex += whole;
    carry = buf.subarray(whole * bytesPerFrame);
  }

  let max = 0;
  for (const v of peaks) if (v > max) max = v;
  if (max > 0 && max < 1) for (let i = 0; i < buckets; i++) peaks[i] = peaks[i]! / max;
  return Array.from(peaks);
}

export function registerDecodeHandlers(ipc: IpcMain, packaged: boolean, resourcesPath: string): void {
  const binOpts = { packaged, resourcesPath };

  ipc.handle('daw:pcm-source', async (_e, req: unknown): Promise<PcmSourceResult> => {
    const request = req as Partial<PcmSourceRequest> | undefined;
    const filePath = request?.path;
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new Error('daw:pcm-source: path must be a non-empty string');
    }
    const sampleRate = Number(request?.sampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384_000) {
      throw new Error('daw:pcm-source: sampleRate out of range');
    }

    const resolved = path.resolve(filePath);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('daw:pcm-source: not a regular file');

    const key = storeKey(resolved, stat.mtimeMs, stat.size, sampleRate);
    const dir = storeDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const pcmPath = path.join(dir, `${key}.f32`);
    const sidePath = path.join(dir, `${key}.json`);

    // -- Hit: the decode already happened, maybe days ago -------------------
    try {
      const side = JSON.parse(await fs.promises.readFile(sidePath, 'utf8')) as Sidecar;
      const pcmStat = await fs.promises.stat(pcmPath);
      if (pcmStat.size === side.frames * side.channels * 4) {
        // Touch it so the sweep treats it as recently used.
        const now = new Date();
        await fs.promises.utimes(pcmPath, now, now).catch(() => { /* best effort */ });
        return { key, pcmPath, ...side };
      }
    } catch { /* miss - decode below */ }

    const info = await probe(resolveFFprobePath(binOpts), resolved);
    if (info.durationSec > MAX_SECONDS) {
      throw new Error(`daw:pcm-source: ${Math.round(info.durationSec / 60)}분짜리 파일은 너무 깁니다`);
    }

    sweepStore();
    // Decode to a temporary name so a crash mid-write cannot leave a
    // half-written store that the key says is complete.
    const partial = path.join(dir, `${key}.${crypto.randomUUID()}.part`);
    try {
      await runFFmpeg(resolveFFmpegPath(binOpts), [
        '-v', 'error',
        '-i', resolved,
        '-map', '0:a:0',
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ac', String(info.channels),
        '-ar', String(sampleRate),
        '-y', partial,
      ]);
      // The file size IS the frame count - no estimate, no slack.
      const bytes = (await fs.promises.stat(partial)).size;
      const frames = Math.floor(bytes / (info.channels * 4));
      if (frames <= 0) throw new Error('디코딩 결과가 비어 있습니다');

      const peaks = await computePeaks(partial, frames, info.channels);
      await fs.promises.rename(partial, pcmPath);
      const side: Sidecar = { sampleRate, channels: info.channels, frames, peaks };
      await fs.promises.writeFile(sidePath, JSON.stringify(side));

      log.info(`[pcm] ${path.basename(resolved)} -> ${frames} frames x ${info.channels}ch @ ${sampleRate}`);
      return { key, pcmPath, ...side };
    } catch (err) {
      await fs.promises.rm(partial, { force: true }).catch(() => { /* never written */ });
      throw err;
    }
  });
}
