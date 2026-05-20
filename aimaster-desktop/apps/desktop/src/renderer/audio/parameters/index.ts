// Loui parameter state / engine command contract — barrel.
//
// Public surface:
//   • Types: ModuleId, ParameterDef, ModuleParameterState, …
//   • Definitions: ALL_MODULE_PARAMETER_DEFS
//   • Commands:  EngineCommand union + constructors + describeCommand
//   • State:     <ModuleParameterStateProvider> + useModuleParameters + useEngineCommandLog
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m3-product-next-5a/

export type {
  ModuleId,
  ParameterDef,
  NumericParameterDef,
  BooleanParameterDef,
  EnumParameterDef,
  ParameterValue,
  ValueOf,
  ModuleParameterState,
  AllModulesParameterState,
  ModuleParameterDefinitions,
  AllModulesDefinitions,
  EngineBindingTarget,
} from './parameter-state.js';

export {
  MODULE_IDS,
  findParameterDef,
  defaultStateForModule,
  defaultAllModulesState,
} from './parameter-state.js';

export { ALL_MODULE_PARAMETER_DEFS } from './module-parameter-definitions.js';

export type {
  EngineCommand,
  SetModuleParamCommand,
  SetModuleBypassCommand,
  ResetModuleCommand,
  LoadPresetCommand,
  ApplyReferenceProfileCommand,
  ExportDescriptorUpdateCommand,
  CommandKind,
  CommandSource,
  ValidationResult,
} from './engine-command.js';

export {
  validateParameterValue,
  makeSetParamCommand,
  makeSetBypassCommand,
  makeResetModuleCommand,
  makeLoadPresetCommand,
  makeApplyReferenceCommand,
  makeExportDescriptorCommand,
  describeCommand,
} from './engine-command.js';

export {
  ModuleParameterStateProvider,
  useModuleParameters,
  useAllModuleParameters,
  useApplyPreset,
  useEngineCommandLog,
  useEngineDispatchLog,
  hasParameterStateProvider,
} from './useModuleParameterState.js';

export type {
  ModuleParameterApi,
  ModuleParameterStateProviderProps,
} from './useModuleParameterState.js';
