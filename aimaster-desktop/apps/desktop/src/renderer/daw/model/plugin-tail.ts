// How long a device keeps making sound after its input stops.
//
// This exists because of one specific failure.  Cut a piece out of a track,
// put a delay on that piece, render the piece: the delay's last repeats fall
// past the end of the piece and are simply gone, and what you hear is a delay
// that stops mid-sentence.  Nobody would ship that on purpose, and it is the
// default outcome unless something knows how long the chain rings.
//
// The engine already has the right shape for this: a device REPORTS its
// latency (`latencyFor`) rather than the render path guessing.  The tail is
// the same kind of fact, so it is declared the same way — per device, from
// its own parameters, in one table that can be argued with.
//
// Two honest limits, stated rather than hidden:
//
//   · These are estimates to −60 dB, not measurements.  A delay at feedback
//     0.9 is audible for longer than any number here; the cap exists so a
//     mistyped feedback cannot ask for a four-minute render.
//   · A chain's tails ADD.  A delay into a reverb rings for the delay's last
//     repeat AND THEN the reverb's decay after it, because the reverb is
//     still being fed while the delay repeats.  Summing is the conservative
//     answer and conservative is the right side to be wrong on here.

import { findPlugin } from '../engine/plugins.js';
import type { Insert } from './types.js';

/** Longest tail any single device may claim, in seconds. */
export const MAX_DEVICE_TAIL_SEC = 12;
/** Longest tail a whole chain may claim, in seconds. */
export const MAX_CHAIN_TAIL_SEC = 30;

/**
 * Repeats of a feedback delay until it is 60 dB down, as seconds.
 *
 * n = 60 / (−20·log10(feedback)), and n·time is when the last audible repeat
 * lands.  Feedback at or above 1 never decays, which is what the cap is for.
 */
function feedbackTail(timeMs: number, feedback: number): number {
  const time = Math.max(0, timeMs) / 1000;
  if (!(feedback > 0)) return time;             // one repeat and done
  if (feedback >= 1) return MAX_DEVICE_TAIL_SEC;
  const repeats = 60 / (-20 * Math.log10(feedback));
  return Math.min(MAX_DEVICE_TAIL_SEC, time * (repeats + 1));
}

const num = (params: Record<string, number>, key: string, fallback: number): number => {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/**
 * How long one device rings after its input stops, in seconds.
 *
 * Zero for anything that cannot ring — an EQ, a compressor, a clipper.  Their
 * latency is a separate matter and is handled by `latencyFor`; a look-ahead
 * limiter delays the signal but does not outlive it.
 */
export function deviceTailSec(pluginId: string, params: Record<string, number>): number {
  switch (pluginId) {
    // ── Delays ──────────────────────────────────────────────────────────────
    case 'delay':
      return feedbackTail(num(params, 'timeMs', 320), num(params, 'feedback', 0.35));
    case 'pingpong':
      // Ping-pong crosses channels, so a "repeat" is two of them.
      return feedbackTail(num(params, 'timeMs', 350) * 2, num(params, 'feedback', 0.4));
    case 'tapedelay':
      return feedbackTail(num(params, 'timeMs', 400), num(params, 'feedback', 0.45));

    // ── Reverbs ─────────────────────────────────────────────────────────────
    case 'reverb':
      return Math.min(MAX_DEVICE_TAIL_SEC, num(params, 'decaySec', 1.8));
    case 'plate':
      return Math.min(MAX_DEVICE_TAIL_SEC, num(params, 'decaySec', 2.4));
    case 'spring':
      return Math.min(MAX_DEVICE_TAIL_SEC, num(params, 'decaySec', 2.2));
    case 'spacereverb':
      // Convolution: the impulse decides the length and `decayPct` scales it.
      // 2.5 s is the middle of the catalogue — long enough for the rooms,
      // short of the cathedral, and `decayPct` moves it either way.
      return Math.min(MAX_DEVICE_TAIL_SEC, 2.5 * (num(params, 'decayPct', 100) / 100));
    case 'shimmer':
      // Same convolution, plus a pitch-shifted feedback loop that outlives it.
      return Math.min(
        MAX_DEVICE_TAIL_SEC,
        2.5 * (num(params, 'decayPct', 100) / 100)
          + feedbackTail(num(params, 'loopMs', 180), num(params, 'shimmer', 0.45)),
      );

    // ── Modulation with feedback ────────────────────────────────────────────
    // Millisecond delay lines: the ring is real but measured in tens of
    // milliseconds.  Reported anyway, because a chain that ends on a flanger
    // and gets cut at the sample is still a cut.
    case 'flanger':
      return feedbackTail(num(params, 'delayMs', 3), num(params, 'feedback', 0.5));
    case 'phaser':
      return feedbackTail(4, num(params, 'feedback', 0.4));

    default:
      return 0;
  }
}

/**
 * How long a whole insert chain rings, in seconds.
 *
 * Bypassed devices are silent and contribute nothing.  Latency is added on
 * top, because a look-ahead limiter at the end of the chain holds the last
 * samples back by exactly that much and cutting at the tail would clip them.
 */
export function chainTailSec(
  inserts: readonly Insert[], sampleRate: number,
): number {
  let tail = 0;
  for (const insert of inserts) {
    if (insert.bypass) continue;
    tail += deviceTailSec(insert.pluginId, insert.params);
    const descriptor = findPlugin(insert.pluginId);
    if (descriptor) tail += descriptor.latencyFor(insert.params, sampleRate) / sampleRate;
    else tail += insert.latencySamples / sampleRate;
  }
  return Math.min(MAX_CHAIN_TAIL_SEC, tail);
}

/** One line for the window: what the chain says, and which device said most. */
export function describeTail(
  inserts: readonly Insert[], sampleRate: number,
): string {
  const live = inserts.filter((i) => !i.bypass);
  if (live.length === 0) return '체인이 비어 있어 꼬리가 없습니다';
  const tail = chainTailSec(live, sampleRate);
  if (tail <= 0.001) return '이 체인은 울리지 않습니다 — 꼬리가 필요 없습니다';
  let worst = live[0]!;
  let worstTail = -1;
  for (const insert of live) {
    const t = deviceTailSec(insert.pluginId, insert.params);
    if (t > worstTail) { worstTail = t; worst = insert; }
  }
  const name = findPlugin(worst.pluginId)?.name ?? worst.label;
  return `${tail.toFixed(2)} 초 — 대부분 ${name} 에서 나옵니다`;
}
