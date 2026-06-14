// Result — before/after waveform (PROTOTYPE-PORT T7).
//
// Stylized before (sparse) vs after (full) waveform that animates in, making
// "louder" visible at a glance.  Matches the approved mockup.  Deterministic
// generation so it renders without external assets; the trust signal is the
// real LUFS numbers (LoudnessDeltaBars) — this is illustrative fullness.
import React, { useEffect, useState } from 'react';
import { styleAccent } from '../../theme/loui-tokens.js';

interface Props {
  styleKey: string;
  /** bar count */
  bars?: number;
}

function heights(n: number, kind: 'before' | 'after'): number[] {
  let seed = kind === 'before' ? 7 : 13;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const rnd = seed / 233280;
    const t = i / n;
    const env = Math.sin(t * Math.PI);
    const h = kind === 'before'
      ? (0.16 + 0.55 * env * rnd) * 100
      : (0.45 + 0.5 * (0.6 + 0.4 * env) * (0.6 + 0.4 * rnd)) * 100;
    out.push(Math.max(6, Math.min(100, h)));
  }
  return out;
}

function Wave({ data, fill, grown }: { data: number[]; fill: string; grown: boolean }) {
  return (
    <div className="flex items-center gap-[2px] h-[50px]">
      {data.map((h, i) => (
        <div key={i} className="flex-1 rounded-[2px] transition-[height] duration-500 ease-out"
             style={{ height: grown ? `${h}%` : '6%', background: fill, transitionDelay: `${i * 4}ms` }} />
      ))}
    </div>
  );
}

export default function BeforeAfterWaveform({ styleKey, bars = 64 }: Props) {
  const accent = styleAccent(styleKey);
  const [grown, setGrown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrown(true), 160); return () => clearTimeout(t); }, []);

  const before = heights(bars, 'before');
  const after = heights(bars, 'after');

  return (
    <div className="rounded-2xl bg-[#1A1A22] border border-zinc-700 p-4">
      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase">Waveform</div>
      <div className="text-[12px] text-zinc-600 my-[6px]">원본</div>
      <Wave data={before} fill="#4a4a58" grown={grown} />
      <div className="text-[12px] text-zinc-600 mt-[10px] mb-[6px] flex justify-between">
        <span>마스터</span><span className="font-mono">True Peak ✓</span>
      </div>
      <div className="relative">
        <div className="absolute left-0 right-0 top-1 border-t border-dashed border-white/20" />
        <Wave data={after} fill={accent.grad} grown={grown} />
      </div>
    </div>
  );
}
