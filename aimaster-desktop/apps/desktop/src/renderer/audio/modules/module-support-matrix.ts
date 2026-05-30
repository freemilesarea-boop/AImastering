// Module support matrix + honesty validation (OZONE-STYLE-MODULE-SUITE).
//
// Cross-checks the declared module status against the support flags so the
// UI can NEVER imply a module does more than it really does.  The rules
// here are enforced by `pnpm test:modules`.

import { LOUI_MODULES, type LouiModule, type ModuleStatus, type ModuleSupport } from './loui-module-suite.js';

export interface ModuleSupportRow {
  id: string;
  displayName: string;
  status: ModuleStatus;
  preview: ModuleSupport;
  export: ModuleSupport;
  presetBacked: boolean;
}

export function moduleSupportMatrix(): ModuleSupportRow[] {
  return LOUI_MODULES.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    status: m.status,
    preview: m.previewSupport,
    export: m.exportSupport,
    presetBacked: Boolean(m.presetBacked),
  }));
}

/**
 * Honesty rules — return a list of violations (empty = honest):
 *   live         ⇒ preview != none AND export != none
 *   preview-only ⇒ preview != none AND export == none|partial (never full)
 *   export-only  ⇒ export != none AND preview == none
 *   planned      ⇒ preview == none AND export == none
 */
export function validateModuleHonesty(m: LouiModule): string[] {
  const v: string[] = [];
  const { status, previewSupport: p, exportSupport: e } = m;
  switch (status) {
    case 'live':
      if (p === 'none') v.push(`${m.id}: 'live' but previewSupport none`);
      if (e === 'none') v.push(`${m.id}: 'live' but exportSupport none`);
      break;
    case 'preview-only':
      if (p === 'none') v.push(`${m.id}: 'preview-only' but previewSupport none`);
      if (e === 'full') v.push(`${m.id}: 'preview-only' but exportSupport full (should be live)`);
      break;
    case 'export-only':
      if (e === 'none') v.push(`${m.id}: 'export-only' but exportSupport none`);
      if (p !== 'none') v.push(`${m.id}: 'export-only' but previewSupport not none`);
      break;
    case 'planned':
      if (p !== 'none') v.push(`${m.id}: 'planned' but claims preview support`);
      if (e !== 'none') v.push(`${m.id}: 'planned' but claims export support`);
      break;
  }
  return v;
}

export function validateAllModules(): string[] {
  return LOUI_MODULES.flatMap(validateModuleHonesty);
}
