// transient-chain — WebAudio transient/impact preview (APPROX).
//
// The real module is differential attack/sustain envelope shaping (Rust export /
// worklet).  WebAudio can't isolate transients cheaply, so this preview maps the
// attack/sustain controls onto a single DynamicsCompressorNode + makeup:
//   • sustain < 0 (tighter) → more compression (lower threshold / higher ratio)
//   • attack  > 0 (punchier) → slower comp attack so transients pass + makeup
// It gives directional dynamics feedback — not true transient shaping.  Idle is
// routed around by shared-audio-graph (no coloration).

import type { TransientConfig } from './transient-config.js';
import { sanitizeTransient, isTransientUnity } from './transient-config.js';

export interface TransientChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: TransientConfig): void;
  isActive(): boolean;
  dispose(): void;
}

const db2lin = (db: number): number => Math.pow(10, db / 20);

export function createTransientChain(ctx: BaseAudioContext): TransientChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();

  input.connect(comp); comp.connect(makeup); makeup.connect(output);

  let active = false;
  const apply = (raw: TransientConfig): void => {
    const c = sanitizeTransient(raw);
    active = !isTransientUnity(c);
    const a = c.attackPct / 100;   // −1 … 1  (punch)
    const s = c.sustainPct / 100;  // −1 … 1  (sustain)

    // Sustain reduction (s<0) tightens → more ratio + lower threshold.
    const sustainCut = Math.max(0, -s);
    const ratio = Math.min(20, 1 + sustainCut * 6 + Math.max(0, -a) * 2);
    comp.ratio.value = ratio;
    comp.threshold.value = Math.max(-48, -18 - sustainCut * 14);
    comp.knee.value = 6;
    // More attack/punch → slower comp attack so the transient passes through.
    comp.attack.value = Math.min(0.08, 0.003 + Math.max(0, a) * 0.04);
    comp.release.value = 0.12;
    // Makeup offsets the compression and lifts perceived punch.
    makeup.gain.value = db2lin(sustainCut * 2.5 + Math.max(0, a) * 2);
  };

  const dispose = (): void => {
    for (const n of [input, output, comp, makeup]) { try { n.disconnect(); } catch { /* ignore */ } }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
