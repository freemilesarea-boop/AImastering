// Which lanes are under a hand right now.
//
// While you are recording a pass, two things want to drive the same fader: the
// lane, which still holds last take's move, and your hand, which is making the
// next one.  Your hand has to win, or the fader fights you — it snaps back to
// the old automation every time the player schedules another window.
//
// The player therefore skips a lane while its target is live.  It cannot ask
// the store that knows this (the store is React state and the player is not),
// so the answer lives in this module: a set of keys, written by whoever is
// recording, read by the scheduler.  Deliberately tiny and deliberately
// mutable — a registry with one job.
//
// Empty in an offline render, which is the point: a bounce has no hands on it,
// so every lane plays.

const live = new Set<string>();

/** Replace the whole set.  Called once per gesture start and end. */
export function setLiveAutomation(keys: Iterable<string>): void {
  live.clear();
  for (const key of keys) live.add(key);
}

export function isLiveAutomation(key: string): boolean {
  return live.size > 0 && live.has(key);
}

export function anyLiveAutomation(): boolean {
  return live.size > 0;
}

/** Only the tests need this. */
export function clearLiveAutomation(): void {
  live.clear();
}
