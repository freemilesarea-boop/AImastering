// Audio transcode helper (M3-P-NEXT-5D-2-d).
//
// Builds ffmpeg argument arrays + spawns ffmpeg to transcode a source
// WAV into a target format / quality / dither.  Mirrors the audio-engine
// runner's spawn pattern (argument array, shell:false, Unicode-safe).
//
// This module does NOT touch the Python pipeline or file:save-wav.  It is
// used only by the new file:save-audio handler.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { resolveFFmpegPath } from '@aimaster/audio-engine';
import type { ExportFormat, ExportDither } from '@aimaster/shared-types';

export interface TranscodeSpec {
  format: ExportFormat;
  sampleRate?: number | undefined;
  bitDepth?: number | undefined;
  dither?: ExportDither | undefined;
}

export interface TranscodePlan {
  /** ffmpeg argument array (excluding the leading binary). */
  args: string[];
  /** File extension for the output (no dot). */
  ext: string;
  /** Non-fatal note (e.g. dither/bitDepth ignored). */
  warning?: string;
  /** Whether bit-depth / dither apply for this format. */
  pcm: boolean;
}

const EXT_BY_FORMAT: Record<ExportFormat, string> = {
  wav: 'wav', flac: 'flac', mp3: 'mp3', aiff: 'aiff', ogg: 'ogg',
};

/** PCM sample_fmt / codec selection for lossless formats. */
function pcmCodec(format: 'wav' | 'aiff', bitDepth: number): string {
  const be = format === 'aiff';
  if (bitDepth === 32) return be ? 'pcm_f32be' : 'pcm_f32le';
  if (bitDepth === 24) return be ? 'pcm_s24be' : 'pcm_s24le';
  return be ? 'pcm_s16be' : 'pcm_s16le';   // default 16
}

/** ffmpeg dither_method for the aresample filter. */
function ditherMethod(dither: ExportDither | undefined): string | null {
  switch (dither) {
    case 'tpdf':   return 'triangular';
    case 'shaped': return 'shibata';
    case 'none':
    default:       return null;
  }
}

/**
 * Build the ffmpeg transcode plan for a target spec.  Pure — no spawn.
 * Validates format-specific applicability of bitDepth / dither and emits
 * a `warning` when they don't apply.
 */
export function buildTranscodePlan(spec: TranscodeSpec): TranscodePlan {
  const ext = EXT_BY_FORMAT[spec.format];
  const args: string[] = ['-y', '-i', '__IN__'];   // __IN__ replaced by caller
  const warnings: string[] = [];

  // Sample rate (all formats).
  if (typeof spec.sampleRate === 'number' && Number.isFinite(spec.sampleRate)) {
    args.push('-ar', String(spec.sampleRate));
  }

  const lossy = spec.format === 'mp3' || spec.format === 'ogg';
  const isFloat = spec.bitDepth === 32;

  if (lossy) {
    // Lossy — bit depth + dither not applicable.
    if (spec.bitDepth !== undefined) warnings.push(`Bit depth not applicable for ${spec.format.toUpperCase()} (lossy)`);
    if (spec.dither && spec.dither !== 'none') warnings.push(`Dither ignored for ${spec.format.toUpperCase()}`);
    if (spec.format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '320k');
    else                       args.push('-c:a', 'libvorbis', '-q:a', '6');
    return { args, ext, ...(warnings.length ? { warning: warnings.join('; ') } : {}), pcm: false };
  }

  // ── PCM / lossless (wav / aiff / flac) ──
  const depth = spec.bitDepth ?? 24;
  const dm = ditherMethod(spec.dither);

  if (spec.format === 'flac') {
    // FLAC: integer only, max 24-bit.
    const flacDepth = Math.min(depth, 24);
    if (depth === 32) warnings.push('FLAC max is 24-bit; exported at 24-bit');
    args.push('-c:a', 'flac', '-sample_fmt', flacDepth <= 16 ? 's16' : 's32');
    if (dm && flacDepth <= 24) args.push('-af', `aresample=dither_method=${dm}`);
  } else {
    // wav / aiff (flac + lossy handled above)
    args.push('-c:a', pcmCodec(spec.format as 'wav' | 'aiff', depth));
    if (isFloat) {
      if (spec.dither && spec.dither !== 'none') warnings.push('Dither ignored for 32-bit float');
    } else if (dm) {
      args.push('-af', `aresample=dither_method=${dm}`);
    }
  }

  return { args, ext, ...(warnings.length ? { warning: warnings.join('; ') } : {}), pcm: true };
}

/** Whether a spec needs ffmpeg at all (false → a plain copy suffices). */
export function needsTranscode(sourceExt: string, spec: TranscodeSpec): boolean {
  const srcIsWav = sourceExt.toLowerCase() === 'wav';
  if (spec.format !== 'wav' || !srcIsWav) return true;
  if (typeof spec.sampleRate === 'number') return true;
  if (typeof spec.bitDepth === 'number') return true;
  if (spec.dither && spec.dither !== 'none') return true;
  return false;
}

export interface TranscodeResult {
  outputPath: string;
  warning?: string;
}

/**
 * Transcode `sourcePath` to a temp file per `spec`.  Returns the temp
 * path.  Never overwrites the source.  Rejects on ffmpeg failure.
 */
export function transcodeToTemp(sourcePath: string, spec: TranscodeSpec): Promise<TranscodeResult> {
  const plan = buildTranscodePlan(spec);
  const outputPath = path.join(os.tmpdir(), `aimaster_export_${uuidv4()}.${plan.ext}`);
  const bin = resolveFFmpegPath();
  const args = plan.args.map((a) => (a === '__IN__' ? sourcePath : a));
  args.push(outputPath);

  return new Promise<TranscodeResult>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, env: process.env, windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg transcode timed out`));
    }, 300_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.split('\n').slice(-4).join(' ').trim();
        reject(new Error(`ffmpeg exited ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }
      resolve({ outputPath, ...(plan.warning ? { warning: plan.warning } : {}) });
    });
  });
}
