// stem-model-manager — download-on-first-use + verify for the ONNX Demucs model.
//
// The model weights are NOT bundled in the installer (they are large).  On the
// first precise render we fetch them to userData, checksum against a pinned
// manifest, and cache.  All side-effecting dependencies (fs, fetch, hash) are
// injectable so the orchestration is headless-testable without touching disk
// or the network.
//
// The model is not yet exported/published, so the manifest below is a
// PLACEHOLDER with an empty sha256 → `isModelConfigured()` returns false and
// the precise tier stays gated OFF.  Pinning a real url+sha256+bytes is the
// single switch that turns the download path on.

import { join } from 'node:path';

export interface StemModelManifest {
  /** Stable id (also the on-disk subdir). */
  id: string;
  /** Local filename for the cached weights. */
  fileName: string;
  /** HTTPS source for download-on-first-use. */
  url: string;
  /** Lowercase hex SHA-256 of the file.  Empty ⇒ not yet pinned. */
  sha256: string;
  /** Expected size in bytes (sanity check before hashing).  0 ⇒ unknown. */
  bytes: number;
  /** Sample rate the model expects (Demucs = 44.1 kHz). */
  modelSampleRate: number;
}

/** Pinned HT-Demucs (v4) manifest.  url/sha256/bytes TBD — see plan doc. */
export const HTDEMUCS_MANIFEST: StemModelManifest = {
  id: 'htdemucs-v4',
  fileName: 'htdemucs.onnx',
  url: '', // TODO: pin published ONNX weights URL
  sha256: '', // TODO: pin SHA-256 once exported
  bytes: 0,
  modelSampleRate: 44100,
};

/** A manifest is usable once it has both a source and a checksum pinned. */
export function isModelConfigured(m: StemModelManifest = HTDEMUCS_MANIFEST): boolean {
  return m.url.length > 0 && m.sha256.length === 64;
}

/** Directory under userData where model weights are cached. */
export function modelDir(userDataDir: string, m: StemModelManifest = HTDEMUCS_MANIFEST): string {
  return join(userDataDir, 'models', m.id);
}

/** Absolute path to the cached weights file. */
export function modelPath(userDataDir: string, m: StemModelManifest = HTDEMUCS_MANIFEST): string {
  return join(modelDir(userDataDir, m), m.fileName);
}

// ── Injectable side effects (real impls wired by the caller) ────────────────

export interface ModelFsDeps {
  exists(path: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** SHA-256 → lowercase hex. */
  sha256Hex(data: Uint8Array): Promise<string>;
  /** Fetch the URL as bytes (download-on-first-use). */
  download(url: string, onProgress?: (frac: number) => void): Promise<Uint8Array>;
}

/** True when a cached file exists AND matches the pinned checksum. */
export async function verifyCachedModel(path: string, m: StemModelManifest, fs: ModelFsDeps): Promise<boolean> {
  if (!m.sha256) return false;
  if (!(await fs.exists(path))) return false;
  const data = await fs.readFile(path);
  if (m.bytes > 0 && data.byteLength !== m.bytes) return false;
  const hex = await fs.sha256Hex(data);
  return hex.toLowerCase() === m.sha256.toLowerCase();
}

/**
 * Ensure the model is present and valid, downloading once if needed.  Returns
 * the local path, or null when the manifest isn't pinned yet (precise tier
 * stays disabled).  Throws only on a real download/verify failure.
 */
export async function ensureModel(
  userDataDir: string,
  fs: ModelFsDeps,
  m: StemModelManifest = HTDEMUCS_MANIFEST,
  onProgress?: (frac: number) => void,
): Promise<string | null> {
  if (!isModelConfigured(m)) return null;
  const path = modelPath(userDataDir, m);
  if (await verifyCachedModel(path, m, fs)) return path;

  await fs.mkdirp(modelDir(userDataDir, m));
  const data = await fs.download(m.url, onProgress);
  if (m.bytes > 0 && data.byteLength !== m.bytes) {
    throw new Error(`stem model download size mismatch: got ${data.byteLength}, expected ${m.bytes}`);
  }
  const hex = await fs.sha256Hex(data);
  if (hex.toLowerCase() !== m.sha256.toLowerCase()) {
    throw new Error('stem model checksum mismatch — refusing to use corrupt weights');
  }
  await fs.writeFile(path, data);
  return path;
}

/** Real fs/crypto/fetch deps for the Electron main process. */
export function nodeModelFsDeps(): ModelFsDeps {
  return {
    async exists(p) {
      const { access } = await import('node:fs/promises');
      try { await access(p); return true; } catch { return false; }
    },
    async mkdirp(dir) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
    },
    async readFile(p) {
      const { readFile } = await import('node:fs/promises');
      return new Uint8Array(await readFile(p));
    },
    async writeFile(p, data) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(p, data);
    },
    async sha256Hex(data) {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(data).digest('hex');
    },
    async download(url, onProgress) {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`stem model download failed: HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') ?? 0);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); received += value.byteLength; if (total > 0) onProgress?.(received / total); }
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    },
  };
}
