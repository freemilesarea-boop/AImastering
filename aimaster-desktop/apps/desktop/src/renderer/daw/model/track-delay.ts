// Track Delay — moving one track in time, in milliseconds.
//
// Two different jobs wear the same control.  A guitar DI recorded through an
// amp sim that nobody told the engine about arrives late, and pulling it 9 ms
// EARLIER is the only fix that does not re-record it.  A snare that sits a
// hair too eager is pushed 6 ms LATER because that is where the song wants
// it.  Both are the same number with a sign.
//
// The sign is what makes this more than a delay line.
//
//   POSITIVE is easy: hold the signal back.
//   NEGATIVE is not: a delay line cannot produce sound it has not received.
//     The only honest way to play something early is to SCHEDULE it early —
//     to start its clips and notes sooner — and that is possible exactly when
//     the track has events of its own to move.
//
// So the mechanism follows the track, not the preference:
//
//   'events'  audio and instrument tracks own clips and notes, so both signs
//             work: the scheduler places them shifted.  A negative delay at
//             the very start of the timeline runs out of room and the head of
//             the clip is lost — reported, not hidden.
//   'signal'  aux and master carry other people's audio and have nothing to
//             re-schedule, so a positive delay becomes a delay line and a
//             negative one is refused.  There is no sound there yet to move.
//   'none'    VCA and folder tracks carry no signal at all.
//
// What a track delay does NOT move: automation.  A fader move written at
// 1:12 stays at 1:12 — it is a mix decision at a place in the song, not part
// of the performance being shifted.  Cubase behaves the same way, and the
// alternative (dragging the automation along) makes a compensation nudge
// silently rewrite the mix.

import type { Track } from './types.js';

/**
 * Half a second either way.
 *
 * Past this it stops being alignment and starts being an arrangement move,
 * which belongs to the clips themselves where it can be seen.
 */
export const MAX_TRACK_DELAY_MS = 500;

export type DelayMechanism = 'events' | 'signal' | 'none';

export function delayMechanism(track: Track): DelayMechanism {
  switch (track.kind) {
    case 'audio':
    case 'instrument': return 'events';
    case 'aux':
    case 'master':     return 'signal';
    default:           return 'none';
  }
}

/** The delay a track carries, in ms.  Absent, NaN and out-of-range all read 0. */
export function trackDelayMs(track: Track): number {
  const raw = track.delayMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(-MAX_TRACK_DELAY_MS, Math.min(MAX_TRACK_DELAY_MS, raw));
}

export const trackDelaySec = (track: Track): number => trackDelayMs(track) / 1000;

/**
 * The part of a track's delay the SCHEDULER applies, in seconds.
 *
 * Zero for anything that has no events of its own, so the clip player can ask
 * every track without caring what kind it is.
 */
export function scheduleShiftSec(track: Track): number {
  return delayMechanism(track) === 'events' ? trackDelaySec(track) : 0;
}

/**
 * The part the SIGNAL PATH applies, in seconds — never negative.
 *
 * The engine adds this to whatever automatic delay compensation already puts
 * on the channel; they are the same delay line and the same direction.
 */
export function signalDelaySec(track: Track): number {
  return delayMechanism(track) === 'signal' ? Math.max(0, trackDelaySec(track)) : 0;
}
