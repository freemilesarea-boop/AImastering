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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { handleLicenseRequired } from '../stores/licenseStore.js';
import type { MasteringOptions, RealtimeDspOverrides } from '../stores/audioStore.js';
import {
  installNativeDsp,
  applyNativeDspConfig,
  uninstallNativeDsp,
} from '../audio/shared-audio-graph.js';
import type { RealtimeChainConfig } from '../audio/realtime-mastering-chain.js';
import type {
  AnalysisReport as AnalysisReportType,
  MasteringMeta,
  MasteringResult,
  MetricComparisonRow,
  QualityCheckReport,
  DynamicEqReport,
} from '@aimaster/shared-types';
import { LIMITER_STRENGTH_LABELS } from '@aimaster/shared-types';
import type { MasteringStyle, LimiterStrength } from '@aimaster/shared-types';
import SectionAnalysisPanel from '../components/SectionAnalysisPanel.js';
import AIArtifactWarningPanel from '../components/AIArtifactWarningPanel.js';
import SmartRecommendationPanel from '../components/SmartRecommendationPanel.js';
import ExportReportPanel from '../components/ExportReportPanel.js';
import AchievementHeader from '../components/result/AchievementHeader.js';
import LoudnessDeltaBars from '../components/result/LoudnessDeltaBars.js';
import BeforeAfterWaveform from '../components/result/BeforeAfterWaveform.js';
import { isGuidedFlowEnabled } from '../audio/guided-flow-flag.js';
import { resumeSharedContext } from '../audio/shared-audio-graph.js';
import { AnalyzerPanelStack } from '../components/AnalyzerPanelStack.js';
import { reportFailure } from '../utils/reportFailure.js';
import { toFileUrl } from '../utils/fileUrl.js';

// ── Feature flags ─────────────────────────────────────────────────────────────
// Live WASM-based analysis (BS.1770 loudness, spectrum FFT, stereo scope)
// previously panicked the renderer with
//   loui_dsp_wasm_bg.wasm: assertion failed: psize <= size + max_overhead
//   → Uncaught RuntimeError: unreachable
// The dlmalloc corruption was caused by (a) a TOCTOU race in @loui/dsp-wasm's
// init() under React StrictMode and (b) a non-idempotent stop() that
// double-freed LouiAnalyzer pointers across runs.  Both are fixed now:
//   • wasm-analyzer-session.ts uses a module-level ensureWasmReady()
//     singleton so init() runs at most once per renderer lifetime.
//   • WasmAnalyzerSession.stop() is guarded with _stopped + _stopRequested
//     so concurrent / cleanup callers cannot re-enter free().
//   • WasmAnalyzerProvider invokes stop() exactly once (the cleanup fn).
//   • analyzer-tap worklet loads via the IPC blob bridge (asar-safe).
//   • electron-builder.yml unpacks *.wasm / *.worklet.js for renderer fetch
//     fallbacks.
// The <WasmAnalyzerSafe> error boundary below stays in place as
// belt-and-suspenders — any future regression collapses the panel into a
// small "실시간 분석 비활성 (WASM 오류)" label instead of tearing down
// the whole result page.
const ENABLE_RESULT_WASM_ANALYSIS = true;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1) { return n.toFixed(d); }

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

