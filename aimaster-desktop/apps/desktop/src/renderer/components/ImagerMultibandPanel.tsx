// ImagerMultibandPanel — 4-band M/S stereo width control (Phase 2).
//
// Drives `audioStore.imagerMultiband`, applied on the Rust offline render
// (export) + the preview (native WebAudio approximation + opt-in worklet).
// Per-band Side width: 0 % = mono, 100 % = unchanged, 200 % = extra wide —
// e.g. keep lows mono and widen highs.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { IMG_BAND_LABELS, IMG_RANGES } from '../audio/imager-config.js';

export default function ImagerMultibandPanel(): React.ReactElement {
  const im = useAudioStore((s) => s.imagerMultiband);
  const update = useAudioStore((s) => s.updateImagerMultiband);
  const updateWidth = useAudioStore((s) => s.updateImagerBandWidth);
  const reset = useAudioStore((s) => s.resetImagerMultiband);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="checkbox"
            checked={im.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            aria-label="멀티밴드 이미저 사용"
          />
          4밴드 스테레오 폭 사용
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <p className="text-[10px] text-zinc-600">
        밴드별 Side 폭(0% 모노 · 100% 그대로 · 200% 확장). Export에 적용, 미리듣기는 근사.
      </p>

      <div className={im.enabled ? 'space-y-2' : 'opacity-40 pointer-events-none space-y-2'}>
        <div className="grid grid-cols-3 gap-2">
          <XoverInput label="저/저중 (Hz)" value={im.xoverLoHz} min={IMG_RANGES.xoverLoHz.min} max={IMG_RANGES.xoverLoHz.max}
            onChange={(v) => update({ xoverLoHz: v })} />
          <XoverInput label="저중/고중 (Hz)" value={im.xoverMidHz} min={IMG_RANGES.xoverMidHz.min} max={IMG_RANGES.xoverMidHz.max}
            onChange={(v) => update({ xoverMidHz: v })} />
          <XoverInput label="고중/고 (Hz)" value={im.xoverHiHz} min={IMG_RANGES.xoverHiHz.min} max={IMG_RANGES.xoverHiHz.max}
            onChange={(v) => update({ xoverHiHz: v })} />
        </div>
        {im.widthsPct.map((w, i) => (
          <div key={i}>
            <div className="flex justify-between items-baseline">
              <span className="text-[10px] text-zinc-600">{IMG_BAND_LABELS[i]} 폭</span>
              <span className="text-[10px] font-mono text-zinc-400">{Math.round(w)}%</span>
            </div>
            <input type="range" min={IMG_RANGES.widthPct.min} max={IMG_RANGES.widthPct.max} step={1} value={w}
              onChange={(e) => updateWidth(i, parseFloat(e.target.value))} className="w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function XoverInput({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[9px] text-zinc-600 block">{label}</span>
      <input type="number" min={min} max={max} value={Math.round(value)}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full bg-zinc-900 text-zinc-300 text-[11px] rounded px-1 py-0.5 border border-zinc-700" />
    </label>
  );
}
