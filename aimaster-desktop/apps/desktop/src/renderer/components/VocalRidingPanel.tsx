// VocalRidingPanel — automatic vocal level riding controls (P2).
//
// Rides the centre (vocal) level toward consistency on the offline EXPORT
// (M/S, centre only — sides untouched).  Live preview is unchanged.  No-op
// until enabled with amount > 0.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { VOCAL_RIDING_RANGES } from '../audio/vocal-riding-config.js';

export default function VocalRidingPanel(): React.ReactElement {
  const vr = useAudioStore((s) => s.vocalRiding);
  const update = useAudioStore((s) => s.updateVocalRiding);
  const reset = useAudioStore((s) => s.resetVocalRiding);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={vr.enabled} onChange={(e) => update({ enabled: e.target.checked })} aria-label="보컬 라이딩 사용" />
          보컬 라이딩 사용 (Export)
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <div className={vr.enabled ? 'space-y-1.5' : 'space-y-1.5 opacity-50 pointer-events-none'}>
        <Slider label="강도" value={vr.amount * 100} min={0} max={100} step={1} unit="%"
          display={`${Math.round(vr.amount * 100)}%`} onChange={(v) => update({ amount: v / 100 })} />
        <Slider label="최대 부스트" value={vr.maxBoostDb} min={VOCAL_RIDING_RANGES.boostCutDb.min} max={VOCAL_RIDING_RANGES.boostCutDb.max} step={0.5} unit="dB"
          display={`+${vr.maxBoostDb.toFixed(1)} dB`} onChange={(v) => update({ maxBoostDb: v })} />
        <Slider label="최대 컷" value={vr.maxCutDb} min={VOCAL_RIDING_RANGES.boostCutDb.min} max={VOCAL_RIDING_RANGES.boostCutDb.max} step={0.5} unit="dB"
          display={`-${vr.maxCutDb.toFixed(1)} dB`} onChange={(v) => update({ maxCutDb: v })} />
        <Slider label="반응" value={vr.responseMs} min={VOCAL_RIDING_RANGES.responseMs.min} max={VOCAL_RIDING_RANGES.responseMs.max} step={10} unit="ms"
          display={`${Math.round(vr.responseMs)} ms`} onChange={(v) => update({ responseMs: v })} />
      </div>
      <p className="text-[10px] text-zinc-600">센터(보컬) 대역 레벨을 추적해 일정하게 라이딩합니다. 사이드(악기·공간감)는 보존됩니다.</p>
    </div>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; display: string; onChange: (v: number) => void;
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
