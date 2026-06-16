// mobileApi — adapter that bridges the mobile UI to the M0 server mastering API
// and to native Capacitor capabilities (file pick / save / share).
//
// Endpoints (services/mastering-api):
//   POST /v1/analyze                          multipart `audio`          -> analysis JSON
//   POST /v1/master                           multipart `audio`+`options`-> { job_id }
//   GET  /v1/jobs/{id}                         -> { status, percent, stage[, error] }
//   GET  /v1/jobs/{id}/download?file=master|preview  -> WAV / MP3 blob
//
// Server URL + key come ONLY from Vite env (VITE_MASTERING_API_URL / _API_KEY).
// No payment / license / account logic here (out of scope for the test app).

import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// ── Config ────────────────────────────────────────────────────────────────────
// Env is the source of truth (VITE_MASTERING_API_URL / _API_KEY). The settings
// panel can override at runtime via setApiConfig() for ad-hoc testing.
export const ENV_API_URL: string = (import.meta.env.VITE_MASTERING_API_URL ?? '').replace(/\/+$/, '');
export const ENV_API_KEY: string = import.meta.env.VITE_MASTERING_API_KEY ?? '';

const config = { url: ENV_API_URL, key: ENV_API_KEY };

export function setApiConfig(url: string, key: string): void {
  config.url = (url ?? '').replace(/\/+$/, '');
  config.key = key ?? '';
}

export function getApiConfig(): { url: string; key: string } {
  return { url: config.url, key: config.key };
}

export const isNative = (): boolean => Capacitor.isNativePlatform();

function authHeaders(): Record<string, string> {
  return config.key ? { 'X-API-Key': config.key } : {};
}

function baseUrl(): string {
  if (!config.url) {
    throw new Error('Mastering API URL is not set. Configure it via env (VITE_MASTERING_API_URL) or the settings panel.');
  }
  return config.url;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface PickedAudio {
  name: string;
  mimeType: string;
  blob: Blob;
  size: number;
}

export interface JobStatus {
  status: 'queued' | 'processing' | 'done' | 'error';
  percent: number;
  stage: string;
  error?: string;
  loudnessAfter?: number | null;
  processingTimeSec?: number | null;
}

export interface MasterOptions {
  style?: string;
  targetLufs?: number;
  targetTp?: number;
  lra?: number;
  sampleRate?: number;
  bitDepth?: number;
  applyAiCorrections?: boolean;
  mode?: 'fast' | 'quality';
}

export interface ErrorContext {
  jobId?: string;
  file?: { name: string; size: number; mimeType: string } | null;
}

export type ProgressFn = (percent: number, stage: string) => void;

// ── File selection ─────────────────────────────────────────────────────────────
// Native: @capawesome/capacitor-file-picker → read back as blob.
// Web (vite preview / desktop browser): <input type="file"> fallback.
export async function pickAudioFile(): Promise<PickedAudio | null> {
  if (isNative()) {
    const res = await FilePicker.pickFiles({
      types: ['audio/*'],
      readData: true, // base64 in `data` — avoids content:// read restrictions
    });
    const f = res.files?.[0];
    if (!f) return null;
    const mime = f.mimeType || 'audio/*';
    const blob = f.data
      ? base64ToBlob(f.data, mime)
      : await (await fetch(f.path ?? '')).blob();
    return { name: f.name || 'audio', mimeType: mime, blob, size: f.size ?? blob.size };
  }

  // Web fallback
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, mimeType: file.type || 'audio/*', blob: file, size: file.size });
    };
    input.click();
  });
}

// ── Server calls ────────────────────────────────────────────────────────────────
export async function analyze(audio: PickedAudio): Promise<Record<string, unknown>> {
  const fd = new FormData();
  fd.append('audio', audio.blob, audio.name);
  const r = await fetch(`${baseUrl()}/v1/analyze`, { method: 'POST', headers: authHeaders(), body: fd });
  if (!r.ok) throw new Error(`analyze failed: ${r.status} ${await safeText(r)}`);
  return r.json();
}

export async function startMaster(audio: PickedAudio, options: MasterOptions): Promise<string> {
  const fd = new FormData();
  fd.append('audio', audio.blob, audio.name);
  fd.append('options', JSON.stringify(options));
  const r = await fetch(`${baseUrl()}/v1/master`, { method: 'POST', headers: authHeaders(), body: fd });
  if (!r.ok) throw new Error(`master failed: ${r.status} ${await safeText(r)}`);
  const j = (await r.json()) as { job_id: string };
  return j.job_id;
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const r = await fetch(`${baseUrl()}/v1/jobs/${jobId}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`job status failed: ${r.status} ${await safeText(r)}`);
  return r.json();
}

// Poll until done/error. Resolves with the final status.
export async function pollMaster(
  jobId: string,
  onProgress: ProgressFn,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<JobStatus> {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const start = Date.now();
  for (;;) {
    const s = await getJob(jobId);
    onProgress(s.percent ?? 0, s.stage ?? '');
    if (s.status === 'done' || s.status === 'error') return s;
    if (Date.now() - start > timeout) throw new Error('mastering timed out');
    await sleep(interval);
  }
}

// Download a result file as a blob. file = 'master' | 'preview'.
export async function downloadResult(jobId: string, file: 'master' | 'preview'): Promise<Blob> {
  const r = await fetch(`${baseUrl()}/v1/jobs/${jobId}/download?file=${file}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`download ${file} failed: ${r.status} ${await safeText(r)}`);
  return r.blob();
}