function PreviewPlayer({
  src,
  targetLufs,
}: {
  src: string;
  targetLufs?: number | undefined;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // Live loudness meter is mounted once the audio element has loaded its
  // metadata — without it `createMediaElementSource` rejects on some
  // platforms.  We also gate on `playing` so the worklet only runs while
  // the user is actually listening.
  const [meterReady, setMeterReady] = useState(false);

  // ── Live DSP — install native WebAudio chain on the element ──────────
  // Slider changes in TweakPanel feed `audioStore.options`.  We subscribe
  // here and push the derived chain config into the native DSP chain on
  // every change so EQ / Dynamics / Imager / Limiter edits are AUDIBLE
  // immediately while the file plays.  No re-render, no IPC, no Python.
  const options = useAudioStore((s) => s.options);
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !meterReady) return;
    try {
      installNativeDsp(a);
      applyNativeDspConfig(a, optionsToChainConfig(options));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[PreviewPlayer] native DSP install failed:', err);
    }
    return () => {
      try { uninstallNativeDsp(a); } catch { /* ignore */ }
    };
  // installNativeDsp is idempotent; we only need to install once per element
  // mount.  Config-only updates happen in the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterReady]);

  // Push new config on every options change (rAF-batched for free via React).
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !meterReady) return;
    try {
      applyNativeDspConfig(a, optionsToChainConfig(options));
    } catch { /* invalid config — skip */ }
  }, [options, meterReady]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      // Resume the shared WebAudio context INSIDE this user gesture.  Once the
      // element is captured by createMediaElementSource, its audio only flows
      // through the shared AudioContext — which starts 'suspended'.  Relying on
      // the provider's effect-based resume can miss the gesture window, leaving
      // the context suspended → no sound and the analyzer tap never receives
      // samples ("awaiting frames").  Resuming here, in the click handler,
      // guarantees a gesture-initiated resume.
      void resumeSharedContext();
      void a.play();
    } else {
      a.pause();
    }
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
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">프리뷰 (MP3)</p>
        <span className="flex items-center gap-1.5 text-[10px] text-zinc-600">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          실시간 DSP
        </span>
      </div>

      {/* Hidden audio element.
          NOTE: do NOT set crossOrigin here.  The aimaster-local scheme is
          registered `secure` but NOT `corsEnabled`, so a crossOrigin (CORS-mode)
          request is blocked by Chromium and the element never loads.  The
          scheme is trusted, so createMediaElementSource does not taint it. */}
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
          setMeterReady(true);
        }}
        onCanPlay={() => {
          // Safety net: if `loadedmetadata` is flaky on a platform, `canplay`
          // still arms the realtime DSP + meters (setMeterReady is idempotent).
          const a = audioRef.current;
          if (a && Number.isFinite(a.duration)) setDuration(a.duration);
          setMeterReady(true);
        }}
        onError={() => {
          // Codec / file-protocol / quarantined-resource failures land here.
          // We log a category-tight failure but keep the UI responsive —
          // the user can still try to export the MP3 file via "Save".
          const a = audioRef.current;
          const code = a?.error?.code;
          reportFailure({
            category: 'preview',
            message:  `<audio> error code=${code ?? 'unknown'}`,
            data:     { srcLength: src.length, code },
          });
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

      {/* Live BS.1770-4 / Spectrum / StereoScope meters were mounted here.
          HARD-DISABLED via ENABLE_RESULT_WASM_ANALYSIS — see top-of-file
          comment for why.  Static metadata (LUFS / TP / LRA) lives in
          BeforeAfterCard + MetricComparisonTable above. */}
      {ENABLE_RESULT_WASM_ANALYSIS && meterReady && audioRef.current && (
        <WasmAnalyzerSafe
          mediaElement={audioRef.current}
          active={playing}
          {...(typeof targetLufs === 'number' ? { targetLufs } : {})}
        />
      )}
    </div>
  );
}

// Error-boundary-style wrapper that swallows WASM panics so the rest of
// the result page keeps rendering even if loui_dsp_wasm_bg.wasm aborts.
class WasmAnalyzerSafe extends React.Component<
  { mediaElement: HTMLAudioElement; active: boolean; targetLufs?: number },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) {
    // eslint-disable-next-line no-console
    console.error('[ResultPage] WASM analyzer crashed — disabling for this session:', err);
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="mt-3 text-[10px] text-zinc-700 font-mono">
          실시간 분석 비활성 (WASM 오류)
        </div>
      );
    }
    return (
      <div className="mt-3">
        <AnalyzerPanelStack
          mediaElement={this.props.mediaElement}
          active={this.props.active}
          {...(typeof this.props.targetLufs === 'number' ? { targetLufs: this.props.targetLufs } : {})}
        />
      </div>
    );
  }
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
    try {
      const dest = await window.electronAPI.invoke(
        'file:save-wav',
        masteringResult.outputPath,
      ) as string | null;
      if (dest) notify('WAV 저장 완료', 'success');
    } catch (err) {
      if (handleLicenseRequired(err)) notify('마스터 음원 저장은 라이선스가 필요합니다', 'warning');
      else notify('WAV 저장 실패', 'error');
    }
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

// ── Realtime DSP wiring ──────────────────────────────────────────────────────

/**
 * Build a RealtimeChainConfig from a MasteringOptions object.  This is the
 * single source of truth for how store options map to the live WebAudio
 * DSP chain — used by the audio-element effect to push parameter changes
 * to the chain in real time.  Falls back to sensible defaults so the chain
 * never receives NaN even before the user touches a slider.
 */
