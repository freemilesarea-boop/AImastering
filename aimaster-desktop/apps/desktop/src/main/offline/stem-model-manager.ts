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
  /**
   * Fixed segment length (samples) the ONNX graph requires.  Demucs exports are
   * usually fixed-length: the runtime pads each segment to this and crops the
   * output back.  0 / omitted ⇒ the graph accepts the native segment length
   * (dynamic time axis).
   */
  segmentSamples?: number;
}

/** Pinned HT-Demucs (v4) manifest.  url/sha256/bytes TBD — see plan doc. */
export const HTDEMUCS_MANIFEST: StemModelManifest = {
  id: 'htdemucs-v4',
  fileName: 'htdemucs.onnx',
  url: '', // TODO: pin published ONNX weights URL
  sha256: '', // TODO: pin SHA-256 once exported
  bytes: 0,
  modelSampleRate: 44100,
  segmentSamples: 0, // 0 = dynamic time axis; export script fills the real value
};

/** A manifest is usable once it has both a source and a checksum pinned. */
export function isModelConfigured(m: StemModelManifest = HTDEMUCS_MANIFEST): boolean {
  return m.url.length > 0 && m.sha256.length === 64;
}

// ── Sidecar manifest (pin without a code edit) ──────────────────────────────
//
// The bundled HTDEMUCS_MANIFEST is a placeholder.  Rather than editing source to
// pin a real model, a `stem-model.manifest.json` sidecar (written by the
// `pin:stem-model` script) overrides it at runtime.  This keeps the pinned
// url/sha256/bytes out of the code and lets ops re-pin without a rebuild.

/** Conventional sidecar location under userData. */
export function manifestSidecarPath(userDataDir: string): string {
  return join(userDataDir, 'models', 'stem-model.manifest.json');
}

/** Validate an untrusted object into a StemModelManifest, or null if invalid. */
export function parseManifest(raw: unknown): StemModelManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const id = str(o.id), fileName = str(o.fileName), url = str(o.url), sha256 = str(o.sha256);
  const bytes = num(o.bytes), modelSampleRate = num(o.modelSampleRate);
  if (id === null || fileName === null || url === null || sha256 === null || bytes === null || modelSampleRate === null) return null;
  if (id.length === 0 || fileName.length === 0) return null;
  if (sha256.length > 0 && !/^[0-9a-f]{64}$/i.test(sha256)) return null; // empty = intentionally unpinned
  if (bytes < 0 || modelSampleRate <= 0) return null;
  // Path-traversal safety: fileName is joined under the model dir.
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null;
  // segmentSamples is optional; when present it must be a non-negative integer.
  let segmentSamples = 0;
  if (o.segmentSamples !== undefined) {
    const seg = num(o.segmentSamples);
    if (seg === null || seg < 0 || !Number.isInteger(seg)) return null;
    segmentSamples = seg;
  }
  return { id, fileName, url, sha256: sha256.toLowerCase(), bytes, modelSampleRate, segmentSamples };
}

export interface ManifestSource {
  /** Read a text file, or null when it does not exist / is unreadable. */
  readText(path: string): Promise<string | null>;
}

/**
 * Resolve the active manifest: a valid JSON sidecar overrides the bundled
 * placeholder.  Any problem (missing, malformed, invalid shape) falls back to
 * the placeholder so a bad sidecar can never break the app — it just leaves the
 * precise tier disabled.
 */
export async function resolveManifest(sidecarPath: string | null, src: ManifestSource): Promise<StemModelManifest> {
  if (!sidecarPath) return HTDEMUCS_MANIFEST;
  let text: string | null = null;
  try { text = await src.readText(sidecarPath); } catch { return HTDEMUCS_MANIFEST; }
  if (!text) return HTDEMUCS_MANIFEST;
  try { return parseManifest(JSON.parse(text)) ?? HTDEMUCS_MANIFEST; } catch { return HTDEMUCS_MANIFEST; }
}

/** Real fs source for the sidecar (returns null when absent). */
export function nodeManifestSource(): ManifestSource {
  return {
    async readText(path) {
      try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(path, 'utf8');
      } catch { return null; }
    },
  };
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
