// Rust offline file render (RUST-OFFLINE-RENDER-1).
//
// Decode → run the Rust MasteringChain over the whole file → encode WAV,
// using the bundled ffmpeg for I/O.  Additive + experimental: callers fall
// back to the Python `audio:master` on any failure.
//
// NOTE: this runs in the Electron MAIN process and needs ffmpeg + the
// node-target WASM build; it is exercised on-device (the parity harness
// validates the DSP core headlessly).

import { spawn } from 'node:child_process';
import { resolveFFmpegPath, resolveFFprobePath } from '@aimaster/audio-engine';
import {
  renderStereoBuffer, renderStereoBufferNormalized, deinterleave, interleave,
  type RenderMetrics, type NormalizedRenderMetrics,
} from './rust-offline-render-core.js';
import { loadWasmModule, type OfflineChainConfig } from './load-mastering-chain-node.js';
import { applyPreciseRebalance, type PreciseRebalanceOptions } from './precise-rebalance.js';
import { applySectionPlan } from './section-mastering.js';
import { applyVocalRiding } from './vocal-riding.js';
import { deinterleaveN, foldDownToStereo, layoutForChannelCount } from './surround.js';
import type { SectionMasteringPlan, VocalRidingPlan, SurroundTrims } from '@aimaster/shared-types';

export interface RustRenderOptions {
  sampleRate: number;
  bitDepth: 16 | 24;
  outputPath: string;
  /** When set, two-pass loudness-normalize toward this target (LUFS). */
  targetLufs?: number;
  /** True-peak ceiling (dBTP) — enforced by the chain limiter. */
  targetTp?: number;
  /** Max upward loudness gain (dB).  Default +12. */
  maxBoostDb?: number;
  /** Optional precise stem rebalance (no-op unless a model is installed). */
  rebalance?: PreciseRebalanceOptions;
  /** Optional per-section gain automation (no-op when unity). */
  sectionPlan?: SectionMasteringPlan;
  /** Optional automatic vocal level riding (no-op when unity). */
  vocalRiding?: VocalRidingPlan;
  /** Optional surround fold-down (5.1/7.1 → stereo) before the chain. */
  surround?: { foldDownEnabled: boolean; trims: SurroundTrims };
  onProgress?: (frac: number) => void;
}

export interface RustRenderFileResult {
  outputPath: string;
  metrics: RenderMetrics | NormalizedRenderMetrics;
  backend: 'rust';
  loudnessNormalized: boolean;
}

/** Whether the Rust offline backend is usable (node WASM present). */
export function isRustOfflineAvailable(): boolean {
  return loadWasmModule() !== null;
}

