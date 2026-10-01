// slot-player.ts — keeping a Session View slot playing.
//
// A slot is fired by hand, not placed on the timeline, so the transport is
// usually not running at all: its 50 ms tick only exists while the play head
// is moving.  That is the whole difficulty, and it is what went wrong.
//
// A looping MIDI slot used to be scheduled four passes deep and left there.
// Its comment said the passes were "topped up by the tick"; nothing topped
// them up, and nothing could have — measured in the running app with a
// two-second part, a looping slot sounded four passes, at 0.03, 2.03, 4.03
// and 6.03 seconds, and then went silent for the remaining twelve seconds of
// the measurement while the grid still showed it playing.  An AUDIO slot in
// the same grid loops in the source node, so it really does go on for ever:
// one button, two behaviours, decided by what kind of clip was in the cell.
//
// So the passes are topped up here, from a clock this object is handed rather
// than one it assumes, which is what lets a test move time by hand.  What this
// owns is only the SHAPE of a repeat — how many passes, placed when, and
// stopped how.  Making a sound is the caller's job, handed in as `schedule`:
// an instrument for a part, a buffer source for audio, a test's counter.
//
// The pass count rides the audio clock, not a counter incremented per tick.
// A transport that counted its own passes drifted a tenth of a second every
// time round (see `ClipPlayer`), and a slot left running for a whole take
// would accumulate the same error for the same reason.

/** One scheduled sound, and when it is over. */
export interface SlotVoice {
  stop: (at: number) => void;
  /**
   * Context time this voice has finished at — `Infinity` for a source that
   * loops natively, which is over only when it is stopped.
   */
  endsAt: number;
}

/** Make one pass sound at `atCtxTime`.  Called once per pass, in order. */
export type SchedulePass = (atCtxTime: number, pass: number) => SlotVoice[];

export interface SlotStart {
  /** Length of one pass in seconds.  Only read when `loop` is set. */
  lengthSec: number;
  loop: boolean;
  /** Context time pass 0 starts at. */
  startAt: number;
  schedule: SchedulePass;
}

interface LiveSlot extends SlotStart {
  /** Passes handed to `schedule` so far. */
  passes: number;
  voices: SlotVoice[];
}

/** Passes placed in one tick, however short the part is. */
const MAX_PASSES_PER_TICK = 64;

export class SlotPlayer {
  private slots = new Map<string, LiveSlot>();

  constructor(
    private readonly now: () => number,
    private readonly lookaheadSec = 1.0,
  ) {}

  /**
   * Fire a slot.  The first pass is placed immediately — not on the next tick,
   * because a slot is a button being pressed and the timer is up to 50 ms
   * away.
   */
  start(key: string, opts: SlotStart): void {
    this.stop(key, this.now());
    const slot: LiveSlot = { ...opts, passes: 0, voices: [] };
    this.slots.set(key, slot);
    this.fill(slot);
  }

  /** Top every live slot up to the look-ahead.  Call on a timer. */
  tick(): void {
    for (const slot of this.slots.values()) this.fill(slot);
    this.reap();
  }

  private fill(slot: LiveSlot): void {
    const horizon = this.now() + this.lookaheadSec;
    if (!slot.loop || slot.lengthSec <= 0) {
      if (slot.passes === 0) {
        slot.voices.push(...slot.schedule(slot.startAt, 0));
        slot.passes = 1;
      }
      return;
    }
    for (let i = 0; i < MAX_PASSES_PER_TICK; i += 1) {
      const at = slot.startAt + slot.passes * slot.lengthSec;
      if (at > horizon) return;
      slot.voices.push(...slot.schedule(at, slot.passes));
      slot.passes += 1;
    }
  }

  /** Forget voices that are over, so a slot held for an hour is not a leak. */
  private reap(): void {
    const now = this.now();
    for (const slot of this.slots.values()) {
      slot.voices = slot.voices.filter((v) => v.endsAt >= now);
    }
  }

  stop(key: string, at: number): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    for (const voice of slot.voices) {
      try { voice.stop(at); } catch { /* already stopped */ }
    }
    this.slots.delete(key);
  }

  stopAll(at: number): void {
    for (const key of [...this.slots.keys()]) this.stop(key, at);
  }

  /** Which slots are live — the transport uses this to park its timer. */
  get liveKeys(): string[] { return [...this.slots.keys()]; }

  /** Passes placed so far, for the self-tests. */
  passesOf(key: string): number { return this.slots.get(key)?.passes ?? 0; }

  /** Voices still on the books, for the self-tests. */
  voicesOf(key: string): number { return this.slots.get(key)?.voices.length ?? 0; }
}
