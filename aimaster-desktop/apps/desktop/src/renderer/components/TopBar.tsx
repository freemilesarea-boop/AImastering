import React from 'react';
// License badge / store / modal removed for the internal RC test cycle.
// See main/index.ts header for the rationale.  TopBar layout remains the
// same — SupportBundleButton stays as the only right-aligned chip.
import SupportBundleButton from './SupportBundleButton.js';

// ── TopBar ────────────────────────────────────────────────────────────────────

interface TopBarProps {
  subtitle?: string;
  /** Extra controls rendered in the right area (buttons etc.). */
  actions?: React.ReactNode;
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

      {/* Action area — must be no-drag so buttons are clickable */}
      {actions && <div className="no-drag">{actions}</div>}

      <SupportBundleButton />
    </div>
  );
}
