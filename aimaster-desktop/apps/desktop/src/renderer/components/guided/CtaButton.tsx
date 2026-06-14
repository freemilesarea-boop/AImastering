// Guided flow — primary CTA button (PROTOTYPE-PORT T2).
import React from 'react';
import type { MasteringStyle } from '@aimaster/shared-types';
import { ctaStyle } from '../../theme/loui-tokens.js';

interface Props {
  children: React.ReactNode;
  /** Style whose accent the button uses (KPOP Loud = signature). */
  accentStyle?: MasteringStyle | string | null;
  disabled?: boolean;
  onClick?: () => void;
}

/** Large, full-width accent CTA (HIG-sized: ≥44pt tall, 18px label). */
export default function CtaButton({ children, accentStyle, disabled, onClick }: Props) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full py-[18px] rounded-2xl text-[18px] font-bold text-center transition-all
                 disabled:grayscale disabled:opacity-40 disabled:cursor-not-allowed"
      style={disabled ? { background: '#2B2B36', color: '#6A6A78' } : ctaStyle(accentStyle)}
    >
      {children}
    </button>
  );
}