function optionsToChainConfig(opts: MasteringOptions): RealtimeChainConfig {
  const rt: RealtimeDspOverrides = opts.rt ?? {};
  return {
    inputGainDb:    0,
    eqLowCutHz:     rt.eqLowCutHz     ?? 20,
    eqLowShelfDb:   rt.eqLowShelfDb   ?? 0,
    eqPresenceDb:   rt.eqPresenceDb   ?? 0,
    eqAirDb:        rt.eqAirDb        ?? 0,
    eqAdaptive:     opts.applyAiCorrections,
    eqBypass:       rt.eqBypass       ?? false,
    dynThresholdDb: rt.dynThresholdDb ?? -18,
    dynRatio:       rt.dynRatio       ?? 2,
    dynAttackMs:    rt.dynAttackMs    ?? 10,
    dynReleaseMs:   rt.dynReleaseMs   ?? 120,
    dynMixPct:      rt.dynMixPct      ?? 100,
    dynBypass:      rt.dynBypass      ?? false,
    imgWidthPct:    rt.imgWidthPct    ?? (opts.stereoWidth != null ? opts.stereoWidth * 100 : 100),
    imgLowMonoHz:   rt.imgLowMonoHz   ?? 120,
    imgBypass:      rt.imgBypass      ?? false,
    limCeilingDbtp: rt.limCeilingDbtp ?? opts.targetTp ?? -1,
    limLookaheadMs: 2.5,
    limIsp:         true,
    limBypass:      rt.limBypass      ?? false,
    outputGainDb:   opts.outputGainDb ?? 0,
    masterBypass:   rt.masterBypass   ?? false,
  };
}

// ── Slider row (right panel helper) ──────────────────────────────────────────

function SliderRow({
  label, value, min, max, step, unit, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  const display = unit === '%'
    ? `${Math.round(value)}${unit}`
    : unit === ''
      ? value.toFixed(2)
      : `${value >= 0 && unit === 'dB' ? '+' : ''}${value.toFixed(1)} ${unit}`;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline">
        <p className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</p>
        <span className="text-[11px] font-mono text-zinc-400">{display}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full cursor-pointer accent-indigo-500"
        style={{ height: '4px' }}
      />
    </div>
  );
}

// ── Right panel: fine-tuning controls ────────────────────────────────────────

const STYLES: Array<{ id: MasteringStyle; label: string; hint: string }> = [
  { id: 'balanced', label: 'Balanced', hint: '범용'   },
  { id: 'warm',     label: 'Warm',     hint: '따뜻한' },
  { id: 'bright',   label: 'Bright',   hint: '선명한' },
  { id: 'punch',    label: 'Punch',    hint: '강한'   },
];

const LIMITERS: Array<{ id: LimiterStrength; label: string }> = [
  { id: 'low',    label: '약하게' },
  { id: 'medium', label: '보통'   },
  { id: 'high',   label: '강하게' },
];

// Collapsible section wrapper.
function Section({
  title, defaultOpen = true, children,
}: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag w-full flex items-center justify-between px-3 py-2 hover:bg-zinc-800/30 transition-colors"
      >
        <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 font-semibold">{title}</span>
        <span className="text-[9px] text-zinc-600">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-3 border-t border-zinc-800/60">{children}</div>}
    </div>
  );
}

