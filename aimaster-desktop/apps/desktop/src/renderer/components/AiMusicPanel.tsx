// AiMusicPanel — AI-generated music mode (Phase 3).
//
// Reads the current input analysis, detects Suno/Udio-style artefacts, and
// offers a one-click correction built from the Phase-2 modules (dynamic EQ /
// de-esser / transient / imager).  The correction applies on export + preview
// like any module config.

import React, { useMemo } from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { detectAiMusic, buildAiMusicFeatures } from '../audio/ai-music.js';

export default function AiMusicPanel(): React.ReactElement {
  const analysis = useAudioStore((s) => s.analysis);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const apply = useAudioStore((s) => s.applyAiMusicCorrection);

  const report = useMemo(() => {
    if (!analysis) return null;
    const sb = masteringResult?.spectralBalance ?? null;
    const extra = sb ? { highToMidDb: sb.highToMidDb, lowToMidDb: sb.lowToMidDb } : {};
    return detectAiMusic(buildAiMusicFeatures(analysis, extra));
  }, [analysis, masteringResult]);

  if (!analysis) {
    return <p className="text-[11px] text-zinc-600">먼저 파일을 분석/마스터링하면 AI 음악 아티팩트를 검사합니다.</p>;
  }
  if (!report) return <span />;

  const badge = report.severity === 'warn' ? 'text-amber-400 border-amber-500/40'
    : report.severity === 'info' ? 'text-sky-400 border-sky-500/40'
    : 'text-emerald-400 border-emerald-500/40';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-300">AI 생성곡 아티팩트 검사</p>
        <span className={`text-[10px] px-2 py-0.5 rounded border ${badge}`}>
          {report.detected ? `${report.findings.length}건 검출` : '아티팩트 없음'}
        </span>
      </div>

      {!report.detected && (
        <p className="text-[11px] text-zinc-500">AI 음악 특유의 아티팩트가 감지되지 않았습니다. (일반 마스터링 권장)</p>
      )}

      <div className="space-y-1.5">
        {report.findings.map((fnd) => (
          <div key={fnd.id} className="rounded border border-zinc-800 p-2">
            <div className="flex items-center gap-2">
              <span className={`text-[9px] px-1 rounded ${fnd.severity === 'warn' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>
                {fnd.severity === 'warn' ? '주의' : '정보'}
              </span>
              <span className="text-[11px] text-zinc-200">{fnd.label}</span>
            </div>
            <p className="text-[10px] text-zinc-500 mt-1 leading-tight">{fnd.detail}</p>
          </div>
        ))}
      </div>

      {report.detected && (
        <button
          type="button"
          onClick={() => apply(report.correction)}
          className="no-drag w-full py-2 rounded-lg text-[11px] font-medium
                     bg-indigo-600/80 border border-indigo-500 text-white hover:bg-indigo-600 transition-colors"
        >
          AI 음악 보정 적용 (다이내믹EQ·디에서·트랜지언트·이미저 설정)
        </button>
      )}
      <p className="text-[10px] text-zinc-600">보정 적용 후 각 모듈 패널에서 세부 조정 가능. Export에 적용됩니다.</p>
    </div>
  );
}
