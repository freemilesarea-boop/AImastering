// stem-separation — backend-agnostic stem separator for the PRECISE rebalance
// tier (Phase 3).  See docs/STEM_SEPARATION_PLAN.md for the full design.
//
// The renderer's approximation tier (M/S vocal/bass/side) ships and runs today
// with zero ML.  The PRECISE tier — true 4-stem (vocals/drums/bass/other)
// separation à la Demucs — is gated behind this interface so the rest of the
// export path never needs to know which backend (or none) is installed.
//
// Contract: a separator takes interleaved-free stereo PCM and returns four
// stems whose 0 dB sum reconstructs the input (Demucs stems are additive).  If
// no model is installed, `getStemSeparator()` returns null and the caller falls
// back to the approximation tier — so this file is import-safe even though the
// ONNX runtime is an OPTIONAL dependency that may be absent.

import {
  planSegments, hannWindow, overlapAddWeighted, resampleLinear, type Segment,
} from './stem-inference.js';
import {
  HTDEMUCS_MANIFEST, isModelConfigured, nodeModelFsDeps, ensureModel,
  resolveManifest, manifestSidecarPath, nodeManifestSource,
  type StemModelManifest,
} from './stem-model-manager.js';

export type StemId = 'vocals' | 'drums' | 'bass' | 'other';
export const STEM_ORDER: StemId[] = ['vocals', 'drums', 'bass', 'other'];

export interface StereoBuffer {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export type SeparatedStems = Record<StemId, StereoBuffer>;

export interface StemSeparator {
  /** Stable id for logging / telemetry (e.g. "onnx-demucs-v4"). */
  readonly id: string;
  /** True once the model weights are present and the runtime can load them. */
  isReady(): Promise<boolean>;
  /** Separate a stereo mix into 4 additive stems. */
  separate(input: StereoBuffer, onProgress?: (frac: number) => void): Promise<SeparatedStems>;
}

// ── ONNX Demucs backend ──────────────────────────────────────────────────────
//
// Runtime: onnxruntime-node, loaded lazily via `await import` so a missing /
// failed native addon never breaks app startup — it just leaves the separator
// un-ready and the caller falls back to the approximation tier.  The model is
// downloaded on first use (see stem-model-manager.ts).

/** ~7.8 s segments with 25% overlap is Demucs' default recombination window. */
const SEGMENT_SECONDS = 7.8;
const OVERLAP = 0.25;

interface OrtLike {
  InferenceSession: {
    create(path: string, opts?: unknown): Promise<OrtSessionLike>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensorLike;
}
interface OrtTensorLike { data: Float32Array; dims: number[]; }
interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}

async function loadOrt(): Promise<OrtLike | null> {
  try {
    // Optional dependency — may not be installed.  The specifier is assembled at
    // runtime so the bundler/test transformer never tries to resolve it
    // statically (it is loaded only on-device when the precise tier is active).
    const spec = ['onnxruntime', 'node'].join('-');
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as OrtLike;
    return mod?.InferenceSession ? mod : null;
  } catch {
    return null;
  }
}

/** Side effects the separator needs — injectable so `separate()` is testable. */
export interface OnnxDeps {
  loadOrt(): Promise<OrtLike | null>;
  ensureModelPath(
    userDataDir: string,
    manifest: StemModelManifest,
    onProgress?: (frac: number) => void,
  ): Promise<string | null>;
}

const defaultDeps: OnnxDeps = {
  loadOrt,
  ensureModelPath: (userDataDir, manifest, onProgress) =>
    ensureModel(userDataDir, nodeModelFsDeps(), manifest, onProgress),
};

export class OnnxStemSeparator implements StemSeparator {
  readonly id = 'onnx-demucs-v4';
  private session: OrtSessionLike | null = null;
  private ort: OrtLike | null = null;

  constructor(
    private readonly userDataDir: string,
    private readonly manifest: StemModelManifest = HTDEMUCS_MANIFEST,
    private readonly deps: OnnxDeps = defaultDeps,
  ) {}

  async isReady(): Promise<boolean> {
    if (!isModelConfigured(this.manifest)) return false; // weights not pinned yet
    if (!this.ort) this.ort = await this.deps.loadOrt();
    return this.ort !== null;
  }

  private async ensureSession(onProgress?: (frac: number) => void): Promise<OrtSessionLike> {
    if (this.session) return this.session;
    const ort = this.ort ?? (this.ort = await this.deps.loadOrt());
    if (!ort) throw new Error('onnxruntime-node not available');
    const path = await this.deps.ensureModelPath(this.userDataDir, this.manifest, onProgress);
    if (!path) throw new Error('stem model not configured');
    this.session = await ort.InferenceSession.create(path);
    return this.session;
  }

