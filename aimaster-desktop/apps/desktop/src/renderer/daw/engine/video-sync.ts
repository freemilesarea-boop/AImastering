// Keeping the picture with the music.
//
// THE AUDIO CLOCK IS THE MASTER.  Always, in one direction, with no exception.
// The transport is scheduled against `AudioContext.currentTime`; a
// `<video>` element is a decoder with its own idea of the time, keyframe
// granularity on seeks and tens of milliseconds of startup latency.  Nothing
// good comes of letting it lead, so it never does — it is told where it should
// be and corrects toward that.
//
// The naive version of this is one line: on every transport tick, set
// `video.currentTime` to the playhead.  It is also unwatchable.  A seek tears
// down the decode pipeline and restarts it at the nearest keyframe, so
// correcting twenty times a second produces a slideshow, and the drift it was
// correcting was never visible in the first place.
//
// So corrections go up a ladder, and most of the time the answer is "do
// nothing":
//
//   under half a frame   HOLD.   There is nothing to see.
//   under half a second  RATE.   Run the picture 1–5 % fast or slow until the
//                                gap closes.  Nobody can see a 2 % rate change
//                                on picture; everybody can see a seek.
//   over that            SEEK.   Something real happened — a locate, a loop
//                                wrap, a stall — and only a seek fixes it.
//
// The decision is a pure function so the ladder can be tested without a DOM,
// a codec, or a file.  `VideoFollower` is the thin part that owns an element.

export type SyncAction = 'hold' | 'rate' | 'seek';

export interface SyncDecision {
  action: SyncAction;
  /** What `playbackRate` should be.  1 unless the action is `rate`. */
  rate: number;
  /** Where to seek to.  Only meaningful when the action is `seek`. */
  seekTo: number;
  /** target − current, in seconds.  Positive means the picture is behind. */
  driftSec: number;
}

export interface SyncOptions {
  /** Below this the picture is on time.  Default is half a frame at 25 fps. */
  deadBandSec: number;
  /** Above this a rate nudge cannot catch up in time, so seek instead. */
  seekThresholdSec: number;
  /** How long a rate nudge is given to close the gap. */
  catchUpSec: number;
  /** Largest rate deviation.  Beyond this the correction becomes visible. */
  maxRateDeviation: number;
}

export const DEFAULT_SYNC: SyncOptions = {
  deadBandSec: 0.02,
  seekThresholdSec: 0.5,
  catchUpSec: 1.5,
  maxRateDeviation: 0.05,
};

/**
 * What to do about the gap between where the picture is and where it should be.
 *
 * `videoTime` and `targetTime` are both positions inside the FILE — the caller
 * has already mapped the timeline through the video's start and offset.
 */
export function syncDecision(
  videoTime: number,
  targetTime: number,
  playing: boolean,
  options: SyncOptions = DEFAULT_SYNC,
): SyncDecision {
  const driftSec = targetTime - videoTime;
  const hold: SyncDecision = { action: 'hold', rate: 1, seekTo: targetTime, driftSec };

  if (!Number.isFinite(videoTime) || !Number.isFinite(targetTime)) return hold;

  // Parked.  There is no rate to nudge, so anything past the dead band is a
  // seek — and it has to be, or scrubbing would show the wrong frame.
  if (!playing) {
    return Math.abs(driftSec) <= options.deadBandSec
      ? hold
      : { action: 'seek', rate: 1, seekTo: targetTime, driftSec };
  }

  if (Math.abs(driftSec) <= options.deadBandSec) return hold;

  if (Math.abs(driftSec) > options.seekThresholdSec) {
    return { action: 'seek', rate: 1, seekTo: targetTime, driftSec };
  }

  // Close the gap over `catchUpSec`, clamped so the correction stays invisible.
  const wanted = 1 + driftSec / Math.max(0.05, options.catchUpSec);
  const lo = 1 - options.maxRateDeviation;
  const hi = 1 + options.maxRateDeviation;
  return {
    action: 'rate',
    rate: Math.min(hi, Math.max(lo, wanted)),
    seekTo: targetTime,
    driftSec,
  };
}

// ── The element ───────────────────────────────────────────────────────────────

/** The parts of an HTMLVideoElement this needs — so tests can hand it a fake. */
export interface VideoElementLike {
  currentTime: number;
  playbackRate: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
}

/**
 * Drives one element from transport reports.
 *
 * `follow` is called from the transport's own tick, so it must be cheap and it
 * must never throw: a video that cannot keep up is a video that stutters, not
 * a session that stops.
 */
export class VideoFollower {
  private element: VideoElementLike | null = null;
  private options: SyncOptions = DEFAULT_SYNC;
  /** Last decision, for the UI's drift read-out. */
  private lastDecision: SyncDecision | null = null;
  /** Seeks in flight are not corrected again — that is how thrash starts. */
  private awaitingSeek = false;

  attach(element: VideoElementLike | null, options: Partial<SyncOptions> = {}): void {
    this.element = element;
    this.options = { ...DEFAULT_SYNC, ...options };
    this.awaitingSeek = false;
    this.lastDecision = null;
  }

  get decision(): SyncDecision | null { return this.lastDecision; }

  /**
   * `fileSec` is null when the timeline is outside the picture.
   *
   * The element is paused there rather than seeked to an edge, because a
   * frozen last frame over the end credits reads as "still playing" and is the
   * one state a scoring session must never be confused about.
   */
  follow(fileSec: number | null, playing: boolean): void {
    const element = this.element;
    if (!element) return;

    if (fileSec === null) {
      if (!element.paused) element.pause();
      element.playbackRate = 1;
      this.lastDecision = null;
      return;
    }

    if (playing && element.paused) void element.play().catch(() => { /* autoplay gate */ });
    if (!playing && !element.paused) element.pause();

    // A seek that has not landed reports a stale `currentTime`; deciding on it
    // would produce a second seek, and a third.
    if (element.seeking) { this.awaitingSeek = true; return; }
    this.awaitingSeek = false;

    const decision = syncDecision(element.currentTime, fileSec, playing, this.options);
    this.lastDecision = decision;

    if (decision.action === 'seek') {
      element.currentTime = decision.seekTo;
      element.playbackRate = 1;
      this.awaitingSeek = true;
      return;
    }
    if (element.playbackRate !== decision.rate) element.playbackRate = decision.rate;
  }

  /** A locate: go there now, no ladder.  The user is looking for a frame. */
  locate(fileSec: number | null): void {
    const element = this.element;
    if (!element) return;
    if (fileSec === null) { element.pause(); return; }
    element.currentTime = fileSec;
    element.playbackRate = 1;
    this.awaitingSeek = true;
  }

  detach(): void {
    this.element?.pause();
    this.element = null;
    this.lastDecision = null;
  }
}

/** `+12 ms · 속도 1.01×` — what the drift read-out says. */
export function describeSync(decision: SyncDecision | null): string {
  if (!decision) return '픽처 없음';
  const ms = decision.driftSec * 1000;
  const drift = `${ms >= 0 ? '+' : ''}${ms.toFixed(0)} ms`;
  if (decision.action === 'hold') return `${drift} · 동기`;
  if (decision.action === 'rate') return `${drift} · 속도 ${decision.rate.toFixed(3)}×`;
  return `${drift} · 재탐색`;
}
