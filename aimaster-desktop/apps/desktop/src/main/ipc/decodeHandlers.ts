/**
 * PCM decoding for the DAW — done by FFmpeg in the main process.
 *
 * The renderer used to call `AudioContext.decodeAudioData` on every file it
 * needed.  That is native Chromium code, and on macOS it takes the whole
 * renderer process down with SIGSEGV on real songs:
 *
 *     [audio-cache] fetch — I Like You.wav
 *     [audio-cache] decode 31.6MB — I Like You.wav
 *     [CRASH] render-process-gone reason=crashed exit=11
 *
 * There is nothing to catch.  The window is left painted in its own
 * background colour — the black screen — because the process that would have
 * reported the error no longer exists.  A renderer cannot defend itself
 * against a crash inside a call it makes.
 *
 * So the decode moves out of the renderer entirely.  FFmpeg reads the file in
 * a child process and writes raw interleaved float32; the renderer assembles
 * an AudioBuffer from those samples with `createBuffer` + `copyToChannel`,
 * which is plain memory copying and cannot fault.  If FFmpeg dies, one IPC
 * call rejects and the app says so — the window stays up.
 *
 * It also decodes more than Chromium does: whatever FFmpeg reads, the DAW now
 * opens.
 */

import type { IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFFmpegPath, resolveFFprobePath } from '@aimaster/audio-engine';
import { log } from '../utils/logger.js';

export interface DecodePcmRequest {
  /** Absolute path of the source file. */
  path: string;
  /** Sample rate to resample to — the session's rate. */
  sampleRate: number;
}

export interface DecodePcmResult {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Interleaved float32, `frames * channels` samples. */
  pcm: Uint8Array;
}

/** Stereo is the ceiling: the DAW's clip model is mono or stereo. */
const MAX_CHANNELS = 2;
/** Refuse absurd inputs rather than trying to hold them in memory. */
const MAX_SECONDS = 3 * 60 * 60;

interface ProbeResult { channels: number; durationSec: number }

async function probe(bin: string, filePath: string): Promise<ProbeResult> {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=channels:format=duration',
    '-of', 'json',
    filePath,
  ];
  const out = await collectText(bin, args);
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

/**
 * Decode to raw interleaved float32.
 *
 * The output size is known ahead of time from the probed duration, so the
 * buffer is allocated once and filled — no repeated `Buffer.concat`, which
 * would briefly hold two copies of a several-hundred-megabyte song.
 */
function decodeToPcm(
  bin: string, filePath: string, sampleRate: number, channels: number, durationSec: number,
): Promise<{ pcm: Uint8Array; frames: number }> {
  const bytesPerFrame = channels * 4;
  // A second of slack absorbs container/stream duration disagreement.
  const estimate = Math.max(1, Math.ceil((durationSec + 1) * sampleRate)) * bytesPerFrame;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-v', 'error',
      '-i', filePath,
      '-map', '0:a:0',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ac', String(channels),
      '-ar', String(sampleRate),
      '-',
    ], { windowsHide: true });

    let buffer = Buffer.allocUnsafe(estimate);
    let written = 0;
    let err = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (written + chunk.length > buffer.length) {
        // The probe under-read the duration.  Grow once, generously.
        const grown = Buffer.allocUnsafe(Math.max(buffer.length * 2, written + chunk.length));
        buffer.copy(grown, 0, 0, written);
        buffer = grown;
      }
      chunk.copy(buffer, written);
      written += chunk.length;
    });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
        return;
      }
      const frames = Math.floor(written / bytesPerFrame);
      if (frames <= 0) { reject(new Error('디코딩 결과가 비어 있습니다')); return; }
      resolve({ pcm: buffer.subarray(0, frames * bytesPerFrame), frames });
    });
  });
}

export function registerDecodeHandlers(ipc: IpcMain, packaged: boolean, resourcesPath: string): void {
  const binOpts = { packaged, resourcesPath };

  ipc.handle('daw:decode-pcm', async (_e, req: unknown): Promise<DecodePcmResult> => {
    const request = req as Partial<DecodePcmRequest> | undefined;
    const filePath = request?.path;
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new Error('daw:decode-pcm: path must be a non-empty string');
    }
    const resolved = path.resolve(filePath);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('daw:decode-pcm: not a regular file');

    const sampleRate = Number(request?.sampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384_000) {
      throw new Error('daw:decode-pcm: sampleRate out of range');
    }

    const ffprobeBin = resolveFFprobePath(binOpts);
    const ffmpegBin = resolveFFmpegPath(binOpts);

    const info = await probe(ffprobeBin, resolved);
    if (info.durationSec > MAX_SECONDS) {
      throw new Error(`daw:decode-pcm: ${Math.round(info.durationSec / 60)}분짜리 파일은 너무 깁니다`);
    }

    const { pcm, frames } = await decodeToPcm(
      ffmpegBin, resolved, sampleRate, info.channels, info.durationSec,
    );
    log.info(`[decode] ${path.basename(resolved)} → ${frames} frames × ${info.channels}ch @ ${sampleRate}`);
    return { sampleRate, channels: info.channels, frames, pcm };
  });
}
