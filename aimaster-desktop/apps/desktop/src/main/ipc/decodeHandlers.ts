/**
 * PCM decoding for the DAW — done by FFmpeg in the main process.
 *
 * The renderer used to call `AudioContext.decodeAudioData` on every file it
 * needed.  That is native Chromium code, and on macOS it takes the whole
 * renderer process down with SIGSEGV on real songs:
 *
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
 * ── Why the samples travel through a file and not the IPC reply ────────────
 * A four-minute stereo song is 92 MB of float32.  Returning that from
 * `ipcMain.handle` costs ~4.5 s — it is structure-cloned and copied several
 * times on the way — against 1.4 s for FFmpeg to decode the song in the first
 * place.  Eight stems spent most of a minute in serialisation alone.
 *
 * FFmpeg writes straight to a scratch file instead, and the renderer reads it
 * over the `aimaster-local://` protocol, which streams.  Main never holds the
 * samples at all, and the frame count comes from the file size — exact,
 * where the old path had to guess the length from the probed duration.
 *
 * It also decodes more than Chromium does: whatever FFmpeg reads, the DAW now
 * opens.
 */

import { app, type IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
  /** Scratch file holding interleaved float32.  Release it when you are done. */
  pcmPath: string;
}

/** Stereo is the ceiling: the DAW's clip model is mono or stereo. */
const MAX_CHANNELS = 2;
/** Refuse absurd inputs rather than trying to hold them in memory. */
const MAX_SECONDS = 3 * 60 * 60;
/** A scratch file this old belongs to a renderer that died before releasing it. */
const STALE_MS = 10 * 60 * 1000;

function scratchDir(): string {
  return path.join(app.getPath('temp'), 'loui-pcm');
}

/** Delete scratch files a previous run (or a crashed renderer) left behind. */
function sweepScratch(everything = false): void {
  const dir = scratchDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!everything && now - fs.statSync(file).mtimeMs < STALE_MS) continue;
      fs.unlinkSync(file);
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

export function registerDecodeHandlers(ipc: IpcMain, packaged: boolean, resourcesPath: string): void {
  const binOpts = { packaged, resourcesPath };
  sweepScratch(true);
  app.on('will-quit', () => sweepScratch(true));

  ipc.handle('daw:decode-pcm', async (_e, req: unknown): Promise<DecodePcmResult> => {
    const request = req as Partial<DecodePcmRequest> | undefined;
    const filePath = request?.path;
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new Error('daw:decode-pcm: path must be a non-empty string');
    }
    const resolved = path.resolve(filePath);
    if (!(await fs.promises.stat(resolved)).isFile()) {
      throw new Error('daw:decode-pcm: not a regular file');
    }

    const sampleRate = Number(request?.sampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384_000) {
      throw new Error('daw:decode-pcm: sampleRate out of range');
    }

    const info = await probe(resolveFFprobePath(binOpts), resolved);
    if (info.durationSec > MAX_SECONDS) {
      throw new Error(`daw:decode-pcm: ${Math.round(info.durationSec / 60)}분짜리 파일은 너무 깁니다`);
    }

    sweepScratch();
    const dir = scratchDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const pcmPath = path.join(dir, `${crypto.randomUUID()}.f32`);

    try {
      await runFFmpeg(resolveFFmpegPath(binOpts), [
        '-v', 'error',
        '-i', resolved,
        '-map', '0:a:0',
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ac', String(info.channels),
        '-ar', String(sampleRate),
        '-y', pcmPath,
      ]);
      // The file size IS the frame count — no estimate, no slack.
      const bytes = (await fs.promises.stat(pcmPath)).size;
      const frames = Math.floor(bytes / (info.channels * 4));
      if (frames <= 0) throw new Error('디코딩 결과가 비어 있습니다');

      log.info(`[decode] ${path.basename(resolved)} → ${frames} frames × ${info.channels}ch @ ${sampleRate}`);
      return { sampleRate, channels: info.channels, frames, pcmPath };
    } catch (err) {
      await fs.promises.rm(pcmPath, { force: true }).catch(() => { /* never written */ });
      throw err;
    }
  });

  /** The renderer has the samples; the scratch file can go. */
  ipc.handle('daw:release-pcm', async (_e, pcmPath: unknown): Promise<void> => {
    if (typeof pcmPath !== 'string') return;
    const resolved = path.resolve(pcmPath);
    // Only ever delete inside our own scratch directory.
    const dir = scratchDir() + path.sep;
    if (!resolved.startsWith(dir)) return;
    await fs.promises.rm(resolved, { force: true }).catch(() => { /* already gone */ });
  });
}
