// MultibandGrMeter — live per-band gain-reduction bars for the multiband
// compressor.  Reads the native WebAudio DynamicsCompressorNode reductions
// (works in the default preview, no worklet/rebuild needed) on a rAF loop and
// draws four downward bars with peak-hold.

import React, { useEffect, useRef, useState } from 'react';

const BAND_LABELS = ['저역', '저중', '고중', '고역'];
/** Full-scale reduction shown (dB). */
const FS_DB = 12;

export interface MultibandGrMeterProps {
  /** Returns [low, low-mid, high-mid, high] GR in dB (≤ 0), or null when off. */
  getReductions: () => [number, number, number, number] | null;
}

export default function MultibandGrMeter({ getReductions }: MultibandGrMeterProps): React.ReactElement {
  const [vals, setVals] = useState<[number, number, number, number] | null>(null);
  const peaksRef = useRef<[number, number, number, number]>([0, 0, 0, 0]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let last = 0;
    const tick = (t: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (t - last < 33) return; // ~30 fps
      last = t;
      const r = getReductions();
      if (!r) { setVals(null); peaksRef.current = [0, 0, 0, 0]; return; }
      // GR magnitude (positive dB).
      const mags = r.map((x) => Math.max(0, -x)) as [number, number, number, number];
      const peaks = peaksRef.current;
      for (let i = 0; i < 4; i++) peaks[i] = Math.max(mags[i]!, peaks[i]! * 0.92);
      setVals(mags);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [getReductions]);

  return (
    <div className="space-y-1">
      <div className="flex items-end justify-between gap-2 h-20">
        {BAND_LABELS.map((label, i) => {
          const mag = vals ? vals[i]! : 0;
          const peak = peaksRef.current[i]!;
          const pct = Math.min(100, (mag / FS_DB) * 100);
          const peakPct = Math.min(100, (peak / FS_DB) * 100);
          return (
            <div key={label} className="flex-1 flex flex-col items-center gap-1">
              <div className="relative w-full h-16 bg-zinc-800 rounded-sm border border-zinc-800 overflow-hidden">
                {/* GR bar grows downward from the top. */}
                <div
                  className="absolute top-0 left-0 right-0 bg-gradient-to-b from-amber-400 to-amber-600"
                  style={{ height: `${pct}%` }}
                />
                {/* Peak-hold line. */}
                {peakPct > 1 && (
                  <div className="absolute left-0 right-0 h-px bg-amber-200" style={{ top: `${peakPct}%` }} />
                )}
              </div>
              <span className="text-[11px] text-zinc-300">{label}</span>
              <span className="text-[11px] font-mono text-zinc-400">{vals ? `-${mag.toFixed(1)}` : '—'}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-400 text-center">밴드별 게인 리덕션 (dB) · 미리듣기 재생 중</p>
    </div>
  );
}
