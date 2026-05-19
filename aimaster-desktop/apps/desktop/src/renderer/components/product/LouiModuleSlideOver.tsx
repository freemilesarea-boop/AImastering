// LouiModuleSlideOver — right-anchored parameter panel overlay.
//
// Behaviour:
//   • Slides in from the right (480 px wide, 280 ms ease-out)
//   • Renders behind a translucent backdrop
//   • Closes via:
//       - ESC key
//       - Backdrop click
//       - Internal close button (✕)
//       - Re-selecting the same module card in the Module Strip
//         (handled by the caller — slide-over only owns its own close)
//   • Focus management:
//       - On open: auto-focus the panel's first interactive element
//       - On close: restore focus to the element that opened the panel
//   • Focus trap: Tab / Shift+Tab cycles inside the panel only
//
// The slide-over does NOT own module-specific content — the caller mounts
// `EqParameterPanel` / `LimiterParameterPanel` / etc. as children.

import React, { useEffect, useRef } from 'react';
import { surface, text, typography, space, radius } from '../../theme/loui-theme.js';

export interface LouiModuleSlideOverProps {
  /** Display title — "EQ", "Dynamics", etc. */
  title: string;
  /** Optional editorial subtitle. */
  subtitle?: string;
  /** When true, the slide-over is mounted + visible. */
  open: boolean;
  /** Caller fires this when ESC / backdrop / close button is invoked. */
  onClose: () => void;
  /** Width in px.  Default 480. */
  width?: number;
  /**
   * Optional header content slotted to the left of the close button —
   * used by ProductPage for the "(modified)" badge / Reset / Bypass
   * actions surfaced from the central parameter state.
   */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}

/** Find every focusable element inside `root`. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), ' +
    '[tabindex]:not([tabindex="-1"]):not([disabled]), [role="slider"]:not([disabled])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function LouiModuleSlideOver(props: LouiModuleSlideOverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Track the element that had focus when the slide-over opened.
  useEffect(() => {
    if (props.open) {
      lastFocusRef.current = (document.activeElement as HTMLElement) ?? null;
      // Auto-focus the first focusable child on the next tick (after mount).
      const t = setTimeout(() => {
        if (!panelRef.current) return;
        const items = focusableWithin(panelRef.current);
        (items[1] ?? items[0])?.focus();
      }, 50);
      return () => clearTimeout(t);
    }
    // On close: restore focus to the trigger.
    if (lastFocusRef.current) {
      lastFocusRef.current.focus?.();
      lastFocusRef.current = null;
    }
    return undefined;
  }, [props.open]);

  // ESC key + focus trap (Tab / Shift+Tab cycling inside the panel).
  useEffect(() => {
    if (!props.open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = focusableWithin(panelRef.current);
      if (items.length === 0) return;
      const first = items[0]!;
      const last  = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [props.open, props.onClose]);

  const width = props.width ?? 480;

  return (
    <>
      {/* Backdrop — fades in/out with the panel.  Click-through when closed. */}
      <div
        onClick={props.onClose}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(2px)',
          opacity: props.open ? 1 : 0,
          pointerEvents: props.open ? 'auto' : 'none',
          transition: 'opacity 200ms ease-out',
          zIndex: 90,
        }}
      />

      {/* Panel — slides in from the right. */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        aria-hidden={!props.open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: `min(${width}px, 100vw)`,
          background: surface.background,
          borderLeft: `1px solid ${surface.border}`,
          transform: props.open ? 'translateX(0)' : `translateX(${width}px)`,
          transition: 'transform 280ms ease-out',
          zIndex: 91,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: props.open ? 'auto' : 'none',
        }}
      >
        {/* Header */}
        <header style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['3'],
          borderBottom: `1px solid ${surface.border}`,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              fontFamily: typography.family.sans,
              fontSize: typography.size.md,
              fontWeight: typography.weight.semi,
              color: text.primary,
              letterSpacing: '-0.005em',
            }}>
              {props.title}
            </span>
            {props.subtitle && (
              <span style={{
                fontFamily: typography.family.sans,
                fontSize: typography.size.xs,
                color: text.muted,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}>
                {props.subtitle}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
            {props.headerActions}
            <button
            type="button"
            aria-label="Close"
            onClick={props.onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: radius.chip,
              border: `1px solid ${surface.border}`,
              background: 'transparent',
              color: text.tertiary,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 120ms ease-out, color 120ms ease-out',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = surface.well;
              e.currentTarget.style.color = text.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = text.tertiary;
            }}
          >
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
          </div>
        </header>

        {/* Body — scroll inside the panel */}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: space['4'],
          display: 'flex',
          flexDirection: 'column',
          gap: space['3'],
        }}>
          {props.children}
        </div>
      </aside>
    </>
  );
}
