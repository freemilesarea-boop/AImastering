// LouiTopBar — Loui Mastering product top bar.
//
// Visual layout (left → right):
//   • Brand wordmark "Loui Mastering" + version / mode chip
//   • Centred transport buttons (Import / Play / Stop / Export) — shells
//   • Right-side dropdown affordances (Preset · Settings) — shells
//
// All buttons are styled with `loui-theme` tokens.  None of them are
// wired to real handlers in this milestone — they are pure UI shells
// that real ProductPage callers fill in via the `onImport` / `onExport`
// / `onSettings` / `onPresetMenu` props.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';

export interface LouiTopBarProps {
  /** Optional small subtitle next to the wordmark — e.g. "Result" or "Mastering". */
  subtitle?: string;
  /** Optional active preset name displayed in the right side dropdown. */
  presetLabel?: string;
  /** Click → go back to the start screen (queue + versions are kept). */
  onBack?: () => void;
  /** Click → open import dialog (drag-and-drop fallback remains in App). */
  onImport?: () => void;
  /** Click → trigger the export flow (WAV save / report). */
  onExport?: () => void;
  /** Click → open the preset menu / picker. */
  onPresetMenu?: () => void;
  /** Click → open settings. */
  onSettings?: () => void;
  /** Live engine status label (e.g. "WASM ready" / "Synthetic"). */
  engineLabel?: string;
}

const buttonBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space['2'],
  height: 28,
  paddingInline: space['3'],
  borderRadius: radius.chip,
  border: `1px solid ${surface.border}`,
  background: 'transparent',
  color: text.tertiary,
  fontFamily: typography.family.sans,
  fontSize: typography.size.sm,
  fontWeight: typography.weight.medium,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 120ms ease-out, color 120ms ease-out',
};

function TopBarButton(props: {
  label: string;
  onClick?: () => void;
  /** Optional emphasised state (e.g. for the Export call-to-action). */
  emphasis?: boolean;
  /** Optional icon glyph rendered to the left of the label. */
  glyph?: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  const style: React.CSSProperties = {
    ...buttonBase,
    ...(props.emphasis
      ? {
          color: text.primary,
          background: hover ? meter.accent.background : 'rgba(167,139,250,0.18)',
          borderColor: 'rgba(167,139,250,0.45)',
        }
      : {
          background: hover ? surface.well : 'transparent',
          color: hover ? text.secondary : text.tertiary,
        }),
  };
  return (
    <button
      className="no-drag"
      type="button"
      onClick={props.onClick}
      style={style}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {props.glyph}
      <span>{props.label}</span>
    </button>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────

function IconImport() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
    </svg>
  );
}
function IconExport() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 11V3M5 6l3-3 3 3M3 13h10" />
    </svg>
  );
}
function IconChevron() {
  return (
    <svg width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4L11.2 4.8M4.8 11.2L3.4 12.6M12.6 12.6L11.2 11.2M4.8 4.8L3.4 3.4" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────

export function LouiTopBar(props: LouiTopBarProps) {
  return (
    <div
      className="drag-region"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: space['3'],
        height: 48,
        paddingInline: space['4'],
        background: surface.background,
        borderBottom: `1px solid ${surface.border}`,
        flexShrink: 0,
      }}
    >
      {/* Back to the start screen — keeps queue + versions. */}
      {props.onBack && (
        <button
          className="no-drag"
          type="button"
          onClick={props.onBack}
          title="파일과 버전은 유지됩니다"
          aria-label="돌아가기"
          style={{ ...buttonBase, paddingInline: space['2'] }}
        >
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
          <span>돌아가기</span>
        </button>
      )}

      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: space['2'], userSelect: 'none' }}>
        <span
          style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.lg,
            fontWeight: typography.weight.semi,
            color: text.primary,
            letterSpacing: '-0.01em',
          }}
        >
          Loui Mastering
        </span>
        {props.subtitle && (
          <>
            <span style={{ color: text.disabled }}>·</span>
            <span style={{
              fontFamily: typography.family.sans,
              fontSize: typography.size.sm,
              color: text.tertiary,
            }}>
              {props.subtitle}
            </span>
          </>
        )}
        {props.engineLabel && (
          <span
            style={{
              marginLeft: space['2'],
              paddingInline: space['2'],
              height: 18,
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: radius.chip,
              border: `1px solid ${surface.border}`,
              background: surface.well,
              color: text.muted,
              fontFamily: typography.family.mono,
              fontSize: typography.size.xs,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {props.engineLabel}
          </span>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right-side cluster — no-drag so buttons stay clickable in Electron */}
      <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
        <TopBarButton label="Import" glyph={<IconImport />} {...(props.onImport ? { onClick: props.onImport } : {})} />
        <TopBarButton
          label={props.presetLabel ?? 'Preset'}
          glyph={<IconChevron />}
          {...(props.onPresetMenu ? { onClick: props.onPresetMenu } : {})}
        />
        <TopBarButton label="Export" emphasis glyph={<IconExport />} {...(props.onExport ? { onClick: props.onExport } : {})} />
        <button
          className="no-drag"
          type="button"
          onClick={props.onSettings}
          aria-label="Settings"
          style={{
            ...buttonBase,
            width: 28,
            paddingInline: 0,
            justifyContent: 'center',
          }}
        >
          <IconSettings />
        </button>
      </div>
    </div>
  );
}
