// Canonical Loui engine schema (preset v1).
//
// Public namespace: `@aimaster/shared-types/engine`.
//
// Consumed by:
//   - Python adapter:  services/python-audio/app/engine/*.py
//   - TS realtime adapter:  apps/desktop/src/renderer/audio/preset/*.ts
//   - Cross-language equivalence harness: apps/desktop/scripts/dsp-equivalence-compare.ts
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md
//   docs/redesign/loui-mastering-v2/m1/01-DSP-MAPPING.md

export * from './modules.js';
export * from './preset.js';
export * from './validate.js';

/** Current engine schema semver — bump on breaking changes. */
export const ENGINE_API_VERSION = '1.0.0';
