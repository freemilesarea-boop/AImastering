// LouiModuleStatusBadge — honest module status chip (OZONE-STYLE-MODULE-SUITE).
//
// Live / Preview only / Export only / Coming soon.  Never let a module
// look more capable than it is (see MODULE_STATUS_POLICY.md).

import React from 'react';
import { typography, meter, text } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';
import { MODULE_STATUS_LABEL, type ModuleStatus } from '../../../audio/modules/loui-module-suite.js';

const COLOR: Record<ModuleStatus, string> = {
  live: meter.safe.foreground,        // mint — fully working
  'preview-only': loui.primaryLavender,
  'export-only': loui.softLavender,
  planned: text.muted,                // muted — not yet
};

export function LouiModuleStatusBadge({ status, size = 'sm' }: { status: ModuleStatus; size?: 'sm' | 'xs' }) {
  const color = COLOR[status];
  const fs = size === 'xs' ? 8 : 9;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: typography.family.sans, fontSize: fs, fontWeight: typography.weight.semi,
      letterSpacing: '0.06em', lineHeight: 1, padding: '2px 5px', borderRadius: 4,
      color, border: `1px solid ${color}`,
      opacity: status === 'planned' ? 0.7 : 1,
    }}>
      {status === 'live' && <span style={{ width: 5, height: 5, borderRadius: 999, background: color, boxShadow: `0 0 4px ${color}` }} />}
      {MODULE_STATUS_LABEL[status]}
    </span>
  );
}
