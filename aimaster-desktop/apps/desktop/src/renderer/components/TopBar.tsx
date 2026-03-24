import React from 'react';
import { useLicenseStore, selectRemainingTrials } from '../stores/licenseStore.js';

// ── License badge ─────────────────────────────────────────────────────────────

function LicenseBadge() {
  const info           = useLicenseStore((s) => s.licenseInfo);
  const setShowModal   = useLicenseStore((s) => s.setShowModal);
  const remaining      = useLicenseStore(selectRemainingTrials);
  const isPro          = info?.tier === 'pro';

  return (
    <button
      onClick={() => setShowModal(true)}
      className={`no-drag flex items-center gap-1.5 px-2.5 py-1 rounded-md
                  text-xs font-medium transition-colors
                  ${isPro
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/15'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300 hover:border-zinc-600'
                  }`}
    >
      {isPro ? (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
          Licensed
        </>
      ) : (
        <>
          Free
          {remaining !== Infinity && (
            <span className="text-zinc-600">· {remaining}회 남음</span>
          )}
        </>
      )}
    </button>
  );
}

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
      <span className="font-mono text-[11px] tracking-[0.18em] text-zinc-600 select-none uppercase">
        AIMASTER
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

      <LicenseBadge />
    </div>
  );
}
