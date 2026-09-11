// Who is keeping the MIDI port open.
//
// The port has three independent reasons to stay open — an armed track, a
// mapped control surface, and audition — and exactly one of them closing it
// is a bug.  That was not hypothetical: with a single `heldOpen` boolean,
// switching audition off closed the port out from under a control surface
// that was still mapped, and the desk went dead with nothing to say why.
//
// So the claim is per holder, and the close decision is one function that can
// be driven without an AudioContext.  The runtime owns one of these and asks
// it; the runtime itself cannot be imported into a test, which is exactly why
// the rule does not live there.

/**
 * Who can hold the port open without arming a track.
 *
 * A union rather than a bare string so a third holder cannot be created by a
 * typo — `release('surfce')` would otherwise silently free nothing.
 */
export type MidiHolder = 'surface' | 'audition';

export class MidiHolds {
  private holders = new Set<MidiHolder>();

  /** Claim the port.  Claiming twice is the same as claiming once. */
  hold(holder: MidiHolder): void { this.holders.add(holder); }

  /** Drop ONE holder's claim.  Everyone else keeps theirs. */
  release(holder: MidiHolder): void { this.holders.delete(holder); }

  has(holder: MidiHolder): boolean { return this.holders.has(holder); }

  get size(): number { return this.holders.size; }

  /** Every current holder, for reporting. */
  list(): MidiHolder[] { return [...this.holders]; }

  /**
   * Whether the port can actually be closed now.
   *
   * `trackCount` is how many tracks the port is currently playing into.  A
   * track wanting the port is as good a reason as a holder — the difference
   * is only that tracks are detached by arming rather than by a claim.
   */
  shouldClose(trackCount: number): boolean {
    return this.holders.size === 0 && trackCount === 0;
  }

  /** Shutdown.  Every claim goes at once and the port is free. */
  clear(): void { this.holders.clear(); }
}
