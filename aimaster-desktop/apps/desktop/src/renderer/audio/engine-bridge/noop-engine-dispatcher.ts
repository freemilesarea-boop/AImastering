// NoopEngineDispatcher — the default dispatcher.
//
// Returns `noop` for every command.  Used when no engine is wired (the
// production default until M3-P-NEXT-5C connects a real engine), and as
// a safe fallback inside the provider when no dispatcher prop is given.

import type { EngineCommand } from '../parameters/index.js';
import type { DispatchResult, EngineDispatcher } from './engine-dispatcher.js';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class NoopEngineDispatcher implements EngineDispatcher {
  readonly name = 'noop';

  dispatch(command: EngineCommand): DispatchResult {
    return {
      status: 'noop',
      command,
      timestamp: now(),
      note: 'no engine connected',
    };
  }
}

/** Shared singleton — stateless, safe to reuse. */
export const NOOP_DISPATCHER = new NoopEngineDispatcher();
