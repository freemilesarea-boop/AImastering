// GenreReferencePanel — auto genre detection + Asian reference library (Phase 3).
//
// Detects the genre/mode from loudness + tonal tilt (live FFT when playing),
// recommends a mastering style + loudness target, and shows the closest
// copyright-safe Asian reference fingerprints.  One click applies the
// recommended style + target LUFS to the mastering options.

import React, { useMemo, useState } from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { getActiveSpectrumSnapshot } from '../audio/shared-audio-graph.js';
import { isUsableSpectrum, spectralBandsDb, tonalTilt } from '../audio/ai-music-spectral.js';
import { detectGenre } from '../audio/genre-detect.js';
import { matchReferences } from '../audio/reference-library.js';

const REGION_LABEL: Record<string, string> = { KR: '한국', JP: '일본', ASIA: '아시아' };

export default function GenreReferencePanel(): React.ReactElement {
  const analysis = useAudioStore((s) => s.analysis);
  const updateOptions = useAudioStore((s) => s.updateOptions);
  const [scanTick, setScanTick] = useState(0);

  const result = useMemo(() => {
    if (!analysis) return null;
    const frame = getActiveSpectrumSnapshot();
    const tilt = isUsableSpectrum(frame) ? tonalTilt(spectralBandsDb(frame)) : undefined;
    const feat = { lufs: analysis.loudness.integratedLufs, lra: analysis.loudness.lra, ...(tilt ? { tilt } : {}) };
    const genre = detectGenre(feat);
    const refs = matchReferences(feat, { genre: genre.top, limit: 3 });
    // If too few same-genre refs, widen.
    const refsWide = refs.length >= 2 ? refs : matchReferences(feat, { limit: 4 });
    return { genre, refs: refsWide };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, scanTick]);

  if (!analysis) return <p className="text-[11px] text-zinc-600">먼저 파일을 분석하면 장르를 추정합니다.</p>;
  if (!result) return <span />;

  const { genre, refs } = result;
  const conf = Math.round(genre.confidence * 100);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-300">추정 장르</span>
          <span className="text-[12px] font-semibold text-indigo-300">{genre.label}</span>
          <span className="text-[9px] text-zinc-500">신뢰도 {conf}%</span>
        </div>
        <button type="button" onClick={() => setScanTick((n) => n + 1)} className="text-[10px] text-zinc-500 hover:text-zinc-300"
          title="재생 중 누르면 스펙트럼으로 정밀 재추정">↻ 재추정</button>
      </div>

      <div className="flex gap-1 flex-wrap">
        {genre.candidates.map((c) => (
          <span key={c.genre} className={`text-[9px] px-1.5 py-0.5 rounded border ${c.genre === genre.top ? 'border-indigo-500/50 text-indigo-300' : 'border-zinc-700 text-zinc-500'}`}>{c.label}</span>
        ))}
      </div>

      <div className="rounded border border-zinc-800 p-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">추천 모드</span>
          <span className="text-[11px] font-mono text-zinc-300">{genre.recommendedStyle} · {genre.targetLufs} LUFS</span>
        </div>
        <button
          type="button"
          onClick={() => updateOptions({ style: genre.recommendedStyle, targetLufs: genre.targetLufs })}
          className="no-drag w-full py-1.5 rounded-lg text-[11px] font-medium bg-indigo-600/80 border border-indigo-500 text-white hover:bg-indigo-600 transition-colors"
        >추천 모드 적용</button>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] text-zinc-600 uppercase tracking-wider">가까운 아시아 레퍼런스 (톤 fingerprint)</p>
        {refs.map((m) => (
          <div key={m.ref.id} className="flex items-center justify-between rounded border border-zinc-800 px-2 py-1">
            <div className="flex items-center gap-2">
              <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400">{REGION_LABEL[m.ref.region]}</span>
              <span className="text-[11px] text-zinc-200">{m.ref.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-zinc-500">{m.ref.lufs} LUFS · LRA {m.ref.lra}</span>
              <button type="button" onClick={() => updateOptions({ targetLufs: m.ref.lufs, targetTp: m.ref.truePeakDbtp })}
                className="text-[9px] text-indigo-400 hover:text-indigo-300">타겟 적용</button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">레퍼런스는 저작권 안전한 톤 fingerprint(오디오·곡명 없음)입니다.</p>
    </div>
  );
}
