// parametric-eq-chain — runtime BiquadFilter chain for the free parametric EQ.
//
// Builds N WebAudio BiquadFilter nodes in series (input → b[0] → b[1] → … → output).
// `applyBands` reconciles the chain length / types in place, only rebuilding
// when the band COUNT or TYPES change — gain/freq/Q updates re-use the
// existing nodes for click-free realtime edits.
//
// Inserted by shared-audio-graph immediately after the MediaElementSource:
//   source → freeEq → (wasmInsert | nativeDsp | direct) → masterGain → dest

import type { ParametricEqBand, ParametricBandType } from './modules/parametric-eq-model.js';

const TYPE_MAP: Record<ParametricBandType, BiquadFilterType> = {
  highpass:  'highpass',
  lowpass:   'lowpass',
  bell:      'peaking',
  lowshelf:  'lowshelf',
  highshelf: 'highshelf',
};

export interface ParametricEqChain {
  /** Connect the upstream source here. */
  readonly input: AudioNode;
  /** Connect this downstream. */
  readonly output: AudioNode;
  /** Reconcile the chain with a new band list. */
  applyBands(bands: ParametricEqBand[]): void;
  /** True when the chain has at least one enabled band (otherwise a pure passthrough). */
  isActive(): boolean;
  /** Disconnect every internal node. */
  dispose(): void;
}

export function createParametricEqChain(ctx: BaseAudioContext): ParametricEqChain {
  // The chain is bounded by two fixed Gain nodes so the topology around
  // it (in shared-audio-graph) never has to track filter ids.
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.gain.value = 1;
  output.gain.value = 1;

  let filters: { node: BiquadFilterNode; type: ParametricBandType }[] = [];
  let lastActiveCount = 0;

  // Initially: pass through directly.
  input.connect(output);

  function rebuildTopology(nextTypes: ParametricBandType[]): void {
    // Tear down current wiring.
    try { input.disconnect(); } catch { /* ignore */ }
    for (const f of filters) {
      try { f.node.disconnect(); } catch { /* ignore */ }
    }
    // Recreate filters as needed (reusing matching-type slots).
    const next: typeof filters = [];
    for (let i = 0; i < nextTypes.length; i++) {
      const wantType = nextTypes[i]!;
      const existing = filters[i];
      if (existing && existing.type === wantType) {
        next.push(existing);
      } else {
        const n = ctx.createBiquadFilter();
        n.type = TYPE_MAP[wantType];
        next.push({ node: n, type: wantType });
      }
    }
    filters = next;
    // Re-wire input → filters[0..N-1] → output.
    if (filters.length === 0) {
      input.connect(output);
      return;
    }
    input.connect(filters[0]!.node);
    for (let i = 0; i < filters.length - 1; i++) {
      filters[i]!.node.connect(filters[i + 1]!.node);
    }
    filters[filters.length - 1]!.node.connect(output);
  }

  function applyBands(bands: ParametricEqBand[]): void {
    const enabled = bands.filter((b) => b.enabled);
    const wantTypes = enabled.map((b) => b.type);
    // Rebuild only when band count OR per-slot type changed.
    let topologyChanged = wantTypes.length !== filters.length;
    if (!topologyChanged) {
      for (let i = 0; i < wantTypes.length; i++) {
        if (wantTypes[i] !== filters[i]!.type) { topologyChanged = true; break; }
      }
    }
    if (topologyChanged) rebuildTopology(wantTypes);

    // Update parameters on every call (cheap, click-free).
    for (let i = 0; i < enabled.length; i++) {
      const b = enabled[i]!;
      const n = filters[i]!.node;
      n.frequency.value = b.frequencyHz;
      n.Q.value = b.q;
      // Gain only meaningful for shelves and peaking.
      if (b.type === 'highpass' || b.type === 'lowpass') {
        // BiquadFilter ignores gain for these types.
      } else {
        n.gain.value = b.gainDb;
      }
    }
    lastActiveCount = enabled.length;
  }

  function isActive(): boolean { return lastActiveCount > 0; }

  function dispose(): void {
    try { input.disconnect(); } catch { /* ignore */ }
    try { output.disconnect(); } catch { /* ignore */ }
    for (const f of filters) {
      try { f.node.disconnect(); } catch { /* ignore */ }
    }
    filters = [];
  }

  return { input, output, applyBands, isActive, dispose };
}
