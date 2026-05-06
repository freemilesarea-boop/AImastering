/**
 * Screen 4: Result
 *
 * Layout:
 *   TopBar
 *   Before / After loudness comparison card
 *   Preview player (HTML5 audio)
 *   Save buttons (MP3 always · WAV locked for free tier)
 *   QC summary chips
 *   YouTube Music notice
 */
import React, { useCallback, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import type {
  AnalysisReport as AnalysisReportType,
  MasteringMeta,
  MasteringResult,
  MetricComparisonRow,
  QualityCheckReport,
  DynamicEqReport,
} from '@aimaster/shared-types';
import { LIMITER_STRENGTH_LABELS } from '@aimaster/shared-types';
import SectionAnalysisPanel from '../components/SectionAnalysisPanel.js';
import AIArtifactWarningPanel from '../components/AIArtifactWarningPanel.js';
import SmartRecommendationPanel from '../components/SmartRecommendationPanel.js';
import ExportReportPanel from '../components/ExportReportPanel.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1) { return n.toFixed(d); }

/** Convert a filesystem path to aimaster-local:// URL (bypasses Chromium file:// block). */
function toFileUrl(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `aimaster-local://${encodeURI(withSlash)}`;
}

// ── Arrow delta ───────────────────────────────────────────────────────────────

function Delta({ before, after, unit }: { before: number; after: number; unit: string }) {
  const diff   = after - before;
  const absStr = Math.abs(diff).toFixed(1);
  const color  = diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-amber-400' : 'text-zinc-500';
  const sign   = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return (
    <span className={`text-xs font-mono ${color}`}>
      {sign}{absStr} {unit}
    </span>
  );
}

// ── Before / After card ───────────────────────────────────────────────────────

function BeforeAfterCard() {
  const analysis  = useAudioStore((s) => s.analysis);
  const result    = useAudioStore((s) => s.masteringResult);
  if (!analysis || !result) return null;

  const rows = [
    {
      label:  'Integrated Loudness',
      before: analysis.loudness.integratedLufs,
      after:  result.loudnessAfter.integratedLufs,
      unit:   'LUFS',
    },
    {
      label:  'True Peak',
      before: analysis.loudness.truePeakDbtp,
      after:  result.loudnessAfter.truePeakDbtp,
      unit:   'dBTP',
    },
    {
      label:  'Loudness Range',
      before: analysis.loudness.lra,
      after:  result.loudnessAfter.lra,
      unit:   'LU',
    },
  ];

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-4 px-4 pt-3 pb-2 border-b border-zinc-800">
        <span className="col-span-2 text-[10px] text-zinc-600 uppercase tracking-wider">항목</span>
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">이전</span>
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider text-right">이후</span>
      </div>
      {rows.map(({ label, before, after, unit }) => (
        <div key={label}
             className="grid grid-cols-4 items-center px-4 py-2.5 border-b border-zinc-800/60 last:border-0">
          <span className="col-span-2 text-xs text-zinc-500">{label}</span>
          <span className="font-mono text-xs text-zinc-600 text-right">
            {fmt(before)} <span className="text-zinc-700">{unit}</span>
          </span>
          <div className="text-right space-y-0.5">
            <div className="font-mono text-sm text-zinc-200">
              {fmt(after)} <span className="text-zinc-600 text-xs">{unit}</span>
            </div>
            <Delta before={before} after={after} unit={unit} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Audio preview player ──────────────────────────────────────────────────────

function PreviewPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { void a.play(); } else { a.pause(); }
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    a.currentTime = ratio * duration;
  }, [duration]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  if (!src) return null;

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">프리뷰 (MP3)</p>

      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a && a.duration) setProgress(a.currentTime / a.duration);
        }}
        onLoadedMetadata={() => {
          const a = audioRef.current;
          if (a) setDuration(a.duration);
        }}
      />

      <div className="flex items-center gap-3">
        {/* Play/pause button */}
        <button
          onClick={toggle}
          className="no-drag w-9 h-9 flex items-center justify-center rounded-full
                     bg-zinc-200 text-zinc-900 hover:bg-white active:bg-zinc-300
                     shrink-0 transition-colors"
        >
          {playing ? (
            // Pause icon
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="3.5" height="12" rx="1" />
              <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
            </svg>
          ) : (
            // Play icon
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5l10 5.5-10 5.5V2.5z" />
            </svg>
          )}
        </button>

        {/* Seek bar */}
        <div className="flex-1 space-y-1">
          <div
            className="h-1.5 rounded-full bg-zinc-800 cursor-pointer overflow-hidden"
            onClick={handleSeek}
          >
            <div
              className="h-full rounded-full bg-zinc-400 transition-none"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] font-mono text-zinc-600">
              {formatTime(progress * duration)}
            </span>
            <span className="text-[10px] font-mono text-zinc-700">
              {duration ? formatTime(duration) : '--:--'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Save buttons ──────────────────────────────────────────────────────────────

function SaveButtons() {
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const notify          = useAppStore((s) => s.notify);

  const handleSaveMp3 = useCallback(async () => {
    if (!masteringResult?.previewPath) return;
    const dest = await window.electronAPI.invoke(
      'file:save-wav',
      masteringResult.previewPath,
    ) as string | null;
    if (dest) notify('MP3 저장 완료', 'success');
  }, [masteringResult, notify]);

  const handleSaveWav = useCallback(async () => {
    if (!masteringResult?.outputPath) return;
    const dest = await window.electronAPI.invoke(
      'file:save-wav',
      masteringResult.outputPath,
    ) as string | null;
    if (dest) notify('WAV 저장 완료', 'success');
  }, [masteringResult, notify]);

  return (
    <div className="space-y-2">
      {/* WAV — always available */}
      <button
        onClick={handleSaveWav}
        disabled={!masteringResult?.outputPath}
        className="no-drag w-full flex items-center justify-between px-4 py-3
                   rounded-xl border border-zinc-700 bg-zinc-900/40
                   hover:border-zinc-600 hover:bg-zinc-900/60 transition-colors group
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
          <span className="text-sm text-zinc-300">마스터 WAV 저장</span>
          <span className="text-xs text-zinc-700">24-bit</span>
        </div>
        <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">저장</span>
      </button>

      {/* MP3 preview */}
      <button
        onClick={handleSaveMp3}
        disabled={!masteringResult?.previewPath}
        className="no-drag w-full flex items-center justify-between px-4 py-3
                   rounded-xl border border-zinc-700 bg-zinc-900/40
                   hover:border-zinc-600 hover:bg-zinc-900/60 transition-colors group
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
          <span className="text-sm text-zinc-300">프리뷰 MP3 저장</span>
          <span className="text-xs text-zinc-700">320 kbps</span>
        </div>
        <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">저장</span>
      </button>
    </div>
  );
}

// ── QC summary ────────────────────────────────────────────────────────────────

function QCSummary() {
  const result = useAudioStore((s) => s.masteringResult);
  if (!result) return null;

  const after = result.loudnessAfter;
  const targetLufs = -14.5;
  const targetTp   = -1.0;

  const lufsOk = Math.abs(after.integratedLufs - targetLufs) <= 1.0;
  const tpOk   = after.truePeakDbtp <= targetTp;

  const items = [
    { label: `-14.5 LUFS 달성`,  ok: lufsOk,
      note: `${after.integratedLufs.toFixed(1)} LUFS` },
    { label: `True Peak -1 dBTP 이하`, ok: tpOk,
      note: `${after.truePeakDbtp.toFixed(1)} dBTP` },
    { label: '처리 완료', ok: true, note: `${result.processingTimeSec.toFixed(1)}s` },
  ];

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">QC 결과</p>
      <div className="space-y-2">
        {items.map(({ label, ok, note }) => (
          <div key={label} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-xs text-zinc-400">{label}</span>
            </div>
            <span className="font-mono text-xs text-zinc-600">{note}</span>
          </div>
        ))}
      </div>
      {/* YouTube Music note */}
      <p className="mt-3 pt-3 border-t border-zinc-800 text-[11px] text-zinc-700 leading-snug">
        YouTube Music · Spotify · Apple Music 기본 타깃 −14 LUFS / −1 dBTP 기준 적용
      </p>
    </div>
  );
}

