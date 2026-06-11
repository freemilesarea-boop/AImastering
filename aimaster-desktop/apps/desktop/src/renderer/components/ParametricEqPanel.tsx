// ParametricEqPanel — compact free parametric EQ control (C-1).
//
// Drives `audioStore.parametricEqBands`.  ResultPage splices these bands into
// the live preview chain via `setFreeEqBands`, so edits are AUDIBLE in real
// time (unlike the dormant DraggableParametricEqEditor, which is curve-only).
//
// Deliberately minimal: a band list with type / freq / gain / Q controls +
// enable + remove, and an "add band" button (capped at MAX_BANDS).  No
// drag-canvas — that lives in the product module suite for a later milestone.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import {
  type ParametricBandType,
  MIN_FREQ_HZ, MAX_FREQ_HZ, MIN_GAIN_DB, MAX_GAIN_DB, MIN_Q, MAX_Q, MAX_BANDS,
} from '../audio/modules/parametric-eq-model.js';

const TYPES: ParametricBandType[] = ['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass'];
const TYPE_LABEL: Record<ParametricBandType, string> = {
  highpass: '하이패스', lowshelf: '로우셸프', bell: '벨', highshelf: '하이셸프', lowpass: '로우패스',
};

export default function ParametricEqPanel(): React.ReactElement {
  const bands = useAudioStore((s) => s.parametricEqBands);
  const addBand = useAudioStore((s) => s.addParametricBand);
  const updateBand = useAudioStore((s) => s.updateParametricBand);
  const removeBand = useAudioStore((s) => s.removeParametricBand);
  const resetEq = useAudioStore((s) => s.resetParametricEq);

  const usesGain = (t: ParametricBandType): boolean => t !== 'highpass' && t !== 'lowpass';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-400 uppercase tracking-wider">파라메트릭 EQ (실시간)</p>
        <div className="flex gap-2">
          {bands.length > 0 && (
            <button
              type="button"
              onClick={resetEq}
              className="text-[11px] text-zinc-300 hover:text-zinc-300"
            >초기화</button>
          )}
          <button
            type="button"
            onClick={() => addBand(1000)}
            disabled={bands.length >= MAX_BANDS}
            className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 disabled:opacity-40"
          >밴드 추가 ({bands.length}/{MAX_BANDS})</button>
        </div>
      </div>

      {bands.length === 0 && (
        <p className="text-[11px] text-zinc-400">밴드를 추가하면 재생 중 즉시 들립니다.</p>
      )}

      <div className="space-y-2">
        {bands.map((b) => (
          <div key={b.id} className="rounded border border-zinc-800 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={(e) => updateBand(b.id, { enabled: e.target.checked })}
                aria-label="밴드 사용"
              />
              <select
                value={b.type}
                onChange={(e) => updateBand(b.id, { type: e.target.value as ParametricBandType })}
                className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700"
              >
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <span className="ml-auto text-[11px] font-mono text-zinc-400">{Math.round(b.frequencyHz)} Hz</span>
              <button
                type="button"
                onClick={() => removeBand(b.id)}
                className="text-[11px] text-zinc-400 hover:text-red-400"
                aria-label="밴드 삭제"
              >✕</button>
            </div>

            <EqSlider label="주파수" value={b.frequencyHz} min={MIN_FREQ_HZ} max={MAX_FREQ_HZ} step={1} unit="Hz"
              onChange={(v) => updateBand(b.id, { frequencyHz: v })} disabled={!b.enabled} />
            {usesGain(b.type) && (
              <EqSlider label="게인" value={b.gainDb} min={MIN_GAIN_DB} max={MAX_GAIN_DB} step={0.1} unit="dB"
                onChange={(v) => updateBand(b.id, { gainDb: v })} disabled={!b.enabled} />
            )}
            <EqSlider label="Q" value={b.q} min={MIN_Q} max={MAX_Q} step={0.1} unit=""
              onChange={(v) => updateBand(b.id, { q: v })} disabled={!b.enabled} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EqSlider({
  label, value, min, max, step, unit, onChange, disabled,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void; disabled?: boolean;
}): React.ReactElement {
  const display = unit === '' ? value.toFixed(1) : unit === 'Hz' ? `${Math.round(value)} ${unit}` : `${value >= 0 ? '+' : ''}${value.toFixed(1)} ${unit}`;
  return (
    <div className={disabled ? 'opacity-40' : ''}>
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-zinc-400">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
