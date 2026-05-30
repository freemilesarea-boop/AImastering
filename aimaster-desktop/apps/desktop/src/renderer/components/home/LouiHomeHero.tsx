// LouiHomeHero — premium lavender hero for the setup (Home) screen.
//
// Pure presentational: brand mark + title + tagline + engine status badge,
// over a subtle lavender glow.  No store / IPC coupling so it is fully
// Storybook-able.

import React from 'react';
import { loui, louiAlpha } from '../../theme/loui-home.js';

export interface LouiHomeHeroProps {
  /** Engine readiness — drives the status badge colour + label. */
  engineReady?: boolean;
  /** Override the engine label (default: "로컬 엔진 · 준비됨"). */
  engineLabel?: string;
}

function BrandMark() {
  return (
    <div
      style={{
        width: 42, height: 42, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(140deg, ${loui.activeViolet}, ${loui.primaryLavender})`,
        boxShadow: `0 0 18px -2px ${loui.glowLavender}`,
      }}
      aria-hidden
    >
      {/* Soundwave glyph */}
      <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#0E0E14" strokeWidth={2} strokeLinecap="round">
        <path d="M3 12h2M19 12h2M7 8v8M17 8v8M12 4v16" />
      </svg>
    </div>
  );
}

export function LouiHomeHero({ engineReady = true, engineLabel }: LouiHomeHeroProps) {
  const dot = engineReady ? loui.successMint : loui.warningAmber;
  const label = engineLabel ?? (engineReady ? '로컬 엔진 · 준비됨' : '엔진 점검 중');
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '18px 20px',
        borderRadius: 18,
        border: `1px solid ${loui.borderSubtle}`,
        background: `radial-gradient(120% 140% at 0% 0%, ${louiAlpha.lav(0.12)} 0%, ${loui.panelElevated} 55%)`,
        overflow: 'hidden',
      }}
    >
      {/* Ambient glow */}
      <div aria-hidden style={{
        position: 'absolute', top: -40, left: -20, width: 180, height: 180,
        background: loui.glowLavender, filter: 'blur(48px)', opacity: 0.5, pointerEvents: 'none',
      }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, position: 'relative', minWidth: 0 }}>
        <BrandMark />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.1,
            background: `linear-gradient(90deg, #FFFFFF, ${loui.softLavender})`,
            WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
          }}>
            Loui Mastering
          </div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 3, lineHeight: 1.3 }}>
            AI 음악을 스트리밍 기준으로 마스터링
          </div>
        </div>
      </div>

      <div style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '6px 11px', borderRadius: 999, flexShrink: 0,
        border: `1px solid ${loui.borderSubtle}`, background: 'rgba(0,0,0,0.25)',
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, boxShadow: `0 0 8px ${dot}` }} />
        <span style={{ fontSize: 11, color: '#D1D5DB', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
    </div>
  );
}
