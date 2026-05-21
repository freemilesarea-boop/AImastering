/**
 * Screen 1: Batch Queue Hub
 *
 * - Drag & drop or click to add up to 20 audio files at once
 * - Files appear in the queue with live status
 * - Single style selector applies to all files
 * - "모두 마스터링 시작" processes each file sequentially
 * - Per-item inline: progress bar, WAV download, MP3 download, preview player
 */
import React, { useCallback, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import {
  useAudioStore,
  toStructuredError,
  MAX_QUEUE_SIZE,
} from '../stores/audioStore.js';
import type { QueueItem } from '../stores/audioStore.js';
import type {
  AudioAnalysisResult,
  MasteringResult,
  MasteringStyle,
  LimiterStrength,
  MasteringQuickPreset,
} from '@aimaster/shared-types';
import {
  MASTERING_MODES,
  MASTERING_QUICK_PRESETS,
  LIMITER_STRENGTH_LABELS,
} from '@aimaster/shared-types';
// Hardened URL helper — escapes Korean, spaces, `#`, `?` per-segment so the
// main-side decoder receives the original path unmangled.
// Covered by `pnpm test:phase-e-paths`.
import { toFileUrl } from '../utils/fileUrl.js';
import { LouiPresetSlideOver } from '../components/product/LouiPresetSlideOver.js';
import { getPreset, DEFAULT_PRESET_ID } from '../audio/presets/loui-presets.js';
import { louiPresetToMasteringOptions } from '../audio/presets/preset-to-options.js';
import { getLastUsedPreset, setLastUsedPreset } from '../audio/presets/preset-storage.js';
import { LouiHomeHero } from '../components/home/LouiHomeHero.js';
import { loui, louiAlpha } from '../theme/loui-home.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCEPT = {
  'audio/wav':  ['.wav'],
  'audio/flac': ['.flac'],
  'audio/aiff': ['.aiff', '.aif'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4':  ['.m4a'],
};

// ── Icons ─────────────────────────────────────────────────────────────────────

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

// ── Mode selector (5 메인 + 2 legacy on Advanced) ────────────────────────────

function ModeSelector({
  selected,
  disabled,
  onChange,
  showLegacy,
}: {
  selected: MasteringStyle;
  disabled: boolean;
  onChange: (s: MasteringStyle) => void;
  showLegacy: boolean;
}) {
  const modes = showLegacy ? MASTERING_MODES : MASTERING_MODES.filter((m) => !m.legacy);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {modes.map((m) => {
        const active = selected === m.id;
        return (
          <button
            key={m.id}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            title={m.detail}
            className="no-drag py-2.5 px-2.5 rounded-xl text-xs font-medium transition-all text-left
                       disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              border: `1px solid ${active ? louiAlpha.lav(0.5) : loui.borderSubtle}`,
              background: active ? `linear-gradient(160deg, ${louiAlpha.lav(0.14)}, ${loui.panelElevated})` : loui.panelElevated,
              boxShadow: active ? `0 0 14px -3px ${loui.glowLavender}` : 'none',
              color: active ? '#fff' : '#a1a1aa',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = louiAlpha.lav(0.28); }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = loui.borderSubtle; }}
          >
            <div className="flex items-center gap-1.5">
              <span>{m.name}</span>
              {m.legacy && (
                <span className="text-[8px] text-zinc-600 border border-zinc-700 rounded px-0.5">L</span>
              )}
            </div>
            <div className="text-[10px] font-normal mt-0.5" style={{ color: active ? loui.softLavender : '#71717a' }}>{m.hint}</div>
            <div className="text-[9px] font-mono mt-0.5" style={{ color: active ? '#c4b5fd99' : '#52525b' }}>
              {m.targetLufs} LUFS · {m.targetTp} dBTP
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Quick preset bar (YouTube / Streaming / KPOP / EDM) ───────────────────────

function QuickPresetBar({
  current,
  disabled,
  onApply,
}: {
  current?: string | undefined;
  disabled: boolean;
  onApply: (p: MasteringQuickPreset) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {MASTERING_QUICK_PRESETS.map((p) => {
        const active = current === p.id;
        const streamingSafe = p.targetLufs <= -13;
        return (
          <button
            key={p.id}
            disabled={disabled}
            onClick={() => onApply(p)}
            className="no-drag py-2.5 px-2.5 rounded-xl text-left transition-all
                       disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              border: `1px solid ${active ? louiAlpha.lav(0.55) : loui.borderSubtle}`,
              background: active
                ? `linear-gradient(160deg, ${louiAlpha.lav(0.16)}, ${loui.panelElevated})`
                : loui.panelElevated,
              boxShadow: active ? `0 0 16px -3px ${loui.glowLavender}` : 'none',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = louiAlpha.lav(0.3); }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = loui.borderSubtle; }}
          >
            <div className="flex items-center gap-1.5">
              <span style={{
                width: 6, height: 6, borderRadius: 999, flexShrink: 0,
                background: active ? loui.primaryLavender : '#3f3f46',
                boxShadow: active ? `0 0 6px ${loui.primaryLavender}` : 'none',
              }} />
              <span className="text-xs font-semibold" style={{ color: active ? '#fff' : '#d4d4d8' }}>{p.name}</span>
            </div>
            <div className="text-[10px] font-mono mt-1" style={{ color: active ? loui.softLavender : '#71717a' }}>
              {p.targetLufs} LUFS · {p.targetTp} dBTP
            </div>
            {streamingSafe && (
              <div className="mt-1 inline-flex text-[8px] font-semibold tracking-wide px-1 py-0.5 rounded"
                   style={{ color: loui.successMint, border: `1px solid ${loui.successMint}55` }}>
                STREAMING-SAFE
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Slider primitive ─────────────────────────────────────────────────────────

function Slider({
  label, value, min, max, step, unit, hint, disabled, onChange, format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const display = format ? format(value) : value.toFixed(step >= 1 ? 0 : 1);
  return (
    <div className={`space-y-1.5 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex justify-between items-baseline text-[11px]">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono text-sm tabular-nums" style={{ color: loui.softLavender }}>
          {display}<span className="text-[10px] text-zinc-500">{unit ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="no-drag w-full h-1.5 cursor-pointer"
        style={{ accentColor: loui.primaryLavender }}
      />
      {hint && <p className="text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// ── Limiter strength segmented control ───────────────────────────────────────

function LimiterStrengthCtl({
  value, disabled, onChange,
}: {
  value: LimiterStrength;
  disabled: boolean;
  onChange: (v: LimiterStrength) => void;
}) {
  const opts: LimiterStrength[] = ['low', 'medium', 'high'];
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[11px]">
        <span className="text-zinc-400">Limiter Strength</span>
        <span className="font-mono" style={{ color: loui.softLavender }}>{LIMITER_STRENGTH_LABELS[value]}</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {opts.map((o) => {
          const active = value === o;
          return (
            <button
              key={o}
              disabled={disabled}
              onClick={() => onChange(o)}
              className="no-drag py-1.5 rounded-lg text-[11px] font-medium transition-all
                         disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                border: `1px solid ${active ? louiAlpha.lav(0.5) : loui.borderSubtle}`,
                background: active ? louiAlpha.lav(0.16) : loui.panelElevated,
                color: active ? '#fff' : '#a1a1aa',
                boxShadow: active ? `0 0 12px -4px ${loui.glowLavender}` : 'none',
              }}
            >
              {LIMITER_STRENGTH_LABELS[o]}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-zinc-600">
        High = 음압 강함 + 다이나믹 손상 가능 / Low = 부드럽고 자연스러움
      </p>
    </div>
  );
}

// ── Advanced Settings panel ──────────────────────────────────────────────────

function AdvancedSettingsPanel({ disabled }: { disabled: boolean }) {
  const showAdvanced     = useAudioStore((s) => s.showAdvanced);
  const setShowAdvanced  = useAudioStore((s) => s.setShowAdvanced);
  const options          = useAudioStore((s) => s.options);
  const updateOptions    = useAudioStore((s) => s.updateOptions);

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${loui.borderSubtle}`, background: loui.panelElevated }}>
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="no-drag w-full flex items-center justify-between px-3.5 py-3 text-left
                   text-xs text-zinc-300 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-[0.14em] font-medium" style={{ color: loui.softLavender }}>고급 설정</span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-500 font-mono truncate">
            {options.targetLufs} LUFS · {options.targetTp} dBTP · {LIMITER_STRENGTH_LABELS[options.limiterStrength]}
          </span>
        </span>
        <span className="text-[10px] text-zinc-500 shrink-0">{showAdvanced ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>

      {showAdvanced && (
        <div className="px-3.5 pb-3.5 pt-1 space-y-3.5" style={{ borderTop: `1px solid ${loui.borderSubtle}` }}>
          <Slider
            label="Target LUFS"
            value={options.targetLufs}
            min={-16} max={-7} step={0.5}
            unit="LUFS"
            disabled={disabled}
            hint="-14 = YouTube/Spotify · -11 = streaming loud · -9 = KPOP · -8 = EDM"
            onChange={(v) => updateOptions({ targetLufs: v, quickPreset: undefined })}
          />
          <Slider
            label="True Peak Ceiling"
            value={options.targetTp}
            min={-2.0} max={-0.3} step={0.1}
            unit="dBTP"
            disabled={disabled}
            hint="대부분 플랫폼은 -1.0 dBTP 이하 권장"
            onChange={(v) => updateOptions({ targetTp: v, quickPreset: undefined })}
          />
          <LimiterStrengthCtl
            value={options.limiterStrength}
            disabled={disabled}
            onChange={(v) => updateOptions({ limiterStrength: v, quickPreset: undefined })}
          />

          <details className="rounded-lg bg-[#13131A] border border-white/[0.06]">
            <summary className="px-2.5 py-1.5 text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300 select-none">
              선택 옵션 — Output Gain · Stereo Width · Saturation
            </summary>
            <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
              <Slider
                label="Output Gain"
                value={options.outputGainDb ?? 0}
                min={-6} max={6} step={0.5}
                unit="dB"
                disabled={disabled}
                hint="limiter 직전 출력 게인"
                onChange={(v) => updateOptions({ outputGainDb: v })}
              />
              <Slider
                label="Stereo Width"
                value={options.stereoWidth ?? 1.0}
                min={0.8} max={1.5} step={0.05}
                unit="x"
                disabled={disabled}
                hint="1.0 = 그대로 / >1 = 더 넓게"
                format={(v) => v.toFixed(2)}
                onChange={(v) => updateOptions({ stereoWidth: v })}
              />
              <Slider
                label="Saturation"
                value={options.saturationAmount ?? 0.2}
                min={0} max={1} step={0.05}
                disabled={disabled}
                hint="고조파 saturation 강도 (0 = off)"
                format={(v) => v.toFixed(2)}
                onChange={(v) => updateOptions({ saturationAmount: v })}
              />
              <button
                disabled={disabled}
                onClick={() => updateOptions({
                  outputGainDb: undefined,
                  stereoWidth: undefined,
                  saturationAmount: undefined,
                })}
                className="no-drag text-[10px] text-zinc-600 hover:text-zinc-400 underline disabled:opacity-40"
              >
                선택 옵션 초기화
              </button>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

// ── Mini audio player ─────────────────────────────────────────────────────────

function MiniPlayer({
  src,
  isActive,
  onActivate,
}: {
  src: string;
  isActive: boolean;
  onActivate: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // When another item becomes active, pause this one
  React.useEffect(() => {
    if (!isActive && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [isActive]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      onActivate();
      void a.play();
    } else {
      a.pause();
    }
  }, [onActivate]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  }, [duration]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-800/60">
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
          if (audioRef.current) setDuration(audioRef.current.duration);
        }}
      />

      <button
        onClick={toggle}
        className="no-drag w-7 h-7 flex items-center justify-center rounded-full
                   bg-zinc-700 hover:bg-zinc-600 text-zinc-200 shrink-0 transition-colors"
      >
        {playing ? (
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2" y="1.5" width="2.5" height="9" rx="0.5" />
            <rect x="7.5" y="1.5" width="2.5" height="9" rx="0.5" />
          </svg>
        ) : (
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 2l7 4-7 4V2z" />
          </svg>
        )}
      </button>

      <div className="flex-1 space-y-0.5">
        <div
          className="h-1 rounded-full bg-zinc-800 cursor-pointer overflow-hidden"
          onClick={handleSeek}
        >
          <div
            className="h-full rounded-full bg-zinc-500 transition-none"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="flex justify-between">
          <span className="text-[9px] font-mono text-zinc-700">{fmt(progress * duration)}</span>
          <span className="text-[9px] font-mono text-zinc-700">{duration ? fmt(duration) : '--:--'}</span>
        </div>
      </div>
    </div>
  );
}

// ── Queue item row ────────────────────────────────────────────────────────────

function QueueRow({
  item,
  activePlayerId,
  onSetActivePlayer,
  onRemove,
  onViewResult,
  onTweak,
  notify,
}: {
  item: QueueItem;
  activePlayerId: string | null;
  onSetActivePlayer: (id: string) => void;
  onRemove: (id: string) => void;
  onViewResult: (item: QueueItem) => void;
  onTweak: (item: QueueItem) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const previewSrc = item.masteringResult?.previewPath
    ? toFileUrl(item.masteringResult.previewPath)
    : '';

  const handleSaveWav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.masteringResult?.outputPath) return;
    const dest = await window.electronAPI!.invoke('file:save-wav', item.masteringResult.outputPath) as string | null;
    if (dest) notify('WAV 저장 완료', 'success');
  }, [item, notify]);

  const handleSaveMp3 = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.masteringResult?.previewPath) return;
    const dest = await window.electronAPI!.invoke('file:save-wav', item.masteringResult.previewPath) as string | null;
    if (dest) notify('MP3 저장 완료', 'success');
  }, [item, notify]);

  const statusDot = {
    pending:   'bg-zinc-700',
    analyzing: 'bg-amber-400 animate-pulse',
    mastering: 'bg-blue-400 animate-pulse',
    done:      'bg-emerald-400',
    error:     'bg-red-400',
  }[item.status];

  const statusLabel = {
    pending:   '대기',
    analyzing: '분석 중',
    mastering: item.progressStage || '처리 중',
    done:      '완료',
    error:     '오류',
  }[item.status];

  return (
    <div className={`rounded-xl border p-3 transition-colors
                     ${item.status === 'done'
                       ? 'border-white/[0.12] bg-surface-800/70'
                       : item.status === 'error'
                         ? 'border-red-900/40 bg-red-950/10'
                         : 'border-white/[0.08] bg-surface-800/50'
                     }`}
    >
      {/* Row 1: file name + status + tweak + remove */}
      <div className="flex items-center gap-2.5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span className="flex-1 text-xs text-zinc-300 truncate">{item.fileName}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">{statusLabel}</span>
        {(item.status === 'pending' || item.status === 'error') && (
          <button
            onClick={(e) => { e.stopPropagation(); onTweak(item); }}
            className="no-drag shrink-0 text-[11px] font-medium rounded-md px-2 py-1 transition-colors"
            style={{ color: loui.softLavender, border: `1px solid ${louiAlpha.lav(0.3)}`, background: louiAlpha.lav(0.08) }}
            title="원본을 들으며 설정을 조절하고 버전을 만듭니다"
          >
            조절하며 듣기
          </button>
        )}
        {(item.status === 'pending' || item.status === 'error') && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
            className="no-drag w-4 h-4 text-zinc-700 hover:text-zinc-400 transition-colors shrink-0"
          >
            <XIcon className="w-full h-full" />
          </button>
        )}
      </div>

      {/* Progress bar (mastering only) */}
      {item.status === 'mastering' && (
        <div className="mt-2">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500/70 transition-all duration-300"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {item.status === 'error' && item.error && (
        <p className="mt-1.5 text-[11px] text-red-400 leading-snug">
          {item.error.userMessage}
          {item.error.code === 'UNKNOWN' && item.error.devDetail !== item.error.userMessage && (
            <span className="block mt-0.5 text-red-500/70 break-all">[{item.error.devDetail}]</span>
          )}
        </p>
      )}

      {/* Done: LUFS info + download buttons + preview */}
      {item.status === 'done' && item.masteringResult && (
        <>
          {/* Stats */}
          <div className="mt-2 flex gap-3 text-[10px] font-mono text-zinc-600">
            <span>
              {item.masteringResult.loudnessAfter.integratedLufs.toFixed(1)} LUFS
            </span>
            <span>
              TP {item.masteringResult.loudnessAfter.truePeakDbtp.toFixed(1)} dBTP
            </span>
            <span>
              LRA {item.masteringResult.loudnessAfter.lra.toFixed(1)} LU
            </span>
          </div>

          {/* Buttons */}
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleSaveWav}
              className="no-drag flex-1 py-1.5 rounded-lg text-[11px] font-medium
                         bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
            >
              WAV 저장
            </button>
            <button
              onClick={handleSaveMp3}
              disabled={!previewSrc}
              className="no-drag flex-1 py-1.5 rounded-lg text-[11px] font-medium
                         bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              MP3 저장
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onViewResult(item); }}
              className="no-drag px-3 py-1.5 rounded-lg text-[11px]
                         border border-zinc-700 text-zinc-500 hover:text-zinc-300
                         hover:border-zinc-600 transition-colors"
            >
              상세
            </button>
          </div>

          {/* Mini player */}
          {previewSrc && (
            <MiniPlayer
              src={previewSrc}
              isActive={activePlayerId === item.id}
              onActivate={() => onSetActivePlayer(item.id)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Drop zone (used in both empty and queue states) ────────────────────────────

function DropZone({
  onFiles,
  isDisabled,
  compact,
}: {
  onFiles: (paths: string[]) => void;
  isDisabled: boolean;
  compact: boolean;
}) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      const paths = accepted.map((f) => (f as File & { path: string }).path).filter(Boolean);
      if (paths.length) onFiles(paths);
    },
    [onFiles],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxFiles: MAX_QUEUE_SIZE,
    multiple: true,
    disabled: isDisabled,
    noClick: false,
  });

  if (compact) {
    return (
      <div
        {...getRootProps()}
        className="no-drag flex items-center justify-center gap-2 w-full py-3
                   rounded-xl border border-dashed cursor-pointer transition-all"
        style={{
          borderColor: isDragActive ? louiAlpha.lav(0.6) : loui.borderSubtle,
          background: isDragActive ? louiAlpha.lav(0.08) : 'transparent',
          opacity: isDisabled ? 0.4 : 1,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        <input {...getInputProps()} />
        <UploadIcon className="w-4 h-4" />
        <span className="text-xs text-zinc-500">
          {isDragActive ? '파일을 놓으세요' : '파일 추가 (드래그 또는 클릭)'}
        </span>
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className="no-drag relative flex flex-col items-center justify-center
                 w-full rounded-2xl border-2 border-dashed transition-all duration-200
                 cursor-pointer select-none overflow-hidden"
      style={{
        minHeight: 230,
        borderColor: isDisabled ? loui.borderSubtle : isDragActive ? louiAlpha.lav(0.7) : louiAlpha.lav(0.25),
        background: isDragActive
          ? `radial-gradient(120% 120% at 50% 0%, ${louiAlpha.lav(0.16)}, ${loui.panelElevated})`
          : loui.panelElevated,
        transform: isDragActive ? 'scale(1.005)' : 'none',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        boxShadow: isDragActive ? `0 0 36px -8px ${loui.glowLavender}` : 'none',
      }}
    >
      <input {...getInputProps()} />
      {/* Ambient lavender glow */}
      <div aria-hidden style={{
        position: 'absolute', bottom: -50, left: '50%', transform: 'translateX(-50%)',
        width: 260, height: 120, background: loui.glowLavender, filter: 'blur(56px)',
        opacity: isDragActive ? 0.7 : 0.35, pointerEvents: 'none', transition: 'opacity 200ms',
      }} />
      {isDragActive ? (
        <div className="relative flex flex-col items-center gap-3">
          <svg className="w-10 h-10" style={{ color: loui.primaryLavender }} viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M2 12h2M20 12h2M6 8v8M18 8v8M10 5v14M14 5v14" />
          </svg>
          <p className="text-sm" style={{ color: loui.softLavender }}>파일을 놓으세요</p>
        </div>
      ) : (
        <div className="relative flex flex-col items-center gap-3 pointer-events-none">
          <span style={{
            width: 56, height: 56, borderRadius: 16,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: louiAlpha.lav(0.12), border: `1px solid ${louiAlpha.lav(0.28)}`,
            color: loui.primaryLavender,
          }}>
            <UploadIcon className="w-7 h-7" />
          </span>
          <div className="text-center">
            <p className="text-sm text-zinc-200">
              오디오 파일을 끌어다 놓거나&nbsp;
              <span style={{ color: loui.softLavender }} className="underline underline-offset-2">클릭해서 선택</span>
            </p>
            <p className="mt-1.5 text-xs text-zinc-500">
              WAV · FLAC · AIFF · MP3 · M4A &nbsp;·&nbsp; 최대 {MAX_QUEUE_SIZE}곡
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HomePage ──────────────────────────────────────────────────────────────────

export default function HomePage() {
  const setPage  = useAppStore((s) => s.setPage);
  const notify   = useAppStore((s) => s.notify);

  const {
    queue,
    isBatchRunning,
    options,
    showAdvanced,
    addFilesToQueue,
    removeFromQueue,
    clearQueue,
    updateQueueItem,
    setIsBatchRunning,
    setStyle,
    updateOptions,
    // single-file compat (for ResultPage navigation)
    setFile,
    setAnalysis,
    setMasteringResult,
  } = useAudioStore();

  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);

  // Official Loui preset browser (quick style selection before mastering).
  const [presetBrowserOpen, setPresetBrowserOpen] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | undefined>(undefined);
  const [previousPresetId, setPreviousPresetId] = useState<string | undefined>(undefined);
  const [lastUsedPresetId] = useState<string | undefined>(() => getLastUsedPreset() ?? undefined);

  // Selecting a Loui preset maps its renderable params into the master
  // options (style / loudness / ceiling / width / limiter strength).  No
  // master is triggered — the user still presses Master to apply.
  const handlePresetSelect = useCallback((id: string) => {
    const preset = getPreset(id);
    if (!preset) return;
    setPreviousPresetId(activePresetId);
    setActivePresetId(id);
    setLastUsedPreset(id);
    const o = louiPresetToMasteringOptions(preset);
    updateOptions({
      style:           o.style,
      targetLufs:      o.targetLufs,
      targetTp:        o.targetTp,
      stereoWidth:     o.stereoWidth,
      limiterStrength: o.limiterStrength,
      quickPreset:     undefined,
    });
  }, [activePresetId, updateOptions]);

  // ── Add files ─────────────────────────────────────────────────────────
  const handleFiles = useCallback((paths: string[]) => {
    addFilesToQueue(paths);
  }, [addFilesToQueue]);

  const handleOpenMulti = useCallback(async () => {
    const paths = await window.electronAPI!.invoke('file:open-dialog-multi') as string[] | null;
    if (paths?.length) addFilesToQueue(paths);
  }, [addFilesToQueue]);

  // ── Batch WAV/MP3 download ────────────────────────────────────────────
  const handleBatchSaveWav = useCallback(async () => {
    const wavPaths = queue
      .filter((i) => i.status === 'done' && i.masteringResult?.outputPath)
      .map((i) => i.masteringResult!.outputPath);
    if (!wavPaths.length) return;
    const res = await window.electronAPI!.invoke('file:batch-save-wav', wavPaths) as { destDir: string; saved: number } | null;
    if (res) notify(`WAV ${res.saved}곡 저장 완료`, 'success');
  }, [queue, notify]);

  const handleBatchSaveMp3 = useCallback(async () => {
    const mp3Paths = queue
      .filter((i) => i.status === 'done' && i.masteringResult?.previewPath)
      .map((i) => i.masteringResult!.previewPath);
    if (!mp3Paths.length) return;
    const res = await window.electronAPI!.invoke('file:batch-save-wav', mp3Paths) as { destDir: string; saved: number } | null;
    if (res) notify(`MP3 ${res.saved}곡 저장 완료`, 'success');
  }, [queue, notify]);

  // ── Navigate to detail view ───────────────────────────────────────────
  const handleViewResult = useCallback((item: QueueItem) => {
    if (!item.analysis || !item.masteringResult) return;
    setFile(item.filePath);
    setAnalysis(item.analysis);
    setMasteringResult(item.masteringResult);
    setPage('result');
  }, [setFile, setAnalysis, setMasteringResult, setPage]);

  // ── Tweak & Listen — open the workspace BEFORE mastering (source preview).
  // No master result required; ProductPage plays the source + lets the user
  // tweak and create the first version.  Queue is untouched.
  const handleTweakListen = useCallback((item: QueueItem) => {
    setFile(item.filePath);
    setAnalysis(item.analysis ?? null);
    setMasteringResult(item.masteringResult ?? null);
    setPage('result');
  }, [setFile, setAnalysis, setMasteringResult, setPage]);

  // ── Batch processing ──────────────────────────────────────────────────
  const handleStartBatch = useCallback(async () => {
    const pending = queue.filter((i) => i.status === 'pending' || i.status === 'error');
    if (!pending.length || isBatchRunning) return;

    setIsBatchRunning(true);

    for (const item of pending) {
      try {
        // Step 1: Analyze
        updateQueueItem(item.id, { status: 'analyzing' });
        const analysis = await window.electronAPI!.invoke('audio:analyze', item.filePath) as AudioAnalysisResult;
        updateQueueItem(item.id, { analysis, status: 'mastering', progress: 0 });

        // Step 2: Progress listener for this item
        const cleanupProgress = window.electronAPI!.on('audio:progress', (msg: unknown) => {
          const m = msg as { percent: number; stage: string };
          updateQueueItem(item.id, { progress: m.percent, progressStage: m.stage });
        });

        // Step 3: Master
        // analyze 단계에서 측정된 loudness 를 함께 넘긴다 — Python 이 별도
        // pass1 을 다시 돌리지 않게 해서 master 시간을 ~20% 단축한다.
        const result = await window.electronAPI!.invoke(
          'audio:master',
          item.filePath,
          '',
          {
            style:              options.style,
            targetLufs:         options.targetLufs,
            targetTp:           options.targetTp,
            sampleRate:         options.sampleRate,
            bitDepth:           options.bitDepth,
            applyAiCorrections: options.applyAiCorrections,
            limiterStrength:    options.limiterStrength,
            saturationAmount:   options.saturationAmount,
            stereoWidth:        options.stereoWidth,
            outputGainDb:       options.outputGainDb,
            aiDetections:       analysis.aiDetection ?? {},
          },
          {
            preLoudness: analysis.loudness,
          },
        ) as MasteringResult;

        cleanupProgress();
        updateQueueItem(item.id, { masteringResult: result, status: 'done', progress: 100 });

      } catch (err) {
        updateQueueItem(item.id, { error: toStructuredError(err), status: 'error', progress: 0 });
      }
    }

    setIsBatchRunning(false);
    const doneCount = useAudioStore.getState().queue.filter((i) => i.status === 'done').length;
    if (doneCount > 0) notify(`${doneCount}곡 마스터링 완료`, 'success');
  }, [queue, isBatchRunning, options, updateQueueItem, setIsBatchRunning, notify]);

  // ── Derived state ─────────────────────────────────────────────────────
  const pendingCount  = queue.filter((i) => i.status === 'pending' || i.status === 'error').length;
  const doneCount     = queue.filter((i) => i.status === 'done').length;
  const hasQueue      = queue.length > 0;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar />

      {/* Official Loui preset browser — quick style selection (pre-master). */}
      <LouiPresetSlideOver
        open={presetBrowserOpen}
        onClose={() => setPresetBrowserOpen(false)}
        recommendedId={DEFAULT_PRESET_ID}
        {...(activePresetId ? { activeId: activePresetId } : {})}
        {...(previousPresetId ? { previousId: previousPresetId } : {})}
        {...(lastUsedPresetId ? { lastUsedId: lastUsedPresetId } : {})}
        onSelect={handlePresetSelect}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-5 animate-in">

          {/* ── Hero — always visible brand + engine status ───── */}
          <LouiHomeHero engineReady />

          {/* ── Empty state ───────────────────────────────────── */}
          {!hasQueue && (
            <>
              <DropZone onFiles={handleFiles} isDisabled={false} compact={false} />
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-white/5" />
                <button
                  onClick={handleOpenMulti}
                  className="no-drag text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  파일 탐색기로 열기
                </button>
                <div className="flex-1 h-px bg-white/5" />
              </div>

              {/* Capability teaser — hints at the AI preset library before upload */}
              <button
                type="button"
                onClick={() => setPresetBrowserOpen(true)}
                className="no-drag w-full flex items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left transition-all"
                style={{
                  border: `1px solid ${loui.borderSubtle}`,
                  background: `radial-gradient(120% 140% at 100% 0%, ${louiAlpha.lav(0.10)} 0%, ${loui.panelElevated} 60%)`,
                }}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span aria-hidden style={{
                    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: louiAlpha.lav(0.14), border: `1px solid ${louiAlpha.lav(0.3)}`,
                    color: loui.primaryLavender,
                  }}>
                    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2.5" width="5" height="5" rx="1" /><rect x="9" y="2.5" width="5" height="5" rx="1" />
                      <rect x="2" y="8.5" width="5" height="5" rx="1" /><rect x="9" y="8.5" width="5" height="5" rx="1" />
                    </svg>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-100">전체 프리셋 둘러보기</span>
                    <span className="block text-[11px] text-zinc-500 truncate">
                      AI Pop · KPOP Loud · AI Vocal Cleaner 등 13개 공식 프리셋 · AI Special 포함
                    </span>
                  </span>
                </span>
                <span style={{ color: loui.softLavender }} className="text-lg shrink-0">›</span>
              </button>
            </>
          )}

          {/* ── Queue view ────────────────────────────────────── */}
          {hasQueue && (
            <>
              {/* Compact drop zone + add more button */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <DropZone
                    onFiles={handleFiles}
                    isDisabled={isBatchRunning || queue.length >= MAX_QUEUE_SIZE}
                    compact
                  />
                </div>
                <button
                  onClick={handleOpenMulti}
                  disabled={isBatchRunning || queue.length >= MAX_QUEUE_SIZE}
                  className="no-drag px-3 rounded-xl border border-zinc-800 text-xs text-zinc-600
                             hover:border-zinc-700 hover:text-zinc-400 transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  열기
                </button>
              </div>

              {/* Queue summary */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-600">
                  {queue.length}곡
                  {doneCount > 0 && (
                    <span className="text-emerald-500 ml-1.5">· {doneCount}곡 완료</span>
                  )}
                </span>
                <button
                  onClick={clearQueue}
                  disabled={isBatchRunning}
                  className="no-drag text-zinc-700 hover:text-zinc-500 transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  전체 삭제
                </button>
              </div>

              {/* File list */}
              <div className="space-y-2">
                {queue.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    activePlayerId={activePlayerId}
                    onSetActivePlayer={setActivePlayerId}
                    onRemove={removeFromQueue}
                    onViewResult={handleViewResult}
                    onTweak={handleTweakListen}
                    notify={notify}
                  />
                ))}
              </div>

              {/* Quick presets — YouTube / Streaming / KPOP / EDM */}
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <p className="text-[10px] uppercase tracking-[0.16em] font-medium" style={{ color: loui.softLavender }}>
                    빠른 프리셋
                  </p>
                  <button
                    type="button"
                    onClick={() => setPresetBrowserOpen(true)}
                    className="no-drag flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 transition-all"
                    style={{ color: loui.softLavender, border: `1px solid ${louiAlpha.lav(0.3)}`, background: louiAlpha.lav(0.08) }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = louiAlpha.lav(0.16); e.currentTarget.style.color = '#fff'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = louiAlpha.lav(0.08); e.currentTarget.style.color = loui.softLavender; }}
                  >
                    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2.5" width="5" height="5" rx="1" />
                      <rect x="9" y="2.5" width="5" height="5" rx="1" />
                      <rect x="2" y="8.5" width="5" height="5" rx="1" />
                      <rect x="9" y="8.5" width="5" height="5" rx="1" />
                    </svg>
                    전체 프리셋 · AI Special
                  </button>
                </div>
                <QuickPresetBar
                  current={options.quickPreset}
                  disabled={isBatchRunning}
                  onApply={(p) => updateOptions({
                    quickPreset:     p.id,
                    style:           p.style,
                    targetLufs:      p.targetLufs,
                    targetTp:        p.targetTp,
                    limiterStrength: p.limiterStrength,
                  })}
                />
              </div>

              {/* Mode selector — 5 메인 + 2 legacy(Advanced 펼침 시) */}
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] font-medium mb-2.5" style={{ color: loui.softLavender }}>
                  빠른 모드
                </p>
                <ModeSelector
                  selected={options.style}
                  disabled={isBatchRunning}
                  showLegacy={showAdvanced}
                  onChange={(s) => {
                    // 모드 선택 시 권장 LUFS / TP / limiter 동기화
                    const m = MASTERING_MODES.find((x) => x.id === s);
                    if (m) {
                      updateOptions({
                        style:           s,
                        targetLufs:      m.targetLufs,
                        targetTp:        m.targetTp,
                        limiterStrength: m.limiterStrength,
                        quickPreset:     undefined,
                      });
                    } else {
                      setStyle(s);
                    }
                  }}
                />
              </div>

              {/* Advanced sliders — LUFS / TP / Limiter / 선택 옵션 */}
              <AdvancedSettingsPanel disabled={isBatchRunning} />

              {/* Start button — primary lavender CTA */}
              {pendingCount > 0 && (
                <button
                  onClick={handleStartBatch}
                  disabled={isBatchRunning}
                  className="no-drag w-full py-3.5 rounded-2xl text-sm font-semibold transition-all
                             flex items-center justify-center gap-2
                             disabled:cursor-not-allowed"
                  style={isBatchRunning ? {
                    background: loui.panelElevated,
                    color: loui.softLavender,
                    border: `1px solid ${louiAlpha.lav(0.3)}`,
                  } : {
                    background: `linear-gradient(135deg, ${loui.activeViolet}, ${loui.primaryLavender})`,
                    color: '#0E0E14',
                    boxShadow: `0 6px 20px -6px ${loui.glowLavender}, 0 0 0 1px ${louiAlpha.lav(0.4)}`,
                  }}
                  onMouseEnter={(e) => { if (!isBatchRunning) e.currentTarget.style.filter = 'brightness(1.08)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
                >
                  {isBatchRunning ? (
                    <>
                      <span aria-hidden className="animate-spin" style={{
                        width: 13, height: 13, borderRadius: 999,
                        border: `2px solid ${louiAlpha.lav(0.3)}`, borderTopColor: loui.primaryLavender,
                        display: 'inline-block',
                      }} />
                      마스터링 처리 중…
                    </>
                  ) : (
                    <>
                      <svg width={15} height={15} viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5l9 5.5-9 5.5V2.5z" /></svg>
                      마스터링 시작 ({pendingCount}곡)
                    </>
                  )}
                </button>
              )}

              {/* Batch download — shown as soon as ≥1 item is done */}
              {doneCount > 0 && !isBatchRunning && (
                <div className="space-y-2">
                  <p className="text-[10px] text-zinc-600 uppercase tracking-wider">일괄 저장</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleBatchSaveWav}
                      className="no-drag flex-1 py-2 rounded-xl text-xs font-medium
                                 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
                    >
                      전체 WAV 저장 ({doneCount}곡)
                    </button>
                    <button
                      onClick={handleBatchSaveMp3}
                      className="no-drag flex-1 py-2 rounded-xl text-xs font-medium
                                 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
                    >
                      전체 MP3 저장 ({doneCount}곡)
                    </button>
                  </div>
                </div>
              )}

              {/* All done CTA */}
              {doneCount > 0 && pendingCount === 0 && !isBatchRunning && (
                <button
                  onClick={clearQueue}
                  className="no-drag w-full py-2.5 rounded-xl text-xs font-medium
                             border border-zinc-800 text-zinc-600
                             hover:border-zinc-700 hover:text-zinc-400 transition-colors"
                >
                  큐 비우기 · 새 파일 추가
                </button>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
