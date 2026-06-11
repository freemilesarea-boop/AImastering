// DeesserPanel — adaptive sibilance control (built on the Dynamic EQ).
//
// Drives `audioStore.deesser`, which is merged into the dynamic-EQ band list
// sent to the engine (export + opt-in worklet).  Like the dynamic EQ, there
// is no WebAudio-node approximation, so the always-on preview does NOT reflect
// it — the panel says so.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { DEESS_RANGES } from '../audio/deesser-config.js';

export default function DeesserPanel(): React.ReactElement {
  const d = useAudioStore((s) => s.deesser);
  const update = useAudioStore((s) => s.updateDeesser);
  const reset = useAudioStore((s) => s.resetDeesser);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={d.enabled} onChange={(e) => update({ enabled: e.target.checked })} aria-label="디에서 사용" />
          디에서 (시빌런스 제어) 사용
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => update({ enabled: true, freqHz: 6500, thresholdDb: -28, rangeDb: 6, q: 3.5, filterType: 'bell' })}
            className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
          >보컬 디에스</button>
          <button type="button" onClick={reset} className="text-[11px] text-zinc-300 hover:text-zinc-300">초기화</button>
        </div>
      </div>

      <p className="text-[11px] text-zinc-400">치찰음(4–10 kHz)이 임계값을 넘을 때만 동적으로 감쇠. Export + worklet 적용.</p>

      <div className={d.enabled ? 'space-y-2' : 'opacity-40 pointer-events-none space-y-2'}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400">필터</span>
          <select value={d.filterType} onChange={(e) => update({ filterType: e.target.value as 'bell' | 'highshelf' })}
            className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700">
            <option value="bell">벨 (좁은 노치)</option>
            <option value="highshelf">하이셸프 (전체 고역)</option>
          </select>
        </div>
        <Row label="주파수" value={d.freqHz} min={DEESS_RANGES.freqHz.min} max={DEESS_RANGES.freqHz.max} step={50} unit="Hz" onChange={(v) => update({ freqHz: v })} />
        <Row label="Threshold" value={d.thresholdDb} min={DEESS_RANGES.thresholdDb.min} max={DEESS_RANGES.thresholdDb.max} step={0.5} unit="dB" onChange={(v) => update({ thresholdDb: v })} />
        <Row label="감쇠량(Range)" value={d.rangeDb} min={DEESS_RANGES.rangeDb.min} max={DEESS_RANGES.rangeDb.max} step={0.5} unit="dB" onChange={(v) => update({ rangeDb: v })} />
        <Row label="Q" value={d.q} min={DEESS_RANGES.q.min} max={DEESS_RANGES.q.max} step={0.1} unit="" onChange={(v) => update({ q: v })} />
      </div>
    </div>
  );
}

function Row({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}): React.ReactElement {
  const disp = unit === '' ? value.toFixed(1) : unit === 'Hz' ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-zinc-400">{disp}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}
