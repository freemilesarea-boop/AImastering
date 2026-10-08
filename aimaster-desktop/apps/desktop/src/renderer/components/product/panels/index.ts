// Loui product parameter panels — barrel.
//
// Five module-specific shells.  Each is UI-state-only — no DSP writes —
// and the app renders none of them: StudioPage uses the generic
// `ModuleParameterPanel` beside them for every module.
//
// `m3-product-next-4/05-FUTURE-DSP-BINDING.md` calls itself the contract
// for wiring these, down to engine paths like `engine.eq.lowCut.frequency`
// reached through a `useEngineParameter` hook.  Neither the paths nor the
// hook exist anywhere in this tree: the wiring landed by another route —
// a `binding` field on each parameter definition, consumed by
// `engine-bridge/`.  Read that doc as a record of a plan, not as a
// description of this code.

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
