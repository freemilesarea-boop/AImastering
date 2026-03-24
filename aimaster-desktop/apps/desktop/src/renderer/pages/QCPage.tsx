/**
 * Screen 5: QC Report
 *
 * Shows the detailed QCResult from the last mastering run:
 *   - Overall pass/warn/fail banner
 *   - Per-item check list with status icons
 *   - Platform loudness target table (Spotify / Apple / YouTube / etc.)
 *
 * This page is navigated to from ResultPage via the TopBar
 * or after a manual "audio:qc" IPC call.
 */
import React, { useEffect, useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { QCResult, QCItem, QCStatus, PlatformTarget } from '@aimaster/shared-types';

// ── Status helpers ─────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<QCStatus, string> = {
  pass:    'text-emerald-400',
  warning: 'text-amber-400',
  fail:    'text-red-400',
};

const STATUS_BG: Record<QCStatus, string> = {
  pass:    'bg-emerald-500/10 border-emerald-500/20',
  warning: 'bg-amber-500/10  border-amber-500/20',
  fail:    'bg-red-500/10    border-red-500/20',
};

const STATUS_LABEL: Record<QCStatus, string> = {
  pass:    '통과',
  warning: '주의',
  fail:    '실패',
};

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: QCStatus }) {
  if (status === 'pass') {
    return (
      <svg className="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 16 16"
           fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M5 8.5l2 2 4-4" />
      </svg>
    );
  }
  if (status === 'warning') {
    return (
      <svg className="w-4 h-4 text-amber-400 shrink-0" viewBox="0 0 16 16"
           fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
        <path d="M8 2L14.5 13H1.5L8 2z" />
        <path d="M8 6.5v3M8 11v.5" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-red-400 shrink-0" viewBox="0 0 16 16"
         fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </svg>
  );
}

// ── Check item row ─────────────────────────────────────────────────────────────

function CheckRow({ item }: { item: QCItem }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-zinc-800/60 last:border-0">
      <StatusIcon status={item.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm ${item.status === 'pass' ? 'text-zinc-400' : 'text-zinc-200'}`}>
            {item.label}
          </span>
          {item.value !== undefined && (
            <span className="font-mono text-xs text-zinc-500 shrink-0">
              {String(item.value)}
            </span>
          )}
        </div>
        {item.status !== 'pass' && (
          <p className="mt-0.5 text-xs text-zinc-600 leading-snug">{item.message}</p>
        )}
      </div>
    </div>
  );
}

// ── Platform table ─────────────────────────────────────────────────────────────

function PlatformRow({ p }: { p: PlatformTarget }) {
  const diff = p.currentLufs - p.targetLufs;
  const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(1);
  const diffColor = Math.abs(diff) <= 1.0 ? 'text-emerald-400' : 'text-amber-400';

  return (
    <div className="grid grid-cols-4 items-center px-4 py-2.5 border-b border-zinc-800/60 last:border-0">
      <span className="col-span-1 text-xs text-zinc-400">{p.name}</span>
      <span className="font-mono text-xs text-zinc-600 text-right">
        {p.targetLufs.toFixed(0)} LUFS
      </span>
      <span className="font-mono text-xs text-zinc-400 text-right">
        {p.currentLufs.toFixed(1)} LUFS
      </span>
      <span className={`font-mono text-xs text-right ${diffColor}`}>
        {diffStr}
      </span>
    </div>
  );
}

// ── QCPage ─────────────────────────────────────────────────────────────────────

export default function QCPage() {
  const setPage         = useAppStore((s) => s.setPage);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const qcResult        = useAudioStore((s) => s.qcResult);
  const setQcResult     = useAudioStore((s) => s.setQcResult);
  const selectedFile    = useAudioStore((s) => s.selectedFile);

  // Run QC if we have a mastered file but no QC result yet
  const runQC = useCallback(async () => {
    const path = masteringResult?.outputPath || masteringResult?.previewPath;
    if (!path || qcResult) return;
    try {
      const result = await window.electronAPI.invoke(
        'audio:qc', path, -14.0, -1.0,
      ) as QCResult;
      setQcResult(result);
    } catch {
      // non-fatal — page just shows empty state
    }
  }, [masteringResult, qcResult, setQcResult]);

  useEffect(() => { void runQC(); }, [runQC]);

  const overall = qcResult?.overall ?? 'pass';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="QC 리포트"
        actions={
          <button
            onClick={() => setPage('result')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            결과로
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">

          {/* ── Overall banner ──────────────────────────────────── */}
          {qcResult && (
            <div className={`rounded-xl border p-4 ${STATUS_BG[overall]}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-xs uppercase tracking-wider font-medium ${STATUS_COLOR[overall]}`}>
                    전체 결과
                  </p>
                  <p className="mt-1 text-2xl font-semibold text-zinc-100">
                    {STATUS_LABEL[overall]}
                  </p>
                </div>
                <p className="text-sm text-zinc-500">
                  {qcResult.passCount} / {qcResult.totalCount} 항목 통과
                </p>
              </div>
            </div>
          )}

          {/* ── Check items ─────────────────────────────────────── */}
          {qcResult && qcResult.items.length > 0 && (
            <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
              <p className="text-xs text-zinc-600 uppercase tracking-wider mb-1">검사 항목</p>
              {qcResult.items.map((item) => (
                <CheckRow key={item.id} item={item} />
              ))}
            </div>
          )}

          {/* ── Platform targets ─────────────────────────────────── */}
          {qcResult && qcResult.platforms.length > 0 && (
            <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
              <div className="grid grid-cols-4 px-4 pt-3 pb-2 border-b border-zinc-800">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider">플랫폼</span>
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">목표</span>
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">현재</span>
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">차이</span>
              </div>
              {qcResult.platforms.map((p) => (
                <PlatformRow key={p.name} p={p} />
              ))}
            </div>
          )}

          {/* ── Empty state ─────────────────────────────────────── */}
          {!qcResult && (
            <div className="flex items-center justify-center h-40">
              <div className="text-center space-y-2">
                <div className="w-6 h-6 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin mx-auto" />
                <p className="text-xs text-zinc-600">QC 분석 중…</p>
              </div>
            </div>
          )}

          {/* ── No file state ───────────────────────────────────── */}
          {!selectedFile && !masteringResult && (
            <div className="text-center py-12">
              <p className="text-sm text-zinc-600">마스터링 결과가 없습니다.</p>
              <button
                onClick={() => setPage('home')}
                className="no-drag mt-3 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                홈으로
              </button>
            </div>
          )}

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
