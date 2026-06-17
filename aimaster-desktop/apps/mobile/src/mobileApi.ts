// mobileApi — native bridge for the mobile app (file pick / save / share).
//
// Mastering runs ENTIRELY on-device now (see localMobileMastering.ts) — there is
// NO server, no upload, no job polling, no Render dependency. This module only
// wraps the native Capacitor capabilities the local flow still needs:
//   - pickAudioFile()  → choose an input file (native picker / web <input>)
//   - saveToDownloads()→ write a result blob to the device
//   - shareFile()      → open the OS share sheet
//
// No payment / license / account / server logic lives here.

import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = (): boolean => Capacitor.isNativePlatform();

// ── Types ─────────────────────────────────────────────────────────────────────
export interface PickedAudio {
  name: string;
  mimeType: string;
  blob: Blob;
  size: number;
}

export interface MasterOptions {
  style?: string;
  targetLufs?: number;
  targetTp?: number;
}

export interface ErrorContext {
  file?: { name: string; size: number; mimeType: string } | null;
}

// Thrown to abort an in-flight local run (the run-id guard requested cancel).
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

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

// ── Error logging (local only — no server) ───────────────────────────────────
// Mastering is on-device, so there is no server to file reports to. We just log
// to the console for local debugging and return null (no receipt id). NEVER
// throws — a logging failure must not break the user flow.
export function reportError(step: string, err: unknown, _ctx?: ErrorContext): null {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[mobile:${step}]`, err);
  } catch {
    /* ignore */
  }
  return null;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
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
