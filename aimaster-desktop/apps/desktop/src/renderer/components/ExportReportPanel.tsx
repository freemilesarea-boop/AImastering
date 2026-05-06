/**
 * ExportReportPanel — Phase-E UI to export the mastering report as
 * either TXT or JSON.  The actual formatting lives in
 * `./masteringReportExport.ts` so we can unit-test it without a DOM.
 *
 * Behaviour:
 *   • Always renders the two buttons even if some Phase-D fields are
 *     missing — the export still includes whatever IS available.
 *   • Uses an in-memory Blob + a temporary <a> click to trigger the
 *     browser download.  No filesystem-level `dialog.showSaveDialog`
 *     dependency; works in Electron renderer and in test stubs.
 */
import React, { useCallback } from 'react';
import type { MasteringResult } from '@aimaster/shared-types';
import {
  buildExportPayload,
  exportAsJson,
  exportAsTxt,
} from './masteringReportExport.js';

interface Props {
  result?:       MasteringResult | null | undefined;
  selectedMode?: string | null | undefined;
  /** Optional notify hook — useful in tests to assert export ran. */
  onExported?:   (kind: 'txt' | 'json', filename: string, text: string) => void;
}

function downloadBlob(filename: string, mime: string, text: string): void {
  // In a non-DOM test harness the helper is bypassed; guard accordingly.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the navigation has a chance to read the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  // Filename-safe ISO-ish stamp.
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function ExportReportPanel({ result, selectedMode, onExported }: Props) {
  const handleTxt = useCallback(() => {
    const payload = buildExportPayload(result ?? null, selectedMode ?? null);
    const text    = exportAsTxt(payload);
    const name    = `mastering-report-${timestamp()}.txt`;
    downloadBlob(name, 'text/plain;charset=utf-8', text);
    onExported?.('txt', name, text);
  }, [result, selectedMode, onExported]);

  const handleJson = useCallback(() => {
    const payload = buildExportPayload(result ?? null, selectedMode ?? null);
    const text    = exportAsJson(payload);
    const name    = `mastering-report-${timestamp()}.json`;
    downloadBlob(name, 'application/json;charset=utf-8', text);
    onExported?.('json', name, text);
  }, [result, selectedMode, onExported]);

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">리포트 내보내기</p>
        <span className="text-[10px] text-zinc-700">TXT · JSON</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleTxt}
          className="no-drag w-full px-3 py-2.5 rounded-lg border border-zinc-700
                     bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/60
                     transition-colors text-xs text-zinc-300"
        >
          TXT 저장
        </button>
        <button
          type="button"
          onClick={handleJson}
          className="no-drag w-full px-3 py-2.5 rounded-lg border border-zinc-700
                     bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/60
                     transition-colors text-xs text-zinc-300"
        >
          JSON 저장
        </button>
      </div>

      <p className="text-[10px] text-zinc-600 leading-snug mt-2">
        구간 분석, AI 아티팩트 검사, 보컬·번역 분석 결과까지 포함된 단일 리포트입니다.
      </p>
    </div>
  );
}

export default ExportReportPanel;
