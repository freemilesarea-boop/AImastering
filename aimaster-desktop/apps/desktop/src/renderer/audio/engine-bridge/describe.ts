// Single-line formatter for a DispatchResult — used by log views.

import type { DispatchResult } from './engine-dispatcher.js';

const STATUS_GLYPH: Record<DispatchResult['status'], string> = {
  applied:     '✓',
  staged:      '⊕',
  unsupported: '∅',
  noop:        '·',
  'dry-run':   '◌',
  failed:      '✗',
};

export function describeDispatchResult(r: DispatchResult): string {
  const ts = r.timestamp.toFixed(0);
  const glyph = STATUS_GLYPH[r.status];
  const cmd = r.command;
  let target: string = cmd.kind;
  if (cmd.kind === 'SET_MODULE_PARAM') target = `${cmd.moduleId}.${cmd.parameterId}`;
  else if (cmd.kind === 'SET_MODULE_BYPASS') target = `${cmd.moduleId}.bypass`;
  else if (cmd.kind === 'RESET_MODULE') target = `${cmd.moduleId} (reset)`;

  const eng = r.enginePath
    ? ` → ${r.engineModule ?? '?'}.${r.enginePath}${r.engineValue !== undefined ? ` = ${JSON.stringify(r.engineValue)}` : ''}`
    : '';
  const note = r.note ? `  (${r.note})` : '';
  return `[${ts}] ${glyph} ${r.status.toUpperCase()} ${target}${eng}${note}`;
}
