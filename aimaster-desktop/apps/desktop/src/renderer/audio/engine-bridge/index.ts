// Loui engine bridge — barrel.
//
// The dispatcher seam between UI parameter commands and a real DSP
// engine.  M3-P-NEXT-5B connects only `wired` parameters, and only as
// far as staging an EngineSchema preset patch — no live DSP write yet.
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m3-product-next-5b/

export type {
  DispatchStatus,
  DispatchResult,
  EngineDispatcher,
  StagedPatchEntry,
} from './engine-dispatcher.js';

export {
  PresetPatchDispatcher,
  toEngineValue,
} from './engine-dispatcher.js';

export { NoopEngineDispatcher, NOOP_DISPATCHER } from './noop-engine-dispatcher.js';

export { MockEngineDispatcher, failModule } from './mock-engine-dispatcher.js';
export type { MockDispatcherOptions } from './mock-engine-dispatcher.js';

export { describeDispatchResult } from './describe.js';
