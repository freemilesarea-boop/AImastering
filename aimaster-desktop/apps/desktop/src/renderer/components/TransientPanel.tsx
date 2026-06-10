// TransientPanel — transient/impact shaper control (Phase 2).
//
// Drives `audioStore.transient`, applied on the Rust offline render (export)
// + the opt-in realtime worklet.  There is no WebAudio-node approximation for
// a transient designer, so the always-on preview does NOT reflect it — the
// panel says so.  Attack > 0 = punchier, Sustain > 0 = more body.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { TR_RANGES, TR_BAND_LABELS } from '../audio/transient-config.js';

export default function TransientPanel(): React.ReactElement {
  const tr = useAudioStore((s) => s.transient);
  const update = useAudioStore((s) => s.updateTransient);
  const updateBand = useAudioStore((s) => s.updateTransientBand);
  const reset = useAudioStore((s) => s.resetTransient);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input
            type="checkbox"
            checked={!tr.bypass}
            onChange={(e) => update({ bypass: !e.target.checked })}
            aria-label="트랜지언트 사용"
          />
          트랜지언트 / 임팩트 사용
        </label>
        <button type="button" onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300">초기화</button>
      </div>

      <p className="text-[10px] text-zinc-600">Export + 실시간 worklet에 적용. 기본 미리듣기에는 반영되지 않습니다.</p>

      <div className={tr.bypass ? 'opacity-40 pointer-events-none space-y-2' : 'space-y-2'}>
        {!tr.multibandEnabled && (
          <>
            <Slider label="Attack" value={tr.attackPct} onChange={(v) => update({ attackPct: v })} />
            <Slider label="Sustain" value={tr.sustainPct} onChange={(v) => update({ sustainPct: v })} />
          </>
        )}

        <label className="flex items-center gap-2 text-[10px] text-zinc-400 pt-1">
          <input type="checkbox" checked={tr.multibandEnabled} onChange={(e) => update({ multibandEnabled: e.target.checked })} aria-label="멀티밴드 트랜지언트" />
          멀티밴드
        </label>

        {tr.multibandEnabled && tr.bands.map((b, i) => (
          <div key={i} className="rounded border border-zinc-800 p-2 space-y-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{TR_BAND_LABELS[i]}</p>
            <Slider label="Attack" value={b.attackPct} onChange={(v) => updateBand(i, { attackPct: v })} />
            <Slider label="Sustain" value={b.sustainPct} onChange={(v) => updateBand(i, { sustainPct: v })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }): React.ReactElement {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] text-zinc-600">{label}</span>
        <span className="text-[10px] font-mono text-zinc-400">{value > 0 ? '+' : ''}{Math.round(value)}%</span>
      </div>
      <input type="range" min={TR_RANGES.amountPct.min} max={TR_RANGES.amountPct.max} step={1} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}
