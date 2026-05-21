// ExportSupportBadge + ExportSupportSummary (OZONE-MODULE-NEXT-4).
//
// Honest per-parameter / per-edit export labelling so the user knows which
// changes reach the rendered file vs are preview-only.

import React from 'react';
import { typography, text, meter } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';
import { EXPORT_SUPPORT_LABEL, type ExportSupport } from '../../../audio/engine-bridge/export-parameter-adapter.js';

const COLOR: Record<ExportSupport, string> = {
  exact: meter.safe.foreground,        // mint — reaches the file exactly
  approximate: meter.warn.foreground,  // amber — approximated
  'export-only': loui.softLavender,    // export render only
  'preview-only': loui.primaryLavender,// heard in preview, not exported
  planned: text.muted,
};

export function ExportSupportBadge({ support, size = 'sm' }: { support: ExportSupport; size?: 'sm' | 'xs' }) {
  const color = COLOR[support];
  const fs = size === 'xs' ? 8 : 9;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: typography.family.sans, fontSize: fs, fontWeight: typography.weight.semi,
      letterSpacing: '0.05em', lineHeight: 1, padding: '2px 5px', borderRadius: 4,
      color, border: `1px solid ${color}`, opacity: support === 'planned' ? 0.7 : 1,
    }}>
      {support === 'exact' && <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />}
      {EXPORT_SUPPORT_LABEL[support]}
    </span>
  );
}

export interface ExportSupportSummaryProps {
  exact: number;
  approximate?: number;
  exportOnly?: number;
  previewOnly: number;
}

/** One-line honest summary of how the current edits reach the export. */
export function ExportSupportSummary(props: ExportSupportSummaryProps) {
  const items: Array<{ s: ExportSupport; n: number; suffix?: string }> = [
    { s: 'exact' as ExportSupport, n: props.exact },
    { s: 'approximate' as ExportSupport, n: props.approximate ?? 0 },
    { s: 'export-only' as ExportSupport, n: props.exportOnly ?? 0 },
    { s: 'preview-only' as ExportSupport, n: props.previewOnly, suffix: ' (not exported)' },
  ].filter((i) => i.n > 0);

  if (items.length === 0) {
    return <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>No changes to export.</span>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {items.map((i) => (
        <span key={i.s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ExportSupportBadge support={i.s} size="xs" />
          <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.tertiary }}>
            {i.n}{i.suffix ?? ''}
          </span>
        </span>
      ))}
    </div>
  );
}