// ── Mastering meta card (v3) ─────────────────────────────────────────────────

function MasteringMetaCard({ meta }: { meta: MasteringMeta }) {
  const lufsOK = Math.abs(meta.appliedGainDb) >= 0
    ? Math.abs((meta as MasteringMeta & { lufsDelta?: number }).lufsDelta ?? 0) <= 0.5
    : true;

  const cells: Array<{ label: string; value: string; ok?: boolean; hint?: string }> = [
    { label: 'Selected Mode',     value: meta.mode },
    { label: 'Target',            value: `${meta.targetLufs.toFixed(1)} LUFS · ${meta.targetTruePeak.toFixed(1)} dBTP` },
    { label: 'Limiter',           value: LIMITER_STRENGTH_LABELS[meta.limiterStrength] },
    { label: 'Loudnorm',          value: meta.useLinearLoudnorm ? 'linear' : 'dynamic' },
    { label: 'Applied Gain',      value: `${meta.appliedGainDb >= 0 ? '+' : ''}${meta.appliedGainDb.toFixed(1)} dB` },
    { label: 'Limiter Reduction', value: `~${meta.limiterReductionDb.toFixed(1)} dB` },
  ];

  return (
    <div className={`rounded-xl border p-4 space-y-3
                     ${meta.targetReached
                       ? 'bg-emerald-950/20 border-emerald-900/40'
                       : 'bg-amber-950/20 border-amber-900/40'
                     }`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-zinc-400">마스터링 리포트</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded
                          ${meta.targetReached
                            ? 'bg-emerald-900/40 text-emerald-300'
                            : 'bg-amber-900/40 text-amber-300'
                          }`}>
          {meta.targetReached ? '목표 달성' : '목표 미달'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="bg-zinc-950/60 rounded-md px-2.5 py-1.5">
            <div className="text-[10px] text-zinc-600">{c.label}</div>
            <div className="text-xs font-mono text-zinc-200">{c.value}</div>
          </div>
        ))}
      </div>

      {meta.correctionApplied && (
        <div className="text-[11px] text-violet-300 bg-violet-950/30 border border-violet-900/40 rounded-md px-2.5 py-1.5">
          ✦ 자동 보정 패스 적용 — 게인 조정 {meta.correctionGainDb >= 0 ? '+' : ''}{meta.correctionGainDb.toFixed(2)} dB
        </div>
      )}
    </div>
  );
}

// ── v3.2 P2 — Waveform compare card ───────────────────────────────────────────

function WaveformCompareCard({ result }: { result: MasteringResult }) {
  const [imgError, setImgError] = useState<{ before?: boolean; after?: boolean; compare?: boolean }>({});
  const compare = result.compareWaveformPath ? toFileUrl(result.compareWaveformPath) : '';
  const before  = result.beforeWaveformPath  ? toFileUrl(result.beforeWaveformPath)  : '';
  const after   = result.afterWaveformPath   ? toFileUrl(result.afterWaveformPath)   : '';

  // 이미지가 하나도 없거나 모두 로드 실패 → null (전체 카드 숨김)
  const anyImage = (compare && !imgError.compare)
                || (before  && !imgError.before)
                || (after   && !imgError.after);
  if (!compare && !before && !after) return null;

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">파형 비교</p>
        <span className="text-[10px] text-zinc-700">
          {compare && !imgError.compare ? '상: 원본 · 하: 마스터' : '원본 / 마스터'}
        </span>
      </div>

      {!anyImage ? (
        <div className="bg-zinc-950/60 border border-dashed border-zinc-800 rounded-md py-8
                        text-center text-[11px] text-zinc-600">
          파형 이미지를 불러올 수 없습니다
        </div>
      ) : compare && !imgError.compare ? (
        <img
          src={compare}
          alt="원본/마스터 비교 파형"
          className="w-full rounded-md bg-zinc-950"
          onError={() => setImgError((e) => ({ ...e, compare: true }))}
        />
      ) : (
        <div className="space-y-2">
          {before && !imgError.before && (
            <div>
              <p className="text-[10px] text-zinc-700 mb-1">원본</p>
              <img
                src={before} alt="원본 파형"
                className="w-full rounded-md bg-zinc-950"
                onError={() => setImgError((e) => ({ ...e, before: true }))}
              />
            </div>
          )}
          {after && !imgError.after && (
            <div>
              <p className="text-[10px] text-zinc-500 mb-1">마스터</p>
              <img
                src={after} alt="마스터 파형"
                className="w-full rounded-md bg-zinc-950"
                onError={() => setImgError((e) => ({ ...e, after: true }))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── v3.2 P2 — Metric comparison table ────────────────────────────────────────

type Severity = 'ok' | 'warn' | 'danger';

function severity(s: unknown): Severity {
  return s === 'ok' || s === 'warn' || s === 'danger' ? s : 'warn';
}

const STATUS_DOT: Record<Severity, string> = {
  ok:     'bg-emerald-400',
  warn:   'bg-amber-400',
  danger: 'bg-red-400',
};

const STATUS_TEXT: Record<Severity, string> = {
  ok:     'text-emerald-400',
  warn:   'text-amber-400',
  danger: 'text-red-400',
};

function fmtCell(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '–';
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
  return String(v);
}

function MetricComparisonTable({ rows }: { rows: MetricComparisonRow[] }) {
  if (!rows.length) return null;

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">상세 비교</p>
        <span className="text-[10px] text-zinc-700">{rows.length}개 지표</span>
      </div>
      <div className="divide-y divide-zinc-800/60">
        {rows.map((r) => {
          const sev = severity(r.status);
          return (
            <div key={r.key} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[sev]}`} />
                  <span className="text-xs text-zinc-300 truncate">{r.label}</span>
                </div>
                <div className="flex items-center gap-1.5 font-mono text-[11px] shrink-0 whitespace-nowrap">
                  <span className="text-zinc-600">{fmtCell(r.before)}</span>
                  <span className="text-zinc-700">→</span>
                  <span className="text-zinc-200">{fmtCell(r.after)}</span>
                  {r.unit && <span className="text-zinc-700">{r.unit}</span>}
                  {r.delta !== null && r.delta !== undefined && Number.isFinite(r.delta) && (
                    <span className={STATUS_TEXT[sev]}>
                      ({r.delta >= 0 ? '+' : ''}{r.delta.toFixed(1)})
                    </span>
                  )}
                </div>
              </div>
              {r.hint && (
                <p className="text-[10px] text-zinc-700 mt-1 ml-3.5 leading-snug">{r.hint}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── v3.2 P2 — Quality check card ─────────────────────────────────────────────

const QC_BG: Record<Severity, string> = {
  ok:     'bg-emerald-950/20 border-emerald-900/40',
  warn:   'bg-amber-950/20 border-amber-900/40',
  danger: 'bg-red-950/20 border-red-900/40',
};

const QC_BADGE: Record<Severity, string> = {
  ok:     'bg-emerald-900/40 text-emerald-300',
  warn:   'bg-amber-900/40 text-amber-300',
  danger: 'bg-red-900/40 text-red-300',
};

const QC_LABEL: Record<Severity, string> = {
  ok:     '통과',
  warn:   '주의',
  danger: '재검토',
};

function QualityCheckCard({ report }: { report: QualityCheckReport }) {
  if (!report || !report.items?.length) return null;
  const overall = severity(report.overall);

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${QC_BG[overall]}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-zinc-400">자동 품질 검사</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${QC_BADGE[overall]}`}>
          {QC_LABEL[overall]}
        </span>
      </div>
      <p className="text-[11px] text-zinc-300 leading-snug">{report.summary}</p>
      <div className="space-y-2 pt-1 border-t border-zinc-800/60">
        {report.items.map((it, i) => {
          const sev = severity(it.status);
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${STATUS_DOT[sev]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-zinc-300">{it.name}</p>
                  <span className={`text-[10px] font-mono uppercase ${STATUS_TEXT[sev]}`}>
                    {sev}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-600 leading-snug">{it.message}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── v3.2 P3 — Dynamic EQ card ────────────────────────────────────────────────

function fmtFreq(hz: number): string {
  if (!Number.isFinite(hz)) return '–';
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

function DynamicEqCard({ report }: { report: DynamicEqReport }) {
  if (!report?.bands?.length) return null;
  const engineLabel = report.engine === 'adynamicequalizer'
    ? '동적'
    : report.engine === 'fallback'
      ? '정적 fallback'
      : '비활성';

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-600 uppercase tracking-wider">Dynamic EQ</p>
          {report.preset && (
            <span className="text-[9px] text-zinc-700 border border-zinc-800 rounded px-1">
              {report.preset}
            </span>
          )}
        </div>
        <span className="text-[10px] text-zinc-700">{engineLabel} · {report.bands.length}밴드</span>
      </div>
      <div className="space-y-1.5">
        {report.bands.map((b, i) => (
          <div key={`${b.name}-${i}`} className="flex items-center justify-between text-[11px] gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className={`w-1 h-1 rounded-full shrink-0 ${
                b.mode === 'cut' ? 'bg-amber-500' : 'bg-emerald-500'
              }`} />
              <span className="text-zinc-400 truncate">{b.label || b.name}</span>
            </div>
            <div className="flex items-center gap-2 font-mono shrink-0 whitespace-nowrap">
              <span className="text-zinc-700">{fmtFreq(b.freq)}</span>
              <span className={b.mode === 'cut' ? 'text-amber-400' : 'text-emerald-400'}>
                {b.mode === 'cut' ? '−' : '+'}{Number.isFinite(b.reduction) ? b.reduction.toFixed(1) : '0'} dB
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Warnings card ────────────────────────────────────────────────────────────

function WarningsCard({
  warnings,
}: {
  warnings: Array<{ code: string; level: string; userMessage: string }>;
}) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-xl border border-amber-900/40 bg-amber-950/15 p-3 space-y-1.5">
      <p className="text-[11px] text-amber-300 font-medium">⚠ 주의사항</p>
      <ul className="text-[11px] text-amber-200/80 space-y-0.5 list-disc pl-4">
        {warnings.map((w, i) => (
          <li key={i}>
            <span className={w.level === 'error' ? 'text-red-300' : ''}>
              {w.userMessage}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Analysis Report card ──────────────────────────────────────────────────────

function AnalysisReportCard({ report }: { report: AnalysisReportType }) {
  const [open, setOpen] = useState(false);

  const specDelta = (before: number | undefined, after: number | undefined, label: string) => {
    if (before == null || after == null) return null;
    const diff = after - before;
    const sign = diff > 0 ? '+' : '';
    const color = diff > 0.5 ? 'text-emerald-400' : diff < -0.5 ? 'text-amber-400' : 'text-zinc-500';
    return (
      <div key={label} className="flex justify-between">
        <span className="text-zinc-600">{label}</span>
        <span className={`font-mono text-xs ${color}`}>
          {before.toFixed(1)} → {after.toFixed(1)} ({sign}{diff.toFixed(1)} dB)
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-800/30 transition-colors"
      >
        <span className="text-xs text-zinc-500 uppercase tracking-wider">분석 리포트</span>
        <span className="text-[10px] text-zinc-700">{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-zinc-800">

          {/* EQ Moves */}
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mt-3 mb-1.5">EQ 적용 밴드</p>
            <div className="space-y-1">
              {report.eqMoves.map((m, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1 h-1 rounded-full shrink-0 ${m.gainDb >= 0 ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span className="text-zinc-500">{m.band}</span>
                    {m.adaptive && <span className="text-[9px] text-zinc-700 border border-zinc-800 rounded px-1">적응형</span>}
                  </div>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-zinc-700">{m.freqHz >= 1000 ? `${m.freqHz / 1000}kHz` : `${m.freqHz}Hz`}</span>
                    <span className={m.gainDb >= 0 ? 'text-emerald-400' : 'text-amber-400'}>{m.gainStr} dB</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Compressor */}
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">컴프레서</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              {[
                ['Threshold', `${report.compressor.thresholdDb} dBFS`],
                ['Ratio', `${report.compressor.ratio}:1`],
                ['Attack', `${report.compressor.attackMs} ms`],
                ['Release', `${report.compressor.releaseMs} ms`],
                ['Makeup', `+${report.compressor.makeupDb} dB`],
                ['Est. GR', `−${report.compressor.estimatedGrDb} dB`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-zinc-600">{k}</span>
                  <span className="font-mono text-zinc-400">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Limiter */}
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">리미터</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              {[
                ['Ceiling', `${report.limiter.ceilingDbtp} dBTP`],
                ['Pre-lim Peak', `${report.limiter.preGainDbtp.toFixed(1)} dBTP`],
                ['GR Applied', report.limiter.appliedGrDb > 0 ? `−${report.limiter.appliedGrDb.toFixed(2)} dB` : '없음'],
                ['Pre-lim LUFS', `${report.limiter.preLimLufs.toFixed(1)} LUFS`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-zinc-600">{k}</span>
                  <span className="font-mono text-zinc-400">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Loudnorm */}
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">라우드니스 정규화</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              {[
                ['Target', `${report.loudnorm.targetLufs} LUFS`],
                ['Measured Before', `${report.loudnorm.measuredBefore.toFixed(1)} LUFS`],
                ['Gain Applied', `${report.loudnorm.gainAppliedDb > 0 ? '+' : ''}${report.loudnorm.gainAppliedDb} dB`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-zinc-600">{k}</span>
                  <span className="font-mono text-zinc-400">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Spectral before/after */}
          {report.spectralBefore && report.spectralAfter && (
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">스펙트럴 밸런스 변화</p>
              <div className="space-y-1 text-[11px]">
                {specDelta(report.spectralBefore.lowToMidDb, report.spectralAfter.lowToMidDb, 'Low / Mid 비율')}
                {specDelta(report.spectralBefore.highToMidDb, report.spectralAfter.highToMidDb, 'High / Mid 비율')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ResultPage ────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const setPage         = useAppStore((s) => s.setPage);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const reset           = useAudioStore((s) => s.reset);
  const options         = useAudioStore((s) => s.options);

  const handleNewFile = useCallback(() => {
    reset();
    setPage('home');
  }, [reset, setPage]);

  const previewSrc = masteringResult?.previewPath
    ? toFileUrl(masteringResult.previewPath)
    : '';

  // Phase-E: surface a stable mode label for the section analyzer
  // (which may suggest a different mode than the user chose).
  const currentMode =
    masteringResult?.analysisReport?.mastering?.mode
    ?? options?.style
    ?? null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="결과"
        actions={
          <button
            onClick={handleNewFile}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            새 파일
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">

          {masteringResult?.analysisReport?.mastering && (
            <MasteringMetaCard meta={masteringResult.analysisReport.mastering} />
          )}
          <BeforeAfterCard />

          {/* v3.2 P2 — 시각적 비교 (전후 파형) */}
          {masteringResult && (
              masteringResult.compareWaveformPath
              || masteringResult.beforeWaveformPath
              || masteringResult.afterWaveformPath
            ) && (
            <WaveformCompareCard result={masteringResult} />
          )}

          {/* v3.2 P2 — 8 row 상세 비교 */}
          {masteringResult?.metricComparison?.length ? (
            <MetricComparisonTable rows={masteringResult.metricComparison} />
          ) : null}

          {masteringResult?.pipelineWarnings?.length ? (
            <WarningsCard warnings={masteringResult.pipelineWarnings} />
          ) : null}

          {/* Phase-E — Smart song-level recommendations (combines all Phase-D signals). */}
          <SmartRecommendationPanel
            sectionAnalysis={masteringResult?.sectionAnalysis ?? null}
            modeSuggestion={
              masteringResult?.modeSuggestion
              ?? masteringResult?.sectionAnalysis?.modeSuggestion
              ?? null
            }
            aiArtifactCheck={masteringResult?.aiArtifactCheck   ?? null}
            vocalIntelligence={masteringResult?.vocalIntelligence ?? null}
            translationCheck={masteringResult?.translationCheck   ?? null}
            currentMode={currentMode ?? undefined}
          />

          {/* Phase-E — Section timeline + DR / alternation / mode hint. */}
          <SectionAnalysisPanel
            analysis={masteringResult?.sectionAnalysis ?? null}
            currentMode={currentMode ?? undefined}
          />

          {/* Phase-E — AI artifact findings (only renders if any are present). */}
          <AIArtifactWarningPanel check={masteringResult?.aiArtifactCheck ?? null} />

          {previewSrc && <PreviewPlayer src={previewSrc} />}
          <SaveButtons />

          {/* Phase-E — Single-snapshot exportable report (TXT / JSON). */}
          <ExportReportPanel
            result={masteringResult ?? null}
            selectedMode={currentMode ?? undefined}
          />

          {/* v3.2 P2 — 새 자동 품질 검사가 있으면 그걸 사용, 없으면 legacy QCSummary */}
          {masteringResult?.qualityCheck ? (
            <QualityCheckCard report={masteringResult.qualityCheck} />
          ) : (
            <QCSummary />
          )}

          {/* v3.2 P3 — 적용된 Dynamic EQ 밴드 */}
          {masteringResult?.dynamicEq && (
            <DynamicEqCard report={masteringResult.dynamicEq} />
          )}

          {masteringResult?.analysisReport && (
            <AnalysisReportCard report={masteringResult.analysisReport} />
          )}

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
