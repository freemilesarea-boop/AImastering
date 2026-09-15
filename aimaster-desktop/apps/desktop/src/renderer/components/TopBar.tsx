import React from 'react';
// License badge / store / modal removed for the internal RC test cycle.
// See main/index.ts header for the rationale.  TopBar layout remains the
// same — SupportBundleButton stays as the only right-aligned chip.
import SupportBundleButton from './SupportBundleButton.js';
import { detectPlatform } from '../shortcuts/keys.js';
import { useAppStore } from '../stores/appStore.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { APP_NAME } from '@aimaster/shared-types';

// ── TopBar ────────────────────────────────────────────────────────────────────

interface TopBarProps {
  subtitle?: string;
  /** Extra controls rendered in the right area (buttons etc.). */
  actions?: React.ReactNode;
}

/**
 * Nav chip into the multitrack workspace.
 *
 * It used to be a `fixed top-2.5 right-24 z-40` button floating over this bar
 * from `App`, and a fixed overlay above a flex row collides at some width.  It
 * did: at 1100 px it covered x 950–992 of the 스튜디오 chip at 926–992 — two
 * thirds of it, centre included — so clicking the middle of 스튜디오 opened the
 * DAW instead.  Two destinations, and the wrong one won most of the target.
 *
 * In the row it cannot overlap anything, at any width.
 */
function DawLink() {
  const page = useAppStore((s) => s.currentPage);
  const setPage = useAppStore((s) => s.setPage);
  const isMobile = useIsMobile();
  if (isMobile || page === 'daw') return null;
  return (
    <button
      type="button"
      onClick={() => setPage('daw')}
      title="멀티트랙 Edit / Mix 워크스페이스 (Mod+Alt+D)"
      className="no-drag shrink-0 text-[11px] font-medium rounded-md px-2.5 py-1 transition-colors"
      style={{
        color: 'rgba(255,255,255,0.55)',
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'transparent',
      }}
    >DAW</button>
  );
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
  // macOS runs `titleBarStyle: 'hiddenInset'`, which puts the traffic lights
  // INSIDE the window at the top-left.  Without room reserved for them they
  // sit on top of the wordmark — which is exactly what it looks like: broken.
  const isMac = detectPlatform() === 'mac';
  return (
    <div className="drag-region h-10 shrink-0 flex items-center pr-4 gap-3
                    border-b border-zinc-800/60"
         style={{ paddingLeft: isMac ? 82 : 16 }}>
      {/* App wordmark — left side of drag region */}
      <span className="font-semibold text-[12px] tracking-wide text-zinc-300 select-none">
        {APP_NAME}
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
      <DawLink />

      {/* Action area — must be no-drag so buttons are clickable */}
      {actions && <div className="no-drag">{actions}</div>}

      <SupportBundleButton />
    </div>
  );
}
