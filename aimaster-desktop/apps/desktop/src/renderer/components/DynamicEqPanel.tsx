// DynamicEqPanel — fully-parametric dynamic-EQ band-list editor (Phase 2).
//
// Drives `audioStore.dynamicEq`, applied on the Rust offline render (export)
// + the opt-in realtime worklet.  No WebAudio-node approximation, so the
// always-on preview does NOT reflect it (the panel says so).  Each band:
// type / freq / Q / threshold / ratio / range + mode (cut-when-loud /
// boost-when-quiet).

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import {
  FILTER_TYPES, FILTER_LABEL, MODE_LABEL, DYNEQ_RANGES, MAX_DYNEQ_BANDS,
  type DynEqFilterType, type DynEqMode,
} from '../audio/dyneq-config.js';

export default function DynamicEqPanel(): React.ReactElement {
  const cfg = useAudioStore((s) => s.dynamicEq);
  const update = useAudioStore((s) => s.updateDynamicEq);
  const addBand = useAudioStore((s) => s.addDynEqBand);
  const updateBand = useAudioStore((s) => s.updateDynEqBand);
  const removeBand = useAudioStore((s) => s.removeDynEqBand);
  const reset = useAudioStore((s) => s.resetDynamicEq);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={!cfg.bypass} onChange={(e) => update({ bypass: !e.target.checked })} aria-label="다이내믹 EQ 사용" />
          다이내믹 EQ 사용
        </label>
        <div className="flex gap-2">
          {cfg.bands.length > 0 && <button type="button" onClick={reset} className="text-[11px] text-zinc-300 hover:text-zinc-300">초기화</button>}
          <button type="button" onClick={() => addBand(1000)} disabled={cfg.bands.length >= MAX_DYNEQ_BANDS}
            className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 disabled:opacity-40">
            밴드 추가 ({cfg.bands.length}/{MAX_DYNEQ_BANDS})
          </button>
        </div>
      </div>

      <p className="text-[11px] text-zinc-400">Export + 실시간 worklet에 적용. 기본 미리듣기에는 반영되지 않습니다.</p>
      {cfg.bands.length === 0 && <p className="text-[11px] text-zinc-400">밴드를 추가하세요.</p>}

      <div className={cfg.bypass ? 'opacity-40 pointer-events-none space-y-2' : 'space-y-2'}>
        {cfg.bands.map((b) => (
          <div key={b.id} className="rounded border border-zinc-800 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={b.enabled} onChange={(e) => updateBand(b.id, { enabled: e.target.checked })} aria-label="밴드 사용" />
              <select value={b.filterType} onChange={(e) => updateBand(b.id, { filterType: e.target.value as DynEqFilterType })}
                className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700">
                {FILTER_TYPES.map((t) => <option key={t} value={t}>{FILTER_LABEL[t]}</option>)}
              </select>
              <select value={b.mode} onChange={(e) => updateBand(b.id, { mode: e.target.value as DynEqMode })}
                className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700">
                {(['downcut', 'upboost'] as DynEqMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
              <span className="ml-auto text-[11px] font-mono text-zinc-400">{Math.round(b.freqHz)} Hz</span>
              <button type="button" onClick={() => removeBand(b.id)} className="text-[11px] text-zinc-400 hover:text-red-400" aria-label="밴드 삭제">✕</button>
            </div>
            <Row label="주파수" value={b.freqHz} min={DYNEQ_RANGES.freqHz.min} max={DYNEQ_RANGES.freqHz.max} step={1} unit="Hz" onChange={(v) => updateBand(b.id, { freqHz: v })} />
            <Row label="Q" value={b.q} min={DYNEQ_RANGES.q.min} max={DYNEQ_RANGES.q.max} step={0.1} unit="" onChange={(v) => updateBand(b.id, { q: v })} />
            <Row label="Threshold" value={b.thresholdDb} min={DYNEQ_RANGES.thresholdDb.min} max={DYNEQ_RANGES.thresholdDb.max} step={0.5} unit="dB" onChange={(v) => updateBand(b.id, { thresholdDb: v })} />
            <Row label="Ratio" value={b.ratio} min={DYNEQ_RANGES.ratio.min} max={DYNEQ_RANGES.ratio.max} step={0.1} unit=":1" onChange={(v) => updateBand(b.id, { ratio: v })} />
            <Row label="Range" value={b.rangeDb} min={DYNEQ_RANGES.rangeDb.min} max={DYNEQ_RANGES.rangeDb.max} step={0.5} unit="dB" onChange={(v) => updateBand(b.id, { rangeDb: v })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}): React.ReactElement {
  const disp = unit === '' ? value.toFixed(1) : unit === 'Hz' ? `${Math.round(value)} ${unit}` : unit === ':1' ? `${value.toFixed(1)}${unit}` : `${value.toFixed(1)} ${unit}`;
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
