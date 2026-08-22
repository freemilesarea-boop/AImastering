// The thing that actually pushes the session out to the desk.
//
// The model decides WHAT the desk should be showing and what has changed
// (model/surface-feedback.ts); this owns the port, the snapshot of what was
// last transmitted, and the pace.
//
// Pace matters more than it looks.  A fader being ridden with the mouse
// changes the session on every animation frame, and a 7-bit control cannot
// show more than 128 distinct positions anyway — so pushing every change
// would flood a 31.25 kbaud wire with messages the desk cannot even
// represent.  The diff already drops repeats; this adds a floor on how often
// the diff is taken at all.

import {
  blackout, feedbackDiff, noteSent, resetSnapshot,
  type FeedbackMessage, type SurfaceSnapshot, type TransportLights,
} from '../model/surface-feedback.js';
import { sourceKey, type ControlBinding } from '../model/control-surface.js';
import { currentValueOf, rangeOf } from '../edit/control-surface-actions.js';
import type { MidiOutPortLike } from './midi-input.js';
import type { DawSession } from '../model/types.js';

/**
 * How often the session is pushed out, at most.
 *
 * 25 ms is four times finer than a 7-bit fader can resolve over a normal
 * gesture, so nothing visible is lost, and it bounds the traffic at 40
 * messages a second per moving control rather than one per frame.
 */
export const FEEDBACK_INTERVAL_MS = 25;

export interface FeedbackPort {
  send: (bytes: number[]) => void;
}

/** A Web MIDI output as this module wants it — narrow, so a fake is trivial. */
export function portOf(out: MidiOutPortLike): FeedbackPort {
  return { send: (bytes) => out.send(bytes) };
}

export interface FeedbackStats {
  /** Messages actually handed to the port. */
  sent: number;
  /** Diffs that produced nothing — the desk was already right. */
  quiet: number;
  /** Sends the port threw on.  A desk unplugged mid-session does this. */
  failed: number;
}

export class SurfaceFeedback {
  private shown: SurfaceSnapshot = new Map();
  private lastPushMs = -Infinity;
  private port: FeedbackPort | null = null;
  readonly stats: FeedbackStats = { sent: 0, quiet: 0, failed: 0 };

  /**
   * Point at a desk, or at nothing.
   *
   * The snapshot is cleared either way: a port that has just been opened is
   * showing whatever it powered up with, and a port being closed will be
   * re-opened knowing nothing.  Assuming otherwise leaves controls stale
   * until their value happens to move.
   */
  attach(port: FeedbackPort | null): void {
    this.port = port;
    resetSnapshot(this.shown);
  }

  get attached(): boolean { return this.port !== null; }

  /**
   * Re-send everything on the next push.
   *
   * For a bank switch: the controls have not changed value, they have changed
   * MEANING, and a diff would find nothing to say.
   */
  invalidate(): void { resetSnapshot(this.shown); }

  /**
   * Push the session out, if anything changed and enough time has passed.
   *
   * `nowMs` is passed in rather than read so the pacing is testable without
   * waiting — the same reason the autosave driver takes its clock.
   */
  push(
    session: DawSession,
    bindings: readonly ControlBinding[],
    lights: TransportLights,
    nowMs: number,
    force = false,
  ): FeedbackMessage[] {
    if (!this.port) return [];
    if (!force && nowMs - this.lastPushMs < FEEDBACK_INTERVAL_MS) return [];
    this.lastPushMs = nowMs;

    const messages = feedbackDiff({
      bindings, session, lights,
      valueOf: currentValueOf,
      rangeOf,
      keyOf: sourceKey,
    }, this.shown);

    if (messages.length === 0) { this.stats.quiet += 1; return []; }
    return this.transmit(messages);
  }

  /** Darken the desk — every lamp off, every motor to the bottom. */
  clear(bindings: readonly ControlBinding[]): FeedbackMessage[] {
    if (!this.port) return [];
    resetSnapshot(this.shown);
    return this.transmit(blackout(bindings, sourceKey));
  }

  private transmit(messages: readonly FeedbackMessage[]): FeedbackMessage[] {
    const port = this.port;
    if (!port) return [];
    const delivered: FeedbackMessage[] = [];
    for (const message of messages) {
      try {
        port.send(message.bytes);
        delivered.push(message);
        this.stats.sent += 1;
      } catch {
        // A desk unplugged mid-session throws here.  The message is NOT
        // recorded as shown, so it goes out again on the next push once the
        // port is back — which is the whole reason the snapshot is updated
        // from what was delivered rather than from what was intended.
        this.stats.failed += 1;
      }
    }
    noteSent(this.shown, delivered);
    return delivered;
  }
}
