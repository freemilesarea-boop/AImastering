// SurroundPanel — surround (5.1/7.1) source mastering (Phase 4).
//
// Two modes (export-only; stereo sources are unaffected):
//   • 폴드다운  — BS.775 fold-down to stereo, mastered by the stereo chain.
//   • 멀티채널  — keep the layout; master gain + linked true-peak limiter.
// Channel-based surround — not object-based Atmos authoring.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { SURROUND_TRIM_RANGE, LFE_RANGE, MASTER_GAIN_RANGE, CEILING_RANGE } from '../audio/surround-config.js';

export default function SurroundPanel(): React.ReactElement {
  const s = useAudioStore((st) => st.surround);
  const update = useAudioStore((st) => st.updateSurround);
  const updateTrim = useAudioStore((st) => st.updateSurroundTrim);
  const reset = useAudioStore((st) => st.resetSurround);

  const lfeExcluded = s.trims.lfeDb <= LFE_RANGE.min;
  const multichannel = s.mode === 'multichannel';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={s.foldDownEnabled} onChange={(e) => update({ foldDownEnabled: e.target.checked })} aria-label="서라운드 처리 사용" />
          서라운드 처리 (5.1/7.1)
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <div className={s.foldDownEnabled ? 'space-y-2' : 'space-y-2 opacity-50 pointer-events-none'}>
        {/* Mode selector */}
        <div className="flex gap-1 text-[10px]">
          {(['foldDown', 'multichannel'] as const).map((m) => (
            <button key={m} type="button" onClick={() => update({ mode: m })}
              className={`flex-1 rounded px-2 py-1 ${s.mode === m ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
              {m === 'foldDown' ? '폴드다운 (스테레오)' : '멀티채널 출력'}
            </button>
          ))}
        </div>

        {!multichannel && (
          <div className="space-y-1.5">
            <Slider label="센터" value={s.trims.centerDb} min={SURROUND_TRIM_RANGE.min} max={SURROUND_TRIM_RANGE.max} step={0.5}
              display={`${s.trims.centerDb > 0 ? '+' : ''}${s.trims.centerDb.toFixed(1)} dB`} onChange={(v) => updateTrim('centerDb', v)} />
            <Slider label="서라운드" value={s.trims.surroundDb} min={SURROUND_TRIM_RANGE.min} max={SURROUND_TRIM_RANGE.max} step={0.5}
              display={`${s.trims.surroundDb > 0 ? '+' : ''}${s.trims.surroundDb.toFixed(1)} dB`} onChange={(v) => updateTrim('surroundDb', v)} />
            <Slider label="LFE" value={s.trims.lfeDb} min={LFE_RANGE.min} max={LFE_RANGE.max} step={1}
              display={lfeExcluded ? '제외' : `${s.trims.lfeDb > 0 ? '+' : ''}${s.trims.lfeDb.toFixed(0)} dB`} onChange={(v) => updateTrim('lfeDb', v)} />
            <p className="text-[10px] text-zinc-600">ITU-R BS.775 폴드다운 → 스테레오 체인으로 마스터.</p>
          </div>
        )}

        {multichannel && (
          <div className="space-y-1.5">
            <Slider label="마스터 게인" value={s.masterGainDb} min={MASTER_GAIN_RANGE.min} max={MASTER_GAIN_RANGE.max} step={0.5}
              display={`${s.masterGainDb > 0 ? '+' : ''}${s.masterGainDb.toFixed(1)} dB`} onChange={(v) => update({ masterGainDb: v })} />
            <Slider label="트루피크 실링" value={s.ceilingDb} min={CEILING_RANGE.min} max={CEILING_RANGE.max} step={0.1}
              display={`${s.ceilingDb.toFixed(1)} dBTP`} onChange={(v) => update({ ceilingDb: v })} />
            <label className="flex items-center gap-2 text-[10px] text-zinc-400">
              <input type="checkbox" checked={s.perChannelChain} onChange={(e) => update({ perChannelChain: e.target.checked })} aria-label="베드별 풀 체인" />
              베드별 풀 체인 (EQ/컴프/새추레이션)
            </label>
            <p className="text-[10px] text-zinc-600">레이아웃 보존 · (옵션) 베드별 풀 체인 → 목표 LUFS 자동매칭(BS.1770) + 마스터 게인 트림 + 채널 링크드 트루피크 리미터(이미징 보존). 출력은 멀티채널 WAV.</p>
          </div>
        )}
      </div>
      <p className="text-[10px] text-zinc-600">채널 기반 서라운드(객체 기반 Atmos 오서링 아님). 스테레오 소스는 영향 없음.</p>
    </div>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] text-zinc-500">{label}</span>
        <span className="text-[10px] font-mono text-zinc-400">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} aria-label={label} className="w-full" />
    </div>
  );
}
