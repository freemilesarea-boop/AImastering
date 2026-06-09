// MultibandPanel — 4-band multiband compressor control (Phase 2).
//
// Drives `audioStore.multiband`, which is sent to the Rust offline render
// (export).  The real 4-band DSP lives in dsp-core (loui-dsp); this panel is
// the user-facing control for it.
//
// Note: the always-on WebAudio preview is a single-band approximation and
// does NOT reflect the multiband settings — those apply to the Rust export
// (and the opt-in realtime worklet once enabled).  The panel says so.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { BAND_LABELS, MB_RANGES } from '../audio/multiband-config.js';

export default function MultibandPanel(): React.ReactElement {
  const mb = useAudioStore((s) => s.multiband);
  const updateMultiband = useAudioStore((s) => s.updateMultiband);
  const updateBand = useAudioStore((s) => s.updateMultibandBand);
  const reset = useAudioStore((s) => s.resetMultiband);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="checkbox"
            checked={!mb.bypass}
            onChange={(e) => updateMultiband({ bypass: !e.target.checked })}
            aria-label="멀티밴드 사용"
          />
          멀티밴드 컴프레서 사용
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <p className="text-[10px] text-zinc-600">
        Export(Rust 렌더)에 적용됩니다. 미리듣기(WebAudio 근사)에는 반영되지 않을 수 있습니다.
      </p>

      <div className={mb.bypass ? 'opacity-40 pointer-events-none space-y-2' : 'space-y-2'}>
        {/* Crossovers */}
        <div className="grid grid-cols-3 gap-2">
          <XoverInput label="저/저중 (Hz)" value={mb.xoverLoHz} min={MB_RANGES.xoverLoHz.min} max={MB_RANGES.xoverLoHz.max}
            onChange={(v) => updateMultiband({ xoverLoHz: v })} />
          <XoverInput label="저중/고중 (Hz)" value={mb.xoverMidHz} min={MB_RANGES.xoverMidHz.min} max={MB_RANGES.xoverMidHz.max}
            onChange={(v) => updateMultiband({ xoverMidHz: v })} />
          <XoverInput label="고중/고 (Hz)" value={mb.xoverHiHz} min={MB_RANGES.xoverHiHz.min} max={MB_RANGES.xoverHiHz.max}
            onChange={(v) => updateMultiband({ xoverHiHz: v })} />
        </div>

        {/* Per-band controls */}
        {mb.bands.map((b, i) => (
          <div key={i} className="rounded border border-zinc-800 p-2 space-y-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{BAND_LABELS[i]}</p>
            <BandSlider label="Threshold" value={b.thresholdDb} min={MB_RANGES.thresholdDb.min} max={MB_RANGES.thresholdDb.max} step={0.5} unit="dB"
              onChange={(v) => updateBand(i, { thresholdDb: v })} />
            <BandSlider label="Ratio" value={b.ratio} min={MB_RANGES.ratio.min} max={MB_RANGES.ratio.max} step={0.1} unit=":1"
              onChange={(v) => updateBand(i, { ratio: v })} />
            <BandSlider label="Makeup" value={b.makeupDb} min={MB_RANGES.makeupDb.min} max={MB_RANGES.makeupDb.max} step={0.1} unit="dB"
              onChange={(v) => updateBand(i, { makeupDb: v })} />
          </div>
        ))}
      </div>
    </div>
  );
}

// (helpers below)

function XoverInput({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[9px] text-zinc-600 block">{label}</span>
      <input
        type="number" min={min} max={max} value={Math.round(value)}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full bg-zinc-900 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700"
      />
    </label>
  );
}

function BandSlider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}): React.ReactElement {
  const display = unit === ':1' ? `${value.toFixed(1)}${unit}` : `${value >= 0 && unit === 'dB' ? '+' : ''}${value.toFixed(1)} ${unit}`;
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] text-zinc-600">{label}</span>
        <span className="text-[10px] font-mono text-zinc-400">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}
