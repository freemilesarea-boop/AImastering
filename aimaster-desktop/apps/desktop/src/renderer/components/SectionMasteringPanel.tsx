// SectionMasteringPanel — per-section gain automation editor (P2).
//
// Mirrors the detected sections (verse/chorus/…) into per-section gain sliders.
// Applies on the offline EXPORT (a smooth crossfaded gain envelope) — the live
// preview is unchanged.  No-op until enabled with a non-zero gain.

import React, { useEffect } from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { SECTION_GAIN_RANGE } from '../audio/section-plan.js';

const KIND_LABEL: Record<string, string> = {
  verse: '벌스', chorus: '코러스', bridge: '브릿지', intro: '인트로',
  outro: '아웃트로', drop: '드롭', breakdown: '브레이크', unknown: '구간',
};

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SectionMasteringPanel(): React.ReactElement {
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const plan = useAudioStore((s) => s.sectionPlan);
  const sync = useAudioStore((s) => s.syncSectionPlan);
  const setGain = useAudioStore((s) => s.setSectionGain);
  const toggle = useAudioStore((s) => s.toggleSectionPlan);
  const reset = useAudioStore((s) => s.resetSectionPlan);

  const sections = masteringResult?.sectionAnalysis?.sections;

  // Keep the plan's gain rows in step with the detected sections.
  useEffect(() => { sync(sections); }, [sections, sync]);

  if (!sections || sections.length === 0) {
    return <p className="text-[11px] text-zinc-400">구간 분석 결과가 없습니다. 먼저 파일을 분석하면 벌스/코러스별 게인을 조정할 수 있습니다.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={plan.enabled} onChange={(e) => toggle(e.target.checked)} aria-label="구간별 마스터링 사용" />
          구간별 게인 사용 (Export)
        </label>
        <button type="button" onClick={reset} className="text-[11px] text-zinc-300 hover:text-zinc-300">초기화</button>
      </div>

      <div className={plan.enabled ? 'space-y-1.5' : 'space-y-1.5 opacity-50 pointer-events-none'}>
        {sections.map((sec, i) => {
          const g = plan.gains[i];
          const gain = g?.gainDb ?? 0;
          const kind = KIND_LABEL[sec.kind] ?? '구간';
          return (
            <div key={`${sec.start}-${i}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-zinc-400">{sec.label ?? kind} <span className="text-zinc-400">{fmtTime(sec.start)}–{fmtTime(sec.end)}</span></span>
                <span className="text-[11px] font-mono text-zinc-400">{gain > 0 ? '+' : ''}{gain.toFixed(1)} dB</span>
              </div>
              <input
                type="range" min={SECTION_GAIN_RANGE.min} max={SECTION_GAIN_RANGE.max} step={0.5} value={gain}
                onChange={(e) => setGain(i, parseFloat(e.target.value))}
                aria-label={`${kind} 게인`} className="w-full"
              />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-400">경계는 부드럽게 크로스페이드되며, 마스터링 체인이 구간을 자연스럽게 결합합니다.</p>
    </div>
  );
}
