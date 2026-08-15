import React from 'react';
// License badge / store / modal removed for the internal RC test cycle.
// See main/index.ts header for the rationale.  TopBar layout remains the
// same — SupportBundleButton stays as the only right-aligned chip.
import SupportBundleButton from './SupportBundleButton.js';
import { useAppStore } from '../stores/appStore.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

// ── TopBar ────────────────────────────────────────────────────────────────────

interface TopBarProps {
  subtitle?: string;
  /** Extra controls rendered in the right area (buttons etc.). */
  actions?: React.ReactNode;
}

/** Nav chip to the Studio rack.  Hidden on mobile, which never routes there. */
function StudioLink() {
  const page = useAppStore((s) => s.currentPage);
  const setPage = useAppStore((s) => s.setPage);
  const isMobile = useIsMobile();
  if (isMobile) return null;

  const onStudio = page === 'studio';
  return (
    <button
      type="button"
      onClick={() => setPage(onStudio ? 'home' : 'studio')}
      className="no-drag shrink-0 text-[11px] font-medium rounded-md px-2.5 py-1 transition-colors"
      style={{
        color: onStudio ? '#a78bfa' : 'rgba(255,255,255,0.55)',
        border: `1px solid ${onStudio ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.10)'}`,
        background: onStudio ? 'rgba(167,139,250,0.16)' : 'transparent',
      }}
      title="모듈 랙 — De-noise · De-hum · Dynamic EQ · Multiband · Exciter · Tape · Dither 등 20개 모듈"
    >
      {onStudio ? '스튜디오 ✓' : '스튜디오'}
    </button>
  );
}

export default function TopBar({ subtitle, actions }: TopBarProps) {
  return (
    <div className="drag-region h-10 shrink-0 flex items-center px-4 gap-3
                    border-b border-zinc-800/60">
      {/* App wordmark — left side of drag region */}
      <span className="font-semibold text-[12px] tracking-wide text-zinc-300 select-none">
        Louver Mastering AI
      </span>

      {subtitle && (
        <>
          <span className="text-zinc-700 select-none">/</span>
          <span className="text-xs text-zinc-500 select-none">{subtitle}</span>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Studio — the module rack.  A top-level entry because it is a chain
          editor that works with or without a loaded file; burying it behind
          a per-file button made the twenty modules effectively invisible. */}
      <StudioLink />

      {/* Action area — must be no-drag so buttons are clickable */}
      {actions && <div className="no-drag">{actions}</div>}

      <SupportBundleButton />
    </div>
  );
}
