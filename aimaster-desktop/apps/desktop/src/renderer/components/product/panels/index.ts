// Loui product parameter panels — barrel.
//
// Five module-specific shells.  Each is UI-state-only — no DSP writes.
// Future engine bindings are documented in
// `docs/redesign/loui-mastering-v2/m3-product-next-4/05-FUTURE-DSP-BINDING.md`.

export { EqParameterPanel }        from './EqParameterPanel.js';
export { DynamicsParameterPanel }  from './DynamicsParameterPanel.js';
export { ImagerParameterPanel }    from './ImagerParameterPanel.js';
export { LimiterParameterPanel }   from './LimiterParameterPanel.js';
export { ExportParameterPanel }    from './ExportParameterPanel.js';
export type {
  ExportParameterPanelProps,
  ReMasterExportInfo,
  ExportAsIsInfo,
  ExportActionPhase,
} from './ExportParameterPanel.js';

export { usePanelStateBridge } from './usePanelStateBridge.js';
export type { ControlledPanelProps, PanelStateBridge, ParamRecord } from './usePanelStateBridge.js';
