/**
 * reportFailure — renderer-side helper that forwards a categorised
 * failure into the main process's support-bundle ring.
 *
 * Safe to call from anywhere in the renderer:
 *   • In dev / non-Electron contexts (e.g. tests, ssr render) it
 *     no-ops silently — `window.electronAPI` may not exist.
 *   • All payloads are best-effort; never blocks rendering.
 *
 * Categories must match the FailureCategory union in
 * `main/utils/failureLog.ts` — narrow them here for IDE help.
 */

export type ReportFailureCategory =
  | 'preview'
  | 'worklet'
  | 'export'
  | 'pipeline'
  | 'unknown';

export interface ReportFailurePayload {
  category: ReportFailureCategory;
  message:  string;
  data?:    Record<string, unknown>;
}

export function reportFailure(payload: ReportFailurePayload): void {
  try {
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined);
    if (!api?.invoke) return;
    void api.invoke('support:record-failure', payload);
  } catch {
    // Never let support-side telemetry break the renderer.
  }
}
