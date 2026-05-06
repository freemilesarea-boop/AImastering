/**
 * SectionAnalysisPanel — Phase-E UI for Phase-D `sectionAnalysis`.
 *
 * Renders:
 *   • A horizontal timeline of detected sections (verse/chorus/bridge…)
 *   • Dynamic range across sections (LU)
 *   • Verse/chorus alternation score (0–1)
 *   • Counts of high / mid / low energy sections
 *   • A "추천 모드" hint, ONLY when the analyzer's suggestion differs
 *     from the user's current selection.
 *
 * Safety contract:
 *   • If `analysis` is null/undefined the component renders nothing.
 *   • Any individual missing field (sections / dynamicRangeLu /
 *     alternationScore / modeSuggestion) is skipped silently.
 *   • All wording is conservative (Korean-first), per Phase-E rules.
 */
import React from 'react';
import type { SectionAnalysis, SectionSegment, SectionEnergy, MasteringStyle } from '@aimaster/shared-types';

interface Props {
  analysis?: SectionAnalysis | null | undefined;
  currentMode?: MasteringStyle | string | undefined;
}

const KIND_LABEL: Record<string, string> = {
  verse:      '벌스',
  chorus:     '코러스',
  bridge:     '브릿지',
  intro:      '인트로',
  outro:      '아웃트로',
  drop:       '드롭',
  breakdown:  '브레이크',
  unknown:    '구간',
};

const ENERGY_BAR: Record<SectionEnergy, string> = {
  high: 'bg-violet-500/70',
  mid:  'bg-sky-500/60',
  low:  'bg-zinc-600/60',
};

const ENERGY_LABEL: Record<SectionEnergy, string> = {
  high: '높음',
  mid:  '중간',
  low:  '낮음',
};

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function totalDuration(sections: SectionSegment[]): number {
  if (sections.length === 0) return 0;
  let max = 0;
  for (const s of sections) if (s.end > max) max = s.end;
  return max;
}

function Timeline({ sections }: { sections: SectionSegment[] }) {
  const total = totalDuration(sections);
  if (total <= 0) return null;

  return (
    <div>
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
        구간 타임라인
      </p>
      <div className="relative h-7 rounded-md overflow-hidden bg-zinc-950/80 flex">
        {sections.map((s, i) => {
          const width = Math.max(0, ((s.end - s.start) / total) * 100);
          if (width <= 0) return null;
          const label = s.label ?? KIND_LABEL[s.kind] ?? '구간';
          const energy: SectionEnergy = (s.energy === 'high' || s.energy === 'low') ? s.energy : 'mid';
          return (
            <div
              key={`${i}-${s.start}`}
              className={`relative h-full ${ENERGY_BAR[energy]} border-r border-zinc-950 last:border-r-0 flex items-center justify-center`}
              style={{ width: `${width}%` }}
              title={`${label} · ${fmtTime(s.start)}–${fmtTime(s.end)} · 에너지 ${ENERGY_LABEL[energy]}`}
            >
              {width > 8 && (
                <span className="text-[9px] uppercase tracking-wider text-zinc-100/90 truncate px-1">
                  {label}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-zinc-700 mt-1 font-mono">
        <span>0:00</span>
        <span>{fmtTime(total)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-zinc-950/60 rounded-md px-2.5 py-1.5">
      <div className="text-[10px] text-zinc-600">{label}</div>
      <div className="text-xs font-mono text-zinc-200">{value}</div>
      {hint && <div className="text-[9px] text-zinc-700 mt-0.5">{hint}</div>}
    </div>
  );
}

export function SectionAnalysisPanel({ analysis, currentMode }: Props) {
  if (!analysis) return null;

  const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
  const counts = analysis.sectionCounts ?? { high: 0, mid: 0, low: 0 };
  const dr = analysis.dynamicRangeLu;
  const alt = analysis.alternationScore;
  const mode = analysis.modeSuggestion;

  // Suggestion only surfaces when analyzer suggests a *different* mode.
  const showModeHint = !!mode
    && typeof mode.suggestedMode === 'string'
    && (currentMode == null || mode.suggestedMode !== currentMode);

  // If literally nothing useful is present, hide the whole card.
  const hasAnyData =
    sections.length > 0
    || dr !== null && dr !== undefined && Number.isFinite(dr)
    || alt !== null && alt !== undefined && Number.isFinite(alt)
    || showModeHint;

  if (!hasAnyData) return null;

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">구간 분석</p>
        <span className="text-[10px] text-zinc-700">
          {sections.length > 0 ? `${sections.length}개 구간` : '구간 미검출'}
        </span>
      </div>

      {sections.length > 0 && <Timeline sections={sections} />}

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="DR (LU)"
          value={dr !== null && dr !== undefined && Number.isFinite(dr) ? dr.toFixed(1) : '–'}
          hint="구간별 라우드니스 폭"
        />
        <Stat
          label="대비 점수"
          value={alt !== null && alt !== undefined && Number.isFinite(alt) ? alt.toFixed(2) : '–'}
          hint="벌스/코러스 차이"
        />
        <Stat
          label="강·중·약"
          value={`${counts.high} · ${counts.mid} · ${counts.low}`}
          hint="에너지별 구간 수"
        />
      </div>

      {showModeHint && mode && (
        <div className="rounded-md border border-violet-900/40 bg-violet-950/20 px-3 py-2">
          <p className="text-[11px] text-violet-300 font-medium">
            🎚 추천 모드: <span className="font-mono">{mode.suggestedMode}</span>
            {currentMode && (
              <span className="text-zinc-600">
                {' '}· 현재 <span className="font-mono">{currentMode}</span>
              </span>
            )}
          </p>
          {mode.reason && (
            <p className="text-[10px] text-violet-200/80 leading-snug mt-0.5">{mode.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default SectionAnalysisPanel;