function runFfmpeg(args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = resolveFFmpegPath();
    // shell:false (the spawn default, set explicitly to match audioTranscode):
    // the binary path + args go straight to CreateProcess/execvp, so paths
    // with spaces or non-ASCII (Korean) chars are never re-parsed by a shell.
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`));
    });
    if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

/** Decode any input → interleaved f32le stereo PCM at `sampleRate`. */
async function decodeToFloatStereo(inputPath: string, sampleRate: number): Promise<Float32Array> {
  const buf = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(sampleRate),
    'pipe:1',
  ]);
  // Buffer → Float32Array (handle non-aligned length defensively).
  const usable = buf.byteLength - (buf.byteLength % 4);
  return new Float32Array(buf.buffer, buf.byteOffset, usable / 4);
}

/** Probe the channel count of the first audio stream via ffprobe (default 2). */
async function probeChannelCount(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    let bin: string;
    try { bin = resolveFFprobePath(); } catch { resolve(2); return; }
    const child = spawn(bin, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'csv=p=0', inputPath,
    ], { shell: false, windowsHide: true });
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', () => resolve(2));
    child.on('close', () => {
      const n = parseInt(Buffer.concat(out).toString().trim(), 10);
      resolve(Number.isFinite(n) && n > 0 ? n : 2);
    });
  });
}

/** Decode any input → interleaved f32le with its native channel count. */
async function decodeToFloatN(inputPath: string, channels: number, sampleRate: number): Promise<Float32Array> {
  const buf = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(channels), '-ar', String(sampleRate),
    'pipe:1',
  ]);
  const usable = buf.byteLength - (buf.byteLength % 4);
  return new Float32Array(buf.buffer, buf.byteOffset, usable / 4);
}

/**
 * Fold a surround source down to stereo (BS.775 + trims).  Returns null when the
 * source is stereo / an unsupported channel count → caller decodes stereo
 * normally.
 */
async function foldDownSurroundSource(
  inputPath: string,
  sampleRate: number,
  trims: SurroundTrims,
): Promise<{ left: Float32Array; right: Float32Array } | null> {
  const channels = await probeChannelCount(inputPath);
  const layout = layoutForChannelCount(channels);
  if (!layout || layout === 'stereo') return null;
  const interleaved = await decodeToFloatN(inputPath, channels, sampleRate);
  return foldDownToStereo(deinterleaveN(interleaved, channels), layout, trims);
}

/** Encode interleaved f32le stereo → WAV at the target bit depth. */
async function encodeWav(interleaved: Float32Array, sampleRate: number, bitDepth: 16 | 24, outputPath: string): Promise<void> {
  const codec = bitDepth === 16 ? 'pcm_s16le' : 'pcm_s24le';
  const stdin = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0',
    '-c:a', codec, outputPath,
  ], stdin);
}

/** Encode a WAV → 320 kbps MP3 preview (reuses the bundled ffmpeg). */
export async function encodePreviewMp3(wavPath: string, mp3Path: string): Promise<void> {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '320k', mp3Path,
  ]);
}

/**
 * Render a file through the Rust MasteringChain offline.  Throws on any
 * failure (caller falls back to the Python engine).
 */
export async function processAudioFileRust(
  inputPath: string,
  config: OfflineChainConfig,
  options: RustRenderOptions,
): Promise<RustRenderFileResult> {
  if (!isRustOfflineAvailable()) throw new Error('rust offline backend unavailable (node WASM not built)');

  let left: Float32Array;
  let right: Float32Array;

  // Surround (5.1 / 7.1) source → standard BS.775 fold-down to stereo, then the
  // normal stereo chain.  Falls back to plain stereo decode when disabled, when
  // the source is already stereo, or when the channel probe fails.
  const folded = options.surround?.foldDownEnabled
    ? await foldDownSurroundSource(inputPath, options.sampleRate, options.surround.trims).catch(() => null)
    : null;
  if (folded) {
    left = folded.left; right = folded.right;
  } else {
    const interleavedIn = await decodeToFloatStereo(inputPath, options.sampleRate);
    const deint = deinterleave(interleavedIn, 2);
    left = deint.left;
    right = deint.right;
  }

  // Precise stem rebalance (Demucs/ONNX) — runs BEFORE the mastering chain.
  // No-op (and no model download) unless explicitly enabled with a model present.
  if (options.rebalance?.enabled) {
    const rb = await applyPreciseRebalance(left, right, options.sampleRate, options.rebalance, options.onProgress);
    left = rb.left; right = rb.right;
  }

  // Per-section gain automation — pre-chain so the chain glues the sections.
  if (options.sectionPlan?.enabled) {
    const sec = applySectionPlan(left, right, options.sampleRate, options.sectionPlan);
    left = sec.left; right = sec.right;
  }

  // Automatic vocal (centre) level riding — pre-chain, sides preserved.
  if (options.vocalRiding?.enabled) {
    const vr = applyVocalRiding(left, right, options.sampleRate, options.vocalRiding);
    left = vr.left; right = vr.right;
  }

  const normalized = typeof options.targetLufs === 'number';
  let outL: Float32Array, outR: Float32Array;
  let metrics: RenderMetrics | NormalizedRenderMetrics;
  if (normalized) {
    const r = renderStereoBufferNormalized(left, right, config, options.sampleRate, {
      targetLufs: options.targetLufs!,
      targetTp: options.targetTp ?? -1,
      ...(options.maxBoostDb !== undefined ? { maxBoostDb: options.maxBoostDb } : {}),
    }, 512, options.onProgress);
    outL = r.left; outR = r.right; metrics = r.metrics;
  } else {
    const r = renderStereoBuffer(left, right, config, options.sampleRate, 512, options.onProgress);
    outL = r.left; outR = r.right; metrics = r.metrics;
  }

  const interleavedOut = interleave(outL, outR);
  await encodeWav(interleavedOut, options.sampleRate, options.bitDepth, options.outputPath);
  return { outputPath: options.outputPath, metrics, backend: 'rust', loudnessNormalized: normalized };
}
