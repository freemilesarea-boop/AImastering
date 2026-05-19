// Loui product layout components — barrel export.
//
// Each component is a pure UI shell driven by `loui-theme` tokens.  No
// component owns any DSP wiring; the analyzer panels embedded inside
// `LouiAnalyzerCanvas` / `LouiMeterColumn` consume an externally supplied
// `AnalyzerSession`.

export { LouiTopBar } from './LouiTopBar.js';
export type { LouiTopBarProps } from './LouiTopBar.js';

export { LouiPresetHeader, LOUI_PRESET_TARGETS } from './LouiPresetHeader.js';
export type { LouiPresetHeaderProps, PresetTarget } from './LouiPresetHeader.js';

export { LouiAnalyzerCanvas } from './LouiAnalyzerCanvas.js';
export type { LouiAnalyzerCanvasProps } from './LouiAnalyzerCanvas.js';

export { LouiMeterColumn } from './LouiMeterColumn.js';
export type { LouiMeterColumnProps } from './LouiMeterColumn.js';

export { LouiModuleStrip, LOUI_DEFAULT_MODULES } from './LouiModuleStrip.js';
export type { LouiModuleStripProps, ModuleCardDef, ModuleState } from './LouiModuleStrip.js';

export { LouiStatusBar } from './LouiStatusBar.js';
export type { LouiStatusBarProps } from './LouiStatusBar.js';

export { LouiModuleSlideOver } from './LouiModuleSlideOver.js';
export type { LouiModuleSlideOverProps } from './LouiModuleSlideOver.js';

// Parameter panels — re-exported from `panels/` for one-stop import.
export {
  EqParameterPanel,
  DynamicsParameterPanel,
  ImagerParameterPanel,
  LimiterParameterPanel,
  ExportParameterPanel,
} from './panels/index.js';
export type { ExportParameterPanelProps } from './panels/index.js';
