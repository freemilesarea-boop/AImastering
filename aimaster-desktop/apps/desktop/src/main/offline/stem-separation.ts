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
// back to the approximation tier — so this file is import-safe even though no
// ONNX runtime is bundled yet.

export type StemId = 'vocals' | 'drums' | 'bass' | 'other';

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

// ── ONNX Demucs backend (skeleton — not wired until the model ships) ─────────
//
// Planned implementation (see STEM_SEPARATION_PLAN.md):
//   • runtime  : onnxruntime-node (optionalDependency, lazy `await import`)
//   • model    : ONNX-exported HT-Demucs, downloaded on first use to userData
//   • inference: overlapping windowed STFT chunks, weighted-overlap-add
// Everything is deliberately stubbed so this module imports with no native deps.

export class OnnxStemSeparator implements StemSeparator {
  readonly id = 'onnx-demucs-v4';
  constructor(private readonly modelPath: string | null = null) {}

  async isReady(): Promise<boolean> {
    // No model bundled yet → never ready.  Once the download-on-first-use flow
    // lands this checks `fs.existsSync(this.modelPath)` AND that
    // `onnxruntime-node` resolves.
    return false;
  }

  async separate(): Promise<SeparatedStems> {
    throw new Error('OnnxStemSeparator: model not installed (precise stem separation unavailable). See docs/STEM_SEPARATION_PLAN.md.');
  }
}

/**
 * Resolve the active stem separator, or null when none is installed.  Callers
 * MUST treat null as "use the approximation tier" rather than an error — the
 * precise tier is strictly opt-in and additive.
 */
export async function getStemSeparator(): Promise<StemSeparator | null> {
  const sep = new OnnxStemSeparator();
  return (await sep.isReady()) ? sep : null;
}
