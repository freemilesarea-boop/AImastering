// Guided flow — style choice card (PROTOTYPE-PORT T2).
import React from 'react';
import { kpop, styleAccent, gradientTextStyle } from '../../theme/loui-tokens.js';

interface Props {
  name: string;
  caption: string;
  icon: React.ReactNode;
  /** mastering style key this card maps to (for accent resolution). */
  styleKey: string;
  selected: boolean;
  onClick: () => void;
}

/** Tappable style card.  KPOP Loud renders the signature gradient + badge. */
export default function StyleCard({ name, caption, icon, styleKey, selected, onClick }: Props) {
  const accent = styleAccent(styleKey);
  const isKpop = accent.isKpop;

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative text-left rounded-2xl p-4 min-h-[96px] flex flex-col justify-between
                 border transition-all"
      style={{
        background: isKpop
          ? 'radial-gradient(120% 140% at 0% 0%, rgba(255,61,119,.22), rgba(255,138,61,.08) 55%, #1A1A22 78%)'
          : '#1A1A22',
        borderColor: selected ? accent.b : (isKpop ? 'rgba(255,90,130,.5)' : '#2B2B36'),
        boxShadow: selected ? `0 0 0 3px ${accent.glow} inset` : 'none',
      }}
    >
      {isKpop && (
        <span
          className="absolute top-3 right-3 text-[10px] font-extrabold tracking-wider px-2 py-[5px] rounded-full"
          style={{ background: kpop.grad, color: '#1A0A10' }}
        >
          ⚡ SIGNATURE
        </span>
      )}
      <span
        className="w-8 h-8 rounded-[9px] flex items-center justify-center text-[16px]"
        style={{ background: isKpop ? kpop.grad : '#262633' }}
      >
        {icon}
      </span>
      <span>
        <span className="block text-[18px] font-bold" style={isKpop ? gradientTextStyle('kpop_loud') : undefined}>
          {name}
        </span>
        <span className="block text-[13px] text-zinc-400">{caption}</span>
      </span>
    </button>
  );
}
