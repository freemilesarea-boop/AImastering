// StemRebalancePanel — Master-Rebalance-style stem control (Phase 3).
//
// Two tiers:
//   • 근사 (approximation) — M/S vocal/bass/side, heard LIVE in the preview now.
//   • 정밀 (Demucs/ONNX)   — true 4-stem separation, applied on export.  Gated
//     on the model being installed; shown disabled until then.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { REBAL_RANGES, STEMS, STEM_LABEL } from '../audio/rebalance-config.js';

export default function StemRebalancePanel(): React.ReactElement {
  const r = useAudioStore((s) => s.rebalance);
  const update = useAudioStore((s) => s.updateRebalance);
  const updateStem = useAudioStore((s) => s.updateStemGain);
  const reset = useAudioStore((s) => s.resetRebalance);

  // The precise tier auto-enables when a real model is pinned AND the ONNX
  // runtime loads (main: stem:precise-available) — no code edit / rebuild.
  const [preciseAvailable, setPreciseAvailable] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void window.electronAPI?.invoke('stem:precise-available')
      .then((res) => { if (alive) setPreciseAvailable(!!(res as { available?: boolean } | undefined)?.available); })
      .catch(() => { /* unavailable → stays gated */ });
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-300">스템 리밸런스</p>
        <button type="button" onClick={reset} className="text-[11px] text-zinc-300 hover:text-zinc-300">초기화</button>
      </div>

      {/* ── Approximation tier (live) ──────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-[11px] text-zinc-400 uppercase tracking-wider">근사 (실시간 · 미리듣기 적용)</p>
        <Slider label="보컬 (센터)" value={r.vocalDb} min={REBAL_RANGES.vocalDb.min} max={REBAL_RANGES.vocalDb.max} unit="dB" onChange={(v) => update({ vocalDb: v })} />
        <Slider label="베이스" value={r.bassDb} min={REBAL_RANGES.bassDb.min} max={REBAL_RANGES.bassDb.max} unit="dB" onChange={(v) => update({ bassDb: v })} />
        <Slider label="공간 (사이드)" value={r.sidePct} min={REBAL_RANGES.sidePct.min} max={REBAL_RANGES.sidePct.max} unit="%" onChange={(v) => update({ sidePct: v })} />
        <p className="text-[11px] text-zinc-400">M/S 기반 근사 — 센터 보컬·베이스·폭을 즉시 조정합니다.</p>
      </div>

      {/* ── Precise tier (Demucs/ONNX) ─────────────────────────────────── */}
      <div className={`space-y-2 ${preciseAvailable ? '' : 'opacity-50'}`}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-zinc-400 uppercase tracking-wider">정밀 (Demucs · Export)</p>
          {!preciseAvailable && <span className="text-[11px] px-1 rounded bg-zinc-700 text-zinc-300">모델 필요 (추후)</span>}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input type="checkbox" disabled={!preciseAvailable} checked={r.preciseEnabled} onChange={(e) => update({ preciseEnabled: e.target.checked })} aria-label="정밀 분리 사용" />
          정밀 4-스템 분리 사용 (Export)
        </label>
        <div className={r.preciseEnabled ? 'space-y-1.5' : 'opacity-50 pointer-events-none space-y-1.5'}>
          {STEMS.map((s) => (
            <Slider key={s} label={STEM_LABEL[s]} value={r.stemGainsDb[s]} min={REBAL_RANGES.stemDb.min} max={REBAL_RANGES.stemDb.max} unit="dB"
              onChange={(v) => updateStem(s, v)} disabled={!preciseAvailable} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, unit, onChange, disabled }: {
  label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void; disabled?: boolean;
}): React.ReactElement {
  const disp = unit === '%' ? `${Math.round(value)}%` : `${value > 0 ? '+' : ''}${value.toFixed(1)} ${unit}`;
  return (
    <div className={disabled ? 'opacity-40' : ''}>
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-zinc-400">{disp}</span>
      </div>
      <input type="range" min={min} max={max} step={unit === '%' ? 1 : 0.5} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}
