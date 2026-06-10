// SurroundPanel — surround (5.1/7.1) source fold-down mastering (Phase 4).
//
// When a >2-channel source is fed, the export decodes all channels, folds them
// to stereo with the standard ITU-R BS.775 matrix (+ trims), and masters the
// fold-down.  Channel-based surround — not object-based Atmos authoring.
// Export-only; stereo sources are unaffected.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { SURROUND_TRIM_RANGE, LFE_RANGE } from '../audio/surround-config.js';

export default function SurroundPanel(): React.ReactElement {
  const s = useAudioStore((st) => st.surround);
  const update = useAudioStore((st) => st.updateSurround);
  const updateTrim = useAudioStore((st) => st.updateSurroundTrim);
  const reset = useAudioStore((st) => st.resetSurround);

  const lfeExcluded = s.trims.lfeDb <= LFE_RANGE.min;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={s.foldDownEnabled} onChange={(e) => update({ foldDownEnabled: e.target.checked })} aria-label="서라운드 폴드다운 사용" />
          서라운드 폴드다운 (5.1/7.1 → 스테레오)
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <div className={s.foldDownEnabled ? 'space-y-1.5' : 'space-y-1.5 opacity-50 pointer-events-none'}>
        <Slider label="센터" value={s.trims.centerDb} min={SURROUND_TRIM_RANGE.min} max={SURROUND_TRIM_RANGE.max} step={0.5}
          display={`${s.trims.centerDb > 0 ? '+' : ''}${s.trims.centerDb.toFixed(1)} dB`} onChange={(v) => updateTrim('centerDb', v)} />
        <Slider label="서라운드" value={s.trims.surroundDb} min={SURROUND_TRIM_RANGE.min} max={SURROUND_TRIM_RANGE.max} step={0.5}
          display={`${s.trims.surroundDb > 0 ? '+' : ''}${s.trims.surroundDb.toFixed(1)} dB`} onChange={(v) => updateTrim('surroundDb', v)} />
        <Slider label="LFE" value={s.trims.lfeDb} min={LFE_RANGE.min} max={LFE_RANGE.max} step={1}
          display={lfeExcluded ? '제외' : `${s.trims.lfeDb > 0 ? '+' : ''}${s.trims.lfeDb.toFixed(0)} dB`} onChange={(v) => updateTrim('lfeDb', v)} />
      </div>
      <p className="text-[10px] text-zinc-600">ITU-R BS.775 폴드다운 · 채널 기반 서라운드(객체 기반 Atmos 오서링 아님). 스테레오 소스는 영향 없음.</p>
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
