// Finding the models a user installed.
//
// The registry could validate a descriptor and report on it from the day it
// was written.  What it never had was anything to validate: every call to
// `buildReport` in the app passed an empty array, because nothing listed the
// folder.  So the ONNX session, the hash check and the mask expansion — all of
// it written and tested — had no door.
//
// The listing itself belongs in the main process (it is a filesystem), and the
// judgement belongs here (it is a rule).  This module is the seam: it asks for
// one entry per folder looked at, hands them to `buildReport` unchanged, and
// returns the folder path too, because "where do I put it" is the question a
// user with no models actually has.

import { buildReport, type ModelReport } from './model-registry.js';

export interface InstallScan {
  /** Where models are looked for, whether or not any are there. */
  root: string;
  report: ModelReport;
}

interface ScanReply {
  root: string;
  entries: ReadonlyArray<{ where: string; descriptor?: unknown; error?: string }>;
}

/**
 * Scan the model folder.
 *
 * Never throws.  A panel that shows nothing because the scan failed is worse
 * than one that says the scan failed, so a failure comes back as a `tried`
 * entry through the same report every other outcome uses — the UI below it
 * then has exactly one shape to render.
 */
export async function scanInstalledModels(): Promise<InstallScan> {
  const api = window.electronAPI;
  if (!api?.invoke) {
    return {
      root: '—',
      report: buildReport([{ where: '—', error: '파일 접근을 사용할 수 없습니다' }]),
    };
  }
  try {
    const reply = await api.invoke('daw:stem-models') as ScanReply;
    return { root: reply.root, report: buildReport(reply.entries) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { root: '—', report: buildReport([{ where: '—', error: `모델 폴더를 읽지 못했습니다 — ${message}` }]) };
  }
}