  async separate(input: StereoBuffer, onProgress?: (frac: number) => void): Promise<SeparatedStems> {
    const ort = this.ort ?? (this.ort = await this.deps.loadOrt());
    if (!ort) throw new Error('onnxruntime-node not available');
    const session = await this.ensureSession(onProgress);

    const sr = this.manifest.modelSampleRate;
    // Resample stereo to the model's native rate.
    const L = resampleLinear(input.left, input.sampleRate, sr);
    const R = resampleLinear(input.right, input.sampleRate, sr);
    const total = Math.min(L.length, R.length);

    // Fixed-segment models (Demucs default) need every input padded to exactly
    // `segmentSamples`; a 0/omitted value means the graph accepts native lengths.
    const fixed = this.manifest.segmentSamples && this.manifest.segmentSamples > 0
      ? this.manifest.segmentSamples : 0;
    const segLen = fixed || Math.max(1, Math.round(SEGMENT_SECONDS * sr));
    const hop = Math.max(1, Math.round(segLen * (1 - OVERLAP)));
    const segments = planSegments(total, segLen, hop);

    const segOut: Record<StemId, { l: Float32Array[]; r: Float32Array[] }> = {
      vocals: { l: [], r: [] }, drums: { l: [], r: [] }, bass: { l: [], r: [] }, other: { l: [], r: [] },
    };
    const weights: Float32Array[] = [];

    const inName = session.inputNames[0] ?? 'mix';
    const outName = session.outputNames[0] ?? 'stems';

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s]!;
      const win = hannWindow(seg.length);
      weights.push(win);

      // Feed [1, 2, modelLen]; pad short segments with zeros for fixed graphs.
      const modelLen = fixed || seg.length;
      const buf = new Float32Array(2 * modelLen);
      buf.set(L.subarray(seg.start, seg.start + seg.length), 0);
      buf.set(R.subarray(seg.start, seg.start + seg.length), modelLen);
      const tensor = new ort.Tensor('float32', buf, [1, 2, modelLen]);

      const result = await session.run({ [inName]: tensor });
      const out = result[outName] ?? Object.values(result)[0]!;
      // Output [1, 4, 2, modelLen] (sources, channels, samples) — crop to seg.length.
      this.scatterStems(out.data, modelLen, seg.length, segOut);

      onProgress?.((s + 1) / segments.length);
    }

    const make = (acc: { l: Float32Array[]; r: Float32Array[] }): StereoBuffer => ({
      left: overlapAddWeighted(total, segments, acc.l, weights),
      right: overlapAddWeighted(total, segments, acc.r, weights),
      sampleRate: sr,
    });
    return {
      vocals: make(segOut.vocals), drums: make(segOut.drums),
      bass: make(segOut.bass), other: make(segOut.other),
    };
  }

  /**
   * Split a [1,4,2,modelLen] flat output into per-stem L/R slices, cropped to
   * the segment's real length (`cropLen` ≤ `modelLen` for padded segments).
   */
  private scatterStems(
    data: Float32Array,
    modelLen: number,
    cropLen: number,
    segOut: Record<StemId, { l: Float32Array[]; r: Float32Array[] }>,
  ): void {
    const chStride = modelLen;
    const srcStride = 2 * modelLen;
    for (let src = 0; src < STEM_ORDER.length; src++) {
      const base = src * srcStride;
      const stem = STEM_ORDER[src]!;
      segOut[stem].l.push(data.slice(base, base + cropLen));
      segOut[stem].r.push(data.slice(base + chStride, base + chStride + cropLen));
    }
  }
}

/**
 * Resolve the active stem separator, or null when none is installed.  Callers
 * MUST treat null as "use the approximation tier" rather than an error — the
 * precise tier is strictly opt-in and additive.
 */
export async function getStemSeparator(userDataDir: string): Promise<StemSeparator | null> {
  // A pinned sidecar manifest (written by `pin:stem-model`) overrides the
  // bundled placeholder, so the model can be enabled without a code change.
  const manifest = await resolveManifest(manifestSidecarPath(userDataDir), nodeManifestSource());
  const sep = new OnnxStemSeparator(userDataDir, manifest);
  return (await sep.isReady()) ? sep : null;
}

/** Whether the precise tier can run — drives the UI gate (replaces a const). */
export interface StemPreciseAvailability {
  /** A real model manifest is pinned (sidecar or bundled). */
  modelConfigured: boolean;
  /** onnxruntime-node loads in this build. */
  runtimeAvailable: boolean;
  /** Both → the precise tier is usable (model downloads on first use). */
  available: boolean;
}

export async function getStemPreciseAvailability(userDataDir: string): Promise<StemPreciseAvailability> {
  const manifest = await resolveManifest(manifestSidecarPath(userDataDir), nodeManifestSource());
  const modelConfigured = isModelConfigured(manifest);
  // Only probe the (optional, possibly heavy) runtime once a model is pinned.
  const runtimeAvailable = modelConfigured ? (await loadOrt()) !== null : false;
  return { modelConfigured, runtimeAvailable, available: modelConfigured && runtimeAvailable };
}

export type { Segment };
