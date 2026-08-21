// Guided flow — platform target card (PROTOTYPE-PORT T2).
import React from 'react';
import { accent } from '../../theme/loui-tokens.js';

interface Props {
  name: string;
  /** Short label inside the icon chip, e.g. "S", "▶". */
  icon: React.ReactNode;
  /** Target LUFS shown as a small mono caption, e.g. "−14". */
  lufsLabel: string;
  selected: boolean;
  onClick: () => void;
}

/** Compact platform target chip with its LUFS caption. */
export default function TargetCard({ name, icon, lufsLabel, selected, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-[6px] py-[13px] px-[6px] rounded-[13px] border transition-all"
      style={{
        background: selected ? '#20202A' : '#1A1A22',
        borderColor: selected ? accent.b : '#2B2B36',
      }}
    >
      <span className="w-7 h-7 rounded-lg bg-[#2a2a36] flex items-center justify-center text-[14px]">{icon}</span>
      <span className="text-[13px] font-semibold text-zinc-100">{name}</span>
      <span className="text-[11px] text-zinc-500 font-mono">{lufsLabel}</span>
    </button>
  );
}
