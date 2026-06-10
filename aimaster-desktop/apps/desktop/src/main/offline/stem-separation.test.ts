import { describe, it, expect } from 'vitest';
import { getStemSeparator, getStemPreciseAvailability, OnnxStemSeparator, STEM_ORDER, type OnnxDeps } from './stem-separation.js';
import type { StemModelManifest } from './stem-model-manager.js';

describe('stem-separation (gating)', () => {
  it('STEM_ORDER matches the Demucs source order', () => {
    expect(STEM_ORDER).toEqual(['vocals', 'drums', 'bass', 'other']);
  });

  it('getStemSeparator returns null while the model manifest is unpinned', async () => {
    expect(await getStemSeparator('/tmp/userData')).toBeNull();
  });

  it('OnnxStemSeparator is not ready without a configured model', async () => {
    const sep = new OnnxStemSeparator('/tmp/userData');
    expect(sep.id).toBe('onnx-demucs-v4');
    expect(await sep.isReady()).toBe(false);
  });

  it('getStemPreciseAvailability reports unavailable while the model is unpinned', async () => {
    const a = await getStemPreciseAvailability('/tmp/userData');
    expect(a.modelConfigured).toBe(false);
    expect(a.available).toBe(false);
    // Runtime is not even probed until a model is configured.
    expect(a.runtimeAvailable).toBe(false);
  });
});

// ── End-to-end inference loop with a FAKE ort runtime ───────────────────────
// The fake model splits the mix into four equal stems (mix/4 each), so an
// additive sum of the separated stems must reconstruct the original mix.  This
// exercises segmentation, (zero-)padding, [1,4,2,len] scatter, crop, and WOLA.

function fakeOrt(): unknown {
  return {
    InferenceSession: {
      create: async () => ({
        inputNames: ['mix'],
        outputNames: ['stems'],
        run: async (feeds: Record<string, { data: Float32Array; dims: number[] }>) => {
          const t = feeds['mix']!;
          const len = t.dims[2]!; // [1, 2, len]
          const out = new Float32Array(4 * 2 * len);
          for (let s = 0; s < 4; s++) {
            for (let c = 0; c < 2; c++) {
              for (let i = 0; i < len; i++) out[(s * 2 + c) * len + i] = t.data[c * len + i]! / 4;
            }
          }
          return { stems: { data: out, dims: [1, 4, 2, len] } };
        },
      }),
    },
    Tensor: class { data: Float32Array; dims: number[]; constructor(_t: string, data: Float32Array, dims: number[]) { this.data = data; this.dims = dims; } },
  };
}

const fakeDeps: OnnxDeps = {
  loadOrt: async () => fakeOrt() as never,
  ensureModelPath: async () => '/fake/model.onnx',
};

const manifest = (over: Partial<StemModelManifest> = {}): StemModelManifest => ({
  id: 'fake', fileName: 'm.onnx', url: 'https://h/m.onnx', sha256: 'a'.repeat(64),
  bytes: 1, modelSampleRate: 48000, segmentSamples: 0, ...over,
});

describe('OnnxStemSeparator.separate (fake runtime)', () => {
  const mk = (n: number, f: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * f));

  it('additive stems reconstruct the mix (dynamic length, sr match)', async () => {
    const L = mk(2048, 0.05), R = mk(2048, 0.07);
    const sep = new OnnxStemSeparator('/u', manifest(), fakeDeps);
    const stems = await sep.separate({ left: L, right: R, sampleRate: 48000 });
    const sumL = new Float32Array(L.length);
    for (const id of STEM_ORDER) for (let i = 0; i < L.length; i++) sumL[i]! += stems[id].left[i]!;
    for (let i = 0; i < L.length; i++) expect(sumL[i]!).toBeCloseTo(L[i]!, 4);
  });

  it('reports progress and emits 4 stems of the right length', async () => {
    const L = mk(3000, 0.05), R = mk(3000, 0.05);
    let last = 0;
    const sep = new OnnxStemSeparator('/u', manifest({ segmentSamples: 1024 }), fakeDeps);
    const stems = await sep.separate({ left: L, right: R, sampleRate: 48000 }, (f) => { last = f; });
    expect(last).toBeCloseTo(1, 6);
    for (const id of STEM_ORDER) expect(stems[id].left.length).toBe(L.length);
  });

  it('fixed-segment padding/crop still reconstructs (segment > total)', async () => {
    const L = mk(500, 0.05), R = mk(500, 0.05);
    const sep = new OnnxStemSeparator('/u', manifest({ segmentSamples: 2048 }), fakeDeps); // pads
    const stems = await sep.separate({ left: L, right: R, sampleRate: 48000 });
    const sumR = new Float32Array(R.length);
    for (const id of STEM_ORDER) for (let i = 0; i < R.length; i++) sumR[i]! += stems[id].right[i]!;
    for (let i = 0; i < R.length; i++) expect(sumR[i]!).toBeCloseTo(R[i]!, 4);
  });

  it('throws a clear error when the runtime is unavailable', async () => {
    const sep = new OnnxStemSeparator('/u', manifest(), { loadOrt: async () => null, ensureModelPath: async () => '/fake' });
    await expect(sep.separate({ left: new Float32Array(8), right: new Float32Array(8), sampleRate: 48000 }))
      .rejects.toThrow(/onnxruntime-node not available/);
  });
});