// Download + make a playable URL for <audio>.
// Native: persist to Cache dir and use Capacitor.convertFileSrc; web: object URL.
export async function downloadPlayable(
  jobId: string,
  file: 'master' | 'preview',
): Promise<{ url: string; blob: Blob; localPath?: string }> {
  const blob = await downloadResult(jobId, file);
  if (isNative()) {
    const ext = file === 'master' ? 'wav' : 'mp3';
    const path = `aimaster_${jobId}_${file}.${ext}`;
    const base64 = await blobToBase64(blob);
    const w = await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache });
    return { url: Capacitor.convertFileSrc(w.uri), blob, localPath: w.uri };
  }
  return { url: URL.createObjectURL(blob), blob };
}

// ── Save / share ────────────────────────────────────────────────────────────────
// Two distinct actions, each writing the blob to a real file first.

// Save to the device's public Downloads folder. On Android 11+ public-dir
// writes need no runtime permission; we fall back gracefully if a location is
// blocked by scoped storage. Returns a human-readable saved location.
export async function saveToDownloads(blob: Blob, fileName: string): Promise<string> {
  if (!isNative()) {
    triggerWebDownload(blob, fileName);
    return `Downloads/${fileName}`;
  }
  const base64 = await blobToBase64(blob);
  try {
    await Filesystem.requestPermissions(); // no-op / auto-granted on API 30+
  } catch {
    /* ignore */
  }

  // 1) Public Downloads — visible in the Files/Downloads app.
  try {
    const w = await Filesystem.writeFile({
      path: `Download/${fileName}`,
      data: base64,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
    return uriToLabel(w.uri, `Download/${fileName}`);
  } catch {
    /* fall through */
  }
  // 2) Public Documents.
  try {
    const w = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Documents,
      recursive: true,
    });
    return uriToLabel(w.uri, `Documents/${fileName}`);
  } catch {
    /* fall through */
  }
  // 3) App external storage (always writable, no permission).
  const w = await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.External,
    recursive: true,
  });
  return uriToLabel(w.uri, fileName);
}

// Open the Android share sheet (KakaoTalk, SMS, Gmail, Drive, Telegram, …).
// The file is written to the app cache (covered by the FileProvider) and shared.
export async function shareFile(blob: Blob, fileName: string, title: string): Promise<void> {
  if (!isNative()) {
    const file = new File([blob], fileName, { type: blob.type || undefined });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title });
      return;
    }
    triggerWebDownload(blob, fileName);
    return;
  }
  const base64 = await blobToBase64(blob);
  const w = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
  await Share.share({ title, url: w.uri, dialogTitle: title });
}

function uriToLabel(uri: string, fallback: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, '')) || fallback;
  } catch {
    return fallback;
  }
}

function triggerWebDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ── Error auto-reporting ────────────────────────────────────────────────────────
const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string) || '0.1.0';

// Best-effort: POST a sanitized error report to the server and return a receipt
// id (e.g. ERR-20260616-AB12). NEVER throws — a failed report must not break the
// user flow. No API key / original filename / PII is sent.
export async function reportError(
  step: string,
  err: unknown,
  ctx?: ErrorContext,
): Promise<string | null> {
  try {
    const { url, key } = getApiConfig();
    if (!url) return null;
    const sane = sanitizeError(err, key);
    const file = ctx?.file;
    const body = {
      app_version: APP_VERSION,
      platform: isNative() ? 'android' : 'web',
      step,
      job_id: ctx?.jobId ?? '',
      error_code: sane.code,
      sanitized_message: sane.message,
      file_meta: file ? { ext: extOf(file.name), mime: file.mimeType, sizeBytes: file.size } : undefined,
      timestamp: new Date().toISOString(),
    };
    const r = await fetch(`${url}/v1/error-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { receipt_id?: string };
    return j.receipt_id ?? null;
  } catch {
    return null;
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase().slice(0, 8) : '';
}

// Reduce a raw error to a short code + truncated message, stripping the API key
// and collapsing HTML error pages (e.g. a 502 from the proxy).
function sanitizeError(err: unknown, key: string): { code: string; message: string } {
  let raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (key && raw.includes(key)) raw = raw.split(key).join('***');
  if (/<html|<!doctype/i.test(raw)) raw = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const httpCode = raw.match(/\b([45]\d{2})\b/);
  const code = /failed to fetch|networkerror|load failed|network request failed/i.test(raw)
    ? 'network'
    : httpCode
      ? `http_${httpCode[1]}`
      : (err instanceof Error ? err.name : 'error').slice(0, 40);
  return { code, message: raw.slice(0, 500) };
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // strip the data: URL prefix → bare base64 for Filesystem.writeFile
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
