// SaturationPanel — saturation/exciter control (Phase 2).
//
// Drives `audioStore.saturation`, applied on the Rust offline render (export)
// + the preview (native WebAudio WaveShaper approximation + opt-in worklet).
// Characters: Warm / Tape / Tube / Modern.  Optional 4-band per-band drive.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import {
  CHARACTERS, CHARACTER_LABEL, SAT_RANGES, SAT_BAND_LABELS, type SaturationCharacter,
} from '../audio/saturation-config.js';

export default function SaturationPanel(): React.ReactElement {
  const sat = useAudioStore((s) => s.saturation);
  const update = useAudioStore((s) => s.updateSaturation);
  const updateBand = useAudioStore((s) => s.updateSaturationBandDrive);
  const reset = useAudioStore((s) => s.resetSaturation);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="checkbox"
            checked={!sat.bypass}
            onChange={(e) => update({ bypass: !e.target.checked })}
            aria-label="새추레이션 사용"
          />
          새추레이션 / 엑사이터 사용
        </label>
        <button type="button" onClick={reset} className="text-[11px] text-zinc-300 hover:text-zinc-300">초기화</button>
      </div>

      <p className="text-[11px] text-zinc-400">Export에 적용, 미리듣기는 WaveShaper 근사.</p>

      <div className={sat.bypass ? 'opacity-40 pointer-events-none space-y-2' : 'space-y-2'}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400">캐릭터</span>
          <select
            value={sat.character}
            onChange={(e) => update({ character: e.target.value as SaturationCharacter })}
            className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700"
          >
            {CHARACTERS.map((c) => <option key={c} value={c}>{CHARACTER_LABEL[c]}</option>)}
          </select>
        </div>

        <Slider label="Drive" value={sat.drive} min={SAT_RANGES.drive.min} max={SAT_RANGES.drive.max} step={1} unit="%"
          onChange={(v) => update({ drive: v })} />
        <Slider label="Mix" value={sat.mixPct} min={SAT_RANGES.mixPct.min} max={SAT_RANGES.mixPct.max} step={1} unit="%"
          onChange={(v) => update({ mixPct: v })} />

        <label className="flex items-center gap-2 text-[11px] text-zinc-400 pt-1">
          <input type="checkbox" checked={sat.multibandEnabled} onChange={(e) => update({ multibandEnabled: e.target.checked })} aria-label="멀티밴드 드라이브" />
          멀티밴드 드라이브
        </label>
        {sat.multibandEnabled && (
          <div className="space-y-1.5">
            {sat.bandDrivesPct.map((d, i) => (
              <Slider key={i} label={`${SAT_BAND_LABELS[i]} 드라이브`} value={d} min={SAT_RANGES.bandDrivePct.min} max={SAT_RANGES.bandDrivePct.max} step={1} unit="%"
                onChange={(v) => updateBand(i, v)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-zinc-400">{Math.round(value)}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}
