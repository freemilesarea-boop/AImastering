import { describe, it, expect, vi } from 'vitest';
import {
  HTDEMUCS_MANIFEST, isModelConfigured, modelPath, modelDir,
  verifyCachedModel, ensureModel, parseManifest, resolveManifest,
  manifestSidecarPath, type StemModelManifest, type ModelFsDeps, type ManifestSource,
} from './stem-model-manager.js';

const PINNED: StemModelManifest = {
  id: 'htdemucs-v4', fileName: 'htdemucs.onnx',
  url: 'https://example.invalid/htdemucs.onnx',
  sha256: 'a'.repeat(64), bytes: 4, modelSampleRate: 44100,
};

function fakeFs(over: Partial<ModelFsDeps> = {}): ModelFsDeps {
  return {
    exists: async () => false,
    mkdirp: async () => {},
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    sha256Hex: async () => 'a'.repeat(64),
    download: async () => new Uint8Array([1, 2, 3, 4]),
    ...over,
  };
}

describe('stem-model-manager', () => {
  it('the bundled placeholder manifest is NOT configured (precise tier gated off)', () => {
    expect(isModelConfigured(HTDEMUCS_MANIFEST)).toBe(false);
    expect(isModelConfigured(PINNED)).toBe(true);
  });

  it('derives a stable per-model cache path under userData', () => {
    expect(modelDir('/u', PINNED).endsWith('models/htdemucs-v4')).toBe(true);
    expect(modelPath('/u', PINNED).endsWith('models/htdemucs-v4/htdemucs.onnx')).toBe(true);
  });

  it('verifyCachedModel matches only on present file + correct size + checksum', async () => {
    expect(await verifyCachedModel('/p', PINNED, fakeFs({ exists: async () => false }))).toBe(false);
    // wrong size
    expect(await verifyCachedModel('/p', PINNED, fakeFs({ exists: async () => true, readFile: async () => new Uint8Array(2) }))).toBe(false);
    // right size, wrong hash
    expect(await verifyCachedModel('/p', PINNED, fakeFs({ exists: async () => true, readFile: async () => new Uint8Array(4), sha256Hex: async () => 'b'.repeat(64) }))).toBe(false);
    // right size + hash
    expect(await verifyCachedModel('/p', PINNED, fakeFs({ exists: async () => true, readFile: async () => new Uint8Array(4) }))).toBe(true);
  });

  it('ensureModel returns null (and never downloads) when unconfigured', async () => {
    const dl = vi.fn(async () => new Uint8Array());
    expect(await ensureModel('/u', fakeFs({ download: dl }), HTDEMUCS_MANIFEST)).toBeNull();
    expect(dl).not.toHaveBeenCalled();
  });

  it('ensureModel uses the cache without downloading when already valid', async () => {
    const dl = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const path = await ensureModel('/u', fakeFs({ exists: async () => true, readFile: async () => new Uint8Array(4), download: dl }), PINNED);
    expect(path).toBe(modelPath('/u', PINNED));
    expect(dl).not.toHaveBeenCalled();
  });

  it('ensureModel downloads, verifies checksum, and writes the cache', async () => {
    const write = vi.fn(async () => {});
    const path = await ensureModel('/u', fakeFs({ writeFile: write }), PINNED);
    expect(path).toBe(modelPath('/u', PINNED));
    expect(write).toHaveBeenCalledOnce();
  });

  it('ensureModel rejects a checksum mismatch (corrupt download)', async () => {
    await expect(ensureModel('/u', fakeFs({ sha256Hex: async () => 'b'.repeat(64) }), PINNED)).rejects.toThrow(/checksum/);
  });

  it('ensureModel rejects a size mismatch', async () => {
    await expect(ensureModel('/u', fakeFs({ download: async () => new Uint8Array([1, 2]) }), PINNED)).rejects.toThrow(/size/);
  });
});

describe('sidecar manifest (pin without a code edit)', () => {
  const validJson = JSON.stringify(PINNED);

  it('parseManifest accepts a well-formed manifest and lowercases the hash', () => {
    const m = parseManifest({ ...PINNED, sha256: 'A'.repeat(64) });
    expect(m).not.toBeNull();
    expect(m!.sha256).toBe('a'.repeat(64));
  });

  it('parseManifest rejects malformed shapes', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ ...PINNED, bytes: 'x' })).toBeNull();           // wrong type
    expect(parseManifest({ ...PINNED, sha256: 'zz' })).toBeNull();          // not 64-hex
    expect(parseManifest({ ...PINNED, modelSampleRate: 0 })).toBeNull();    // non-positive rate
    expect(parseManifest({ ...PINNED, fileName: '../evil.onnx' })).toBeNull(); // path traversal
  });

  it('parseManifest allows an intentionally-empty sha256 (unpinned)', () => {
    const m = parseManifest({ ...PINNED, sha256: '' });
    expect(m).not.toBeNull();
    expect(isModelConfigured(m!)).toBe(false);
  });

  it('manifestSidecarPath lives under the model cache dir', () => {
    expect(manifestSidecarPath('/u').endsWith('models/stem-model.manifest.json')).toBe(true);
  });

  it('resolveManifest returns the bundled placeholder when no sidecar present', async () => {
    const src: ManifestSource = { readText: async () => null };
    expect(await resolveManifest('/u/x.json', src)).toEqual(HTDEMUCS_MANIFEST);
    expect(await resolveManifest(null, src)).toEqual(HTDEMUCS_MANIFEST);
  });

  it('resolveManifest applies a valid sidecar override', async () => {
    const src: ManifestSource = { readText: async () => validJson };
    const m = await resolveManifest('/u/x.json', src);
    expect(isModelConfigured(m)).toBe(true);
    expect(m.sha256).toBe(PINNED.sha256);
  });

  it('resolveManifest falls back to placeholder on malformed JSON / bad shape', async () => {
    expect(await resolveManifest('/u/x.json', { readText: async () => '{not json' })).toEqual(HTDEMUCS_MANIFEST);
    expect(await resolveManifest('/u/x.json', { readText: async () => '{"id":"x"}' })).toEqual(HTDEMUCS_MANIFEST);
    expect(await resolveManifest('/u/x.json', { readText: async () => { throw new Error('io'); } })).toEqual(HTDEMUCS_MANIFEST);
  });
});
