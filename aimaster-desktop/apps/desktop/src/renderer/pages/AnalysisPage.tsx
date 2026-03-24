/**
 * Screen 2: Analysis
 *
 * Shown after the file is analyzed and before mastering begins.
 * Layout (single column, max-w-lg centered):
 *   TopBar
 *   File info card
 *   Loudness + QC card
 *   Silence card (only if notable silence detected)
 *   Style preset selector
 *   "마스터링 시작" primary action
 */
import React, { useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { AudioAnalysisResult, MasteringStyle, MasteringResult } from '@aimaster/shared-types';

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function formatBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── QC badge ──────────────────────────────────────────────────────────────────

type QCLevel = 'pass' | 'warn' | 'issue';

function qcLufs(lufs: number): QCLevel {
  if (lufs < -24) return 'warn';
  if (lufs > -6)  return 'issue';
  return 'pass';
}
function qcTp(tp: number): QCLevel {
  if (tp > -0.5) return 'issue';
  if (tp > -1.0) return 'warn';
  return 'pass';
}
function qcLra(lra: number): QCLevel {
  if (lra < 2.5) return 'issue';
  if (lra < 4.0) return 'warn';
  return 'pass';
}

const QC_COLORS: Record<QCLevel, string> = {
  pass:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warn:  'bg-amber-500/10  text-amber-400   border-amber-500/20',
  issue: 'bg-red-500/10    text-red-400     border-red-500/20',
};
const QC_LABELS: Record<QCLevel, string> = {
  pass:  '정상',
  warn:  '주의',
  issue: '확인 필요',
};

function QCBadge({ level }: { level: QCLevel }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px]
                      font-medium border ${QC_COLORS[level]}`}>
      {QC_LABELS[level]}
    </span>
  );
}

// ── Stat row ──────────────────────────────────────────────────────────────────

function StatRow({
  label, value, unit, badge,
}: {
  label: string;
  value: string;
  unit?: string;
  badge?: QCLevel;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-zinc-800 last:border-0">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex items-center gap-2">
        {badge && <QCBadge level={badge} />}
        <span className="font-mono text-sm text-zinc-200">
          {value}
          {unit && <span className="text-zinc-600 text-xs ml-0.5">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

// ── Style preset cards ────────────────────────────────────────────────────────

interface Preset {
  id: MasteringStyle;
  name: string;
  desc: string;
  hint: string;
}

const PRESETS: Preset[] = [
  {
    id:   'balanced',
    name: 'Balanced',
    desc: '중립적 처리',
    hint: '원음 보존 · 범용',
  },
  {
    id:   'warm',
    name: 'Warm',
    desc: '자연스럽고 따뜻한 음색',
    hint: '보컬 · 어쿠스틱 · 복고풍',
  },
  {
    id:   'bright',
    name: 'Bright',
    desc: '선명하고 뚜렷한 고역',
    hint: '팝 · 일렉트로닉 · 현대적',
  },
  {
    id:   'punch',
    name: 'Punch',
    desc: '강한 저음과 밀도감',
    hint: '힙합 · EDM · 댄스',
  },
];

function PresetCard({
  preset, selected, onSelect,
}: {
  preset: Preset;
  selected: boolean;
  onSelect: (id: MasteringStyle) => void;
}) {
  return (
    <button
      onClick={() => onSelect(preset.id)}
      className={`no-drag text-left p-3 rounded-xl border transition-all
                  ${selected
                    ? 'border-zinc-400 bg-zinc-800'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70'
                  }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={`text-sm font-medium ${selected ? 'text-zinc-100' : 'text-zinc-300'}`}>
          {preset.name}
        </span>
        {selected && (
          <span className="mt-0.5 w-2 h-2 rounded-full bg-zinc-300 shrink-0" />
        )}
      </div>
      <p className="mt-0.5 text-xs text-zinc-500 leading-snug">{preset.desc}</p>
      <p className="mt-1 text-[11px] text-zinc-700">{preset.hint}</p>
    </button>
  );
}

// ── AnalysisPage ──────────────────────────────────────────────────────────────