function TweakPanel({ onReMaster }: { onReMaster: () => void }) {
  const options       = useAudioStore((s) => s.options);
  const setStyle      = useAudioStore((s) => s.setStyle);
  const updateOptions = useAudioStore((s) => s.updateOptions);

  const rt = options.rt ?? {};
  const updateRt = useCallback((patch: Partial<NonNullable<MasteringOptions['rt']>>) => {
    updateOptions({ rt: { ...rt, ...patch } });
  }, [rt, updateOptions]);

  // Resolved display values.
  const widthDisplay = rt.imgWidthPct ?? (options.stereoWidth != null ? options.stereoWidth * 100 : 100);
  const gainDisplay  = options.outputGainDb ?? 0;

  return (
    <div className="p-3 space-y-3">
      {/* Header */}
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-300 font-semibold">세밀 조정</p>
        <p className="text-[10px] text-zinc-600 mt-0.5">슬라이더 조정 → 즉시 들립니다 (실시간 DSP)</p>
      </div>

      {/* ── Style preset ───────────────────────────────────────────────────── */}
      <Section title="Style">
        <div className="grid grid-cols-2 gap-1">
          {STYLES.map(({ id, label, hint }) => (
            <button
              key={id}
              onClick={() => setStyle(id)}
              className={`no-drag px-2 py-1.5 rounded-md text-left transition-colors ${
                options.style === id
                  ? 'bg-indigo-600/25 border border-indigo-500/50 text-indigo-300'
                  : 'bg-zinc-800/60 border border-zinc-700/60 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              <span className="block text-[11px] font-medium">{label}</span>
              <span className="block text-[9px] opacity-60 mt-0.5">{hint}</span>
            </button>
          ))}
        </div>
        <p className="text-[9px] text-zinc-700 leading-snug pt-1">
          저장 시 엔진은 스타일 프리셋 + 아래 슬라이더를 적용합니다.
        </p>
      </Section>

      {/* ── EQ section (live) ──────────────────────────────────────────────── */}
      <Section title="EQ">
        <SliderRow
          label="Low Cut"
          value={rt.eqLowCutHz ?? 20}
          min={20} max={200} step={1}
          unit="Hz"
          onChange={(v) => updateRt({ eqLowCutHz: v })}
        />
        <SliderRow
          label="Low Shelf (120Hz)"
          value={rt.eqLowShelfDb ?? 0}
          min={-12} max={12} step={0.1}
          unit="dB"
          onChange={(v) => updateRt({ eqLowShelfDb: v })}
        />
        <SliderRow
          label="Presence (3kHz)"
          value={rt.eqPresenceDb ?? 0}
          min={-12} max={12} step={0.1}
          unit="dB"
          onChange={(v) => updateRt({ eqPresenceDb: v })}
        />
        <SliderRow
          label="Air (12kHz)"
          value={rt.eqAirDb ?? 0}
          min={-12} max={12} step={0.1}
          unit="dB"
          onChange={(v) => updateRt({ eqAirDb: v })}
        />
      </Section>

      {/* ── Dynamics section (live) ────────────────────────────────────────── */}
      <Section title="Dynamics">
        <SliderRow
          label="Threshold"
          value={rt.dynThresholdDb ?? -18}
          min={-60} max={0} step={0.5}
          unit="dB"
          onChange={(v) => updateRt({ dynThresholdDb: v })}
        />
        <SliderRow
          label="Ratio"
          value={rt.dynRatio ?? 2}
          min={1} max={20} step={0.1}
          unit=""
          onChange={(v) => updateRt({ dynRatio: v })}
        />
        <SliderRow
          label="Attack"
          value={rt.dynAttackMs ?? 10}
          min={0.1} max={200} step={0.1}
          unit="ms"
          onChange={(v) => updateRt({ dynAttackMs: v })}
        />
        <SliderRow
          label="Release"
          value={rt.dynReleaseMs ?? 120}
          min={5} max={2000} step={1}
          unit="ms"
          onChange={(v) => updateRt({ dynReleaseMs: v })}
        />
        <div className="space-y-1.5 pt-1">
          <p className="text-[10px] text-zinc-600 uppercase tracking-wider">리미터 강도 (저장용)</p>
          <div className="flex gap-1">
            {LIMITERS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => updateOptions({ limiterStrength: id })}
                className={`no-drag flex-1 py-1.5 rounded-md text-[11px] transition-colors ${
                  options.limiterStrength === id
                    ? 'bg-zinc-600 text-zinc-100 border border-zinc-500'
                    : 'bg-zinc-800/60 border border-zinc-700/60 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Imager (live stereo width) ─────────────────────────────────────── */}
      <Section title="Stereo Imager">
        <SliderRow
          label="스테레오 폭"
          value={widthDisplay}
          min={0} max={200} step={1}
          unit="%"
          onChange={(v) => {
            updateRt({ imgWidthPct: v });
            updateOptions({ stereoWidth: v / 100 });
          }}
        />
        <SliderRow
          label="Low-Mono Freq"
          value={rt.imgLowMonoHz ?? 120}
          min={20} max={500} step={1}
          unit="Hz"
          onChange={(v) => updateRt({ imgLowMonoHz: v })}
        />
      </Section>

      {/* ── Loudness ───────────────────────────────────────────────────────── */}
      <Section title="Loudness">
        <SliderRow
          label="목표 라우드니스"
          value={options.targetLufs}
          min={-20} max={-8} step={0.5}
          unit="LUFS"
          onChange={(v) => updateOptions({ targetLufs: v })}
        />
        <SliderRow
          label="True Peak 한계"
          value={options.targetTp}
          min={-3} max={-0.1} step={0.1}
          unit="dBTP"
          onChange={(v) => updateOptions({ targetTp: v })}
        />
        <SliderRow
          label="출력 게인"
          value={gainDisplay}
          min={-6} max={6} step={0.1}
          unit="dB"
          onChange={(v) => updateOptions({ outputGainDb: v })}
        />
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-zinc-400">AI 보정 적용</span>
          <button
            onClick={() => updateOptions({ applyAiCorrections: !options.applyAiCorrections })}
            className={`no-drag relative w-9 h-5 rounded-full transition-colors ${
              options.applyAiCorrections ? 'bg-indigo-600' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                options.applyAiCorrections ? 'translate-x-4 left-0.5' : 'translate-x-0 left-0.5'
              }`}
            />
          </button>
        </div>
      </Section>

      {/* ── Format ─────────────────────────────────────────────────────────── */}
      <Section title="Format" defaultOpen={false}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">샘플레이트</span>
          <div className="flex gap-1">
            {([44100, 48000, 96000] as const).map((sr) => (
              <button
                key={sr}
                onClick={() => updateOptions({ sampleRate: sr })}
                className={`no-drag px-2 py-1 rounded text-[10px] transition-colors ${
                  options.sampleRate === sr
                    ? 'bg-zinc-600 text-zinc-100 border border-zinc-500'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
                }`}
              >
                {sr === 44100 ? '44.1k' : sr === 48000 ? '48k' : '96k'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">비트 심도</span>
          <div className="flex gap-1">
            {([16, 24] as const).map((bd) => (
              <button
                key={bd}
                onClick={() => updateOptions({ bitDepth: bd })}
                className={`no-drag px-2.5 py-1 rounded text-[10px] transition-colors ${
                  options.bitDepth === bd
                    ? 'bg-zinc-600 text-zinc-100 border border-zinc-500'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
                }`}
              >
                {bd}-bit
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Re-master CTA ──────────────────────────────────────────────────── */}
      <button
        onClick={onReMaster}
        className="no-drag w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 active:scale-[0.98]"
        style={{
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          color: '#fff',
          border: '1px solid rgba(99,102,241,0.4)',
        }}
      >
        다시 마스터링
      </button>

      <div className="h-2" />
    </div>
  );
}

// ── ResultPage ────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const setPage         = useAppStore((s) => s.setPage);
  const notify          = useAppStore((s) => s.notify);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const selectedFile    = useAudioStore((s) => s.selectedFile);
  const reset           = useAudioStore((s) => s.reset);
  const options         = useAudioStore((s) => s.options);

  // previewSrc is derived from masteringResult; live DSP edits are applied
  // to the <audio> element via the WebAudio native chain (see PreviewPlayer).

  // eslint-disable-next-line no-console
  console.log('[ResultPage] render entered');
  // eslint-disable-next-line no-console
  console.log('[ResultPage] masteringResult:', masteringResult);
  // eslint-disable-next-line no-console
  console.log('[ResultPage] outputPath exists:', Boolean(masteringResult?.outputPath));

  const handleNewFile = useCallback(() => {
    reset();
    setPage('home');
  }, [reset, setPage]);

  const handleReMaster = useCallback(() => {
    setPage('mastering');
  }, [setPage]);

  const handleOpenInFinder = useCallback(async () => {
    const path = masteringResult?.outputPath;
    if (!path) return;
    try {
      await window.electronAPI!.invoke('file:open-in-finder', path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ResultPage] open-in-finder failed:', err);
      notify('파일 위치를 열 수 없습니다.', 'error');
    }
  }, [masteringResult, notify]);

  // Fallback: if we end up here with no data, redirect to home immediately
  useEffect(() => {
    if (!masteringResult && !selectedFile) {
      // eslint-disable-next-line no-console
      console.warn('[ResultPage] missing result, fallback to home');
      setPage('home');
    }
  }, [masteringResult, selectedFile, setPage]);

  if (!masteringResult && !selectedFile) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh',
        background: '#13131A', color: '#a1a1aa', gap: '1rem',
      }}>
        <p style={{ fontSize: '0.875rem' }}>완성된 마스터링 결과가 없습니다. 음원을 업로드해주세요.</p>
        <button
          onClick={() => setPage('home')}
          style={{
            padding: '0.4rem 1.2rem', background: '#3f3f46', color: '#e4e4e7',
            border: '1px solid #52525b', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.8rem',
          }}
        >
          홈으로
        </button>
      </div>
    );
  }

  const previewSrc = masteringResult?.previewPath
    ? toFileUrl(masteringResult.previewPath)
    : masteringResult?.outputPath
      ? toFileUrl(masteringResult.outputPath)
      : '';

  // Phase-E: surface a stable mode label for the section analyzer
  // (which may suggest a different mode than the user chose).
  const currentMode =
    masteringResult?.analysisReport?.mastering?.mode
    ?? options?.style
    ?? null;

  const inputFileName = selectedFile
    ? (selectedFile.split('/').pop()?.split('\\').pop() ?? selectedFile)
    : null;
  const outputFileName = masteringResult?.outputPath
    ? (masteringResult.outputPath.split('/').pop()?.split('\\').pop() ?? masteringResult.outputPath)
    : null;

  // ── Guided flow result viz (T8) — real loudness metrics, flag-gated ──────
  const guided = isGuidedFlowEnabled();
  const guidedStyleKey = (options?.style ?? 'balanced') as string;
  const guidedIsKpop = guidedStyleKey === 'kpop_loud';
  const guidedGainLu = masteringResult
    ? (masteringResult.loudnessAfter.integratedLufs - masteringResult.loudnessBefore.integratedLufs)
    : 0;

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

      <div className="flex-1 flex overflow-hidden">
        {/* ── Left: result content (scrollable) ─────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="px-6 py-5 space-y-4 animate-in">

          {/* ── Guided flow: achievement + evidence (T8, flag-gated) ───────── */}
          {guided && masteringResult && (
            <div className="space-y-4">
              <AchievementHeader
                gainLu={guidedGainLu}
                styleKey={guidedStyleKey}
                title={guidedIsKpop ? 'KPOP LOUD 완성' : '더 커졌어요'}
                sub={guidedIsKpop ? '스트리밍에서 밀리지 않는 음압 완성' : '마스터링이 끝났어요'}
              />
              <LoudnessDeltaBars
                origLufs={masteringResult.loudnessBefore.integratedLufs}
                mastLufs={masteringResult.loudnessAfter.integratedLufs}
                targetLufs={options.targetLufs}
                styleKey={guidedStyleKey}
              />
              <BeforeAfterWaveform styleKey={guidedStyleKey} />
            </div>
          )}

          {/* ── 완료 메시지 ──────────────────────────────── */}
          {!guided && (
          <div className="rounded-xl bg-emerald-950/20 border border-emerald-900/40 px-4 py-3 flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="none"
                 stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
              <circle cx="10" cy="10" r="8" />
              <path d="M6.5 10.5l2.5 2.5 4.5-4.5" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-emerald-300">마스터링 완료</p>
              {inputFileName && (
                <p className="text-xs text-zinc-500 truncate mt-0.5" title={selectedFile ?? ''}>
                  {inputFileName}
                </p>
              )}
            </div>
          </div>
          )}

          {/* ── 출력 파일 정보 + 열기 버튼 ──────────────── */}
          {masteringResult?.outputPath && (
            <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 px-4 py-3 space-y-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">출력 파일</p>
              <p className="text-xs font-mono text-zinc-400 break-all leading-relaxed">
                {outputFileName}
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleOpenInFinder}
                  className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                             bg-zinc-800 border border-zinc-700 text-zinc-300
                             hover:border-zinc-600 hover:text-zinc-100 transition-colors"
                >
                  파일 위치 열기
                </button>
                <button
                  onClick={handleReMaster}
                  className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                             bg-zinc-800 border border-zinc-700 text-zinc-300
                             hover:border-zinc-600 hover:text-zinc-100 transition-colors"
                >
                  다시 마스터링
                </button>
              </div>
            </div>
          )}

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

          {previewSrc && (
            <PreviewPlayer
              src={previewSrc}
              {...(typeof masteringResult?.analysisReport?.mastering?.targetLufs === 'number'
                ? { targetLufs: masteringResult.analysisReport.mastering.targetLufs }
                : {})}
            />
          )}
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
        </div>{/* end left scroll */}

        {/* ── Right: fine-tuning panel (scrollable) ──────────────────────── */}
        <div className="w-64 shrink-0 border-l border-zinc-800 bg-zinc-900/20 overflow-y-auto">
          <TweakPanel onReMaster={handleReMaster} />
        </div>
      </div>
    </div>
  );
}
