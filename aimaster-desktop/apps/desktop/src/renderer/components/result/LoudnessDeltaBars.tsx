// Result — loudness change bars (PROTOTYPE-PORT T7).
//
// Original vs Master integrated-LUFS bars with the target line.  Values are
// REAL (from masteringResult.loudnessBefore/After).  Animates in on mount.
import React, { useEffect, useState } from 'react';
import { styleAccent, targetLine } from '../../theme/loui-tokens.js';

interface Props {
  origLufs: number;
  mastLufs: number;
  targetLufs: number;
  styleKey: string;
}

/** Map integrated LUFS (−24..−6) → bar width % (2..98). */
function lufsPct(l: number): number {
  if (!Number.isFinite(l)) return 2;
  return Math.max(2, Math.min(98, ((l + 24) / 18) * 100));
}

export default function LoudnessDeltaBars({ origLufs, mastLufs, targetLufs, styleKey }: Props) {
  const accent = styleAccent(styleKey);
  const [grown, setGrown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrown(true), 120); return () => clearTimeout(t); }, []);

  const tPct = lufsPct(targetLufs);

  const Row = ({ lab, lufs, fill }: { lab: string; lufs: number; fill: string }) => (
    <div className="flex items-center gap-3 my-[9px]">
      <span className="w-[54px] text-[14px] text-zinc-400">{lab}</span>
      <div className="flex-1 h-[14px] rounded-lg bg-[#16161E] border border-zinc-700 relative overflow-hidden">
        <div className="absolute left-0 top-0 bottom-0 rounded-lg transition-[width] duration-1000 ease-out"
             style={{ width: grown ? `${lufsPct(lufs)}%` : '0%', background: fill }} />
        <div className="absolute top-[-4px] bottom-[-4px] w-[2px]" style={{ left: `${tPct}%`, background: targetLine }} />
      </div>
      <span className="w-[78px] text-right font-mono text-[14px]">
        {Number.isFinite(lufs) ? lufs.toFixed(1) : '—'}
      </span>
    </div>
  );

  return (
    <div className="rounded-2xl bg-[#1A1A22] border border-zinc-700 p-4">
      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase mb-2">Loudness</div>
      <Row lab="원본" lufs={origLufs} fill="#4a4a58" />
      <Row lab="마스터" lufs={mastLufs} fill={accent.grad} />
      <div className="text-[13px] text-zinc-500 mt-[2px]">점선 = 목표 · True Peak 안전</div>
    </div>
  );
}