export default function AnalysisPage() {
  const setPage            = useAppStore((s) => s.setPage);
  const {
    selectedFile, analysis,
    options, setStyle,
    setIsMastering, setProgress, setError,
    setMasteringResult,
  } = useAudioStore();

  const handleStartMastering = useCallback(async () => {
    if (!selectedFile || !analysis) return;

    setIsMastering(true);
    setError(null);
    setPage('mastering');

    const cleanupProgress = window.electronAPI.on('audio:progress', (msg: unknown) => {
      const m = msg as { percent: number; stage: string };
      setProgress(m.percent, m.stage);
    });

    try {
      // outputPath is empty — main process generates a temp path
      const result = await window.electronAPI.invoke(
        'audio:master',
        selectedFile,
        '',
        {
          style:              options.style,
          targetLufs:         options.targetLufs,
          targetTp:           options.targetTp,
          sampleRate:         options.sampleRate,
          bitDepth:           options.bitDepth,
          applyAiCorrections: options.applyAiCorrections,
        },
      ) as MasteringResult;
      setMasteringResult(result);
      setPage('result');
    } catch (err) {
      setError((err as Error).message);
      // Stay on 'mastering' to show retry
    } finally {
      cleanupProgress();
      setIsMastering(false);
    }
  }, [selectedFile, analysis, options, setIsMastering, setError, setPage, setProgress, setMasteringResult]);

  if (!analysis) return null;

  const { fileInfo, loudness, silenceStartMs, silenceEndMs } = analysis as AudioAnalysisResult;
  const hasSilence = silenceStartMs > 500 || silenceEndMs > 500;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="분석 결과"
        actions={
          <button
            onClick={() => setPage('home')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            다른 파일
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">

          {/* ── File info ─────────────────────────────────────── */}
          <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
            <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">파일</p>
            <p className="text-sm font-medium text-zinc-200 truncate mb-3">
              {fileInfo.name}
            </p>
            <div className="grid grid-cols-3 gap-x-4 gap-y-1">
              {[
                { l: '형식',     v: fileInfo.format.toUpperCase() },
                { l: '샘플레이트', v: `${(fileInfo.sampleRate / 1000).toFixed(1)} kHz` },
                { l: '비트 뎁스', v: `${fileInfo.bitDepth}-bit` },
                { l: '채널',     v: fileInfo.channels === 1 ? 'Mono' : 'Stereo' },
                { l: '길이',     v: formatDuration(fileInfo.durationSec) },
                { l: '크기',     v: formatBytes(fileInfo.sizeBytes) },
              ].map(({ l, v }) => (
                <div key={l}>
                  <p className="text-[10px] text-zinc-600">{l}</p>
                  <p className="text-xs font-mono text-zinc-300 mt-0.5">{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Loudness + QC ─────────────────────────────────── */}
          <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
            <p className="text-xs text-zinc-600 uppercase tracking-wider mb-1">라우드니스</p>
            <StatRow
              label="Integrated Loudness"
              value={fmt(loudness.integratedLufs)}
              unit="LUFS"
              badge={qcLufs(loudness.integratedLufs)}
            />
            <StatRow
              label="True Peak"
              value={fmt(loudness.truePeakDbtp)}
              unit="dBTP"
              badge={qcTp(loudness.truePeakDbtp)}
            />
            <StatRow
              label="Loudness Range"
              value={fmt(loudness.lra)}
              unit="LU"
              badge={qcLra(loudness.lra)}
            />
          </div>

          {/* ── Silence (only if notable) ──────────────────────── */}
          {hasSilence && (
            <div className="rounded-xl bg-amber-500/5 border border-amber-500/15 p-4">
              <p className="text-xs text-amber-500/80 uppercase tracking-wider mb-2">묵음 구간</p>
              <div className="flex gap-6">
                {silenceStartMs > 500 && (
                  <div>
                    <p className="text-[10px] text-zinc-600">시작</p>
                    <p className="text-sm font-mono text-zinc-300">
                      {(silenceStartMs / 1000).toFixed(2)}
                      <span className="text-xs text-zinc-600 ml-0.5">s</span>
                    </p>
                  </div>
                )}
                {silenceEndMs > 500 && (
                  <div>
                    <p className="text-[10px] text-zinc-600">끝</p>
                    <p className="text-sm font-mono text-zinc-300">
                      {(silenceEndMs / 1000).toFixed(2)}
                      <span className="text-xs text-zinc-600 ml-0.5">s</span>
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Style preset ──────────────────────────────────── */}
          <div>
            <p className="text-xs text-zinc-600 uppercase tracking-wider mb-2">스타일 프리셋</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  selected={options.style === p.id}
                  onSelect={setStyle}
                />
              ))}
            </div>
          </div>

          {/* ── Start button ──────────────────────────────────── */}
          <button
            onClick={handleStartMastering}
            className="no-drag w-full py-3 rounded-xl text-sm font-medium
                       bg-zinc-100 text-zinc-900
                       hover:bg-white active:bg-zinc-200
                       transition-colors"
          >
            마스터링 시작
          </button>

          <div className="h-4" />

        </div>
      </div>
    </div>
  );
}
