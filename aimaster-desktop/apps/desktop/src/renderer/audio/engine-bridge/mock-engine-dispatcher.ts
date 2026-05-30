// MockEngineDispatcher — a configurable dispatcher for Storybook + tests.
//
// Wraps PresetPatchDispatcher's translation logic but adds:
//   • a recorded history of every dispatch (for assertions / log views)
//   • configurable failure injection (simulate an engine that rejects
//     certain modules / parameters)
//   • dryRun passthrough
//
// This dispatcher never touches real DSP — it exists to exercise the
// provider → dispatcher → result-log flow in isolation.

import type { AllModulesDefinitions, EngineCommand, ModuleId } from '../parameters/index.js';
import {
  PresetPatchDispatcher,
  type DispatchResult,
  type EngineDispatcher,
  type StagedPatchEntry,
} from './engine-dispatcher.js';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface MockDispatcherOptions {
  /** If true, every dispatch returns `dry-run`. */
  dryRun?: boolean;
  /**
   * Predicate that forces a `failed` result.  Use to simulate an engine
   * that rejects a specific module / parameter.
   */
  failWhen?: (command: EngineCommand) => boolean;
  /** Optional note attached to forced failures. */
  failNote?: string;
}

export class MockEngineDispatcher implements EngineDispatcher {
  readonly name: string;
  private readonly inner: PresetPatchDispatcher;
  private readonly history: DispatchResult[] = [];
  private readonly opts: MockDispatcherOptions;

  constructor(defs: AllModulesDefinitions, opts: MockDispatcherOptions = {}) {
    this.opts = opts;
    this.inner = new PresetPatchDispatcher(defs, { dryRun: opts.dryRun ?? false, name: 'mock' });
    this.name = opts.dryRun ? 'mock (dry-run)' : 'mock';
  }

  dispatch(command: EngineCommand): DispatchResult {
    let result: DispatchResult;
    if (this.opts.failWhen?.(command)) {
      result = {
        status: 'failed',
        command,
        timestamp: now(),
        note: this.opts.failNote ?? 'mock engine rejected the write',
      };
    } else {
      result = this.inner.dispatch(command);
    }
    this.history.push(result);
    return result;
  }

  getStagedPatch(): StagedPatchEntry[] {
    return this.inner.getStagedPatch();
  }

  reset(): void {
    this.inner.reset();
    this.history.length = 0;
  }

  /** Recorded dispatch history (for assertions + dev views). */
  getHistory(): readonly DispatchResult[] {
    return this.history;
  }

  /** Count results by status — handy for tests. */
  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.history) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
}

/** Convenience — fail every command targeting a given module. */
export function failModule(moduleId: ModuleId): (cmd: EngineCommand) => boolean {
  return (cmd) =>
    (cmd.kind === 'SET_MODULE_PARAM' || cmd.kind === 'SET_MODULE_BYPASS' || cmd.kind === 'RESET_MODULE')
      && cmd.moduleId === moduleId;
}
