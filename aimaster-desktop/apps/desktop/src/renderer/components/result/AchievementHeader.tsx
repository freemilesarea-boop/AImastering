// Result — achievement header (PROTOTYPE-PORT T7).
//
// Shows the trophy metric: loudness gain (+X.X LU) with a count-up, plus a
// style badge (KPOP Loud = signature).  Pure presentational; the gain value
// comes from real loudness metrics passed by ResultPage.
import React, { useEffect, useRef, useState } from 'react';
import { kpop, styleAccent, gradientTextStyle } from '../../theme/loui-tokens.js';

interface Props {
  /** loudnessAfter − loudnessBefore (LU). */
  gainLu: number;
  styleKey: string;
  title: string;
  sub: string;
}

export default function AchievementHeader({ gainLu, styleKey, title, sub }: Props) {
  const accent = styleAccent(styleKey);
  const isKpop = accent.isKpop;
  const [shown, setShown] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const target = Number.isFinite(gainLu) ? gainLu : 0;
    const dur = 900;
    let start: number | null = null;
    const frame = (ts: number) => {
      if (start == null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(target * e);
      if (p < 1) raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
  }, [gainLu]);

  const sign = shown >= 0 ? '+' : '−';
  const num = Math.abs(shown).toFixed(1);

  return (
    <div className="text-center">
      <span
        className="inline-flex items-center gap-2 px-[14px] py-2 rounded-full text-[13px] font-extrabold tracking-wide"
        style={isKpop
          ? { background: kpop.grad, color: '#1A0A10' }
          : { background: '#20202A', color: '#9A9AA8' }}
      >
        {isKpop ? 'KPOP LOUD ✓' : `${title} ✓`}
      </span>

      <div className="font-mono font-extrabold leading-none mt-4" style={{ ...gradientTextStyle(styleKey), fontSize: 58 }}>
        {sign}{num}<span style={{ fontSize: 24, fontWeight: 700 }}>&nbsp;LU</span>
      </div>

      <div className="text-[19px] font-extrabold mt-[10px]">{title}</div>
      <div className="text-[14px] text-zinc-400 mt-1">{sub}</div>
    </div>
  );
}
