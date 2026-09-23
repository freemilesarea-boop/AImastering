// When each project was last saved by hand.
//
// The autosave's staleness rule needs this and had nowhere to get it: a
// session that was cleanly saved makes any older autosave stale, and offering
// a stale one is how somebody loses the save they deliberately made. The rule
// was written, and tested, and then called with `null` forever, because
// nothing in the app recorded the time.
//
// It has to survive a restart — the whole question is asked at startup, about
// a run that has already ended — so it goes in localStorage rather than in
// the driver's memory. Keyed by session id, because the answer is per project
// and two projects' autosaves sit in the same folder.
//
// Everything here shrugs off a missing or hostile store: a private window, a
// cleared profile, or somebody else's JSON under our key. A recovery prompt
// that throws is worse than one that offers too much.

const KEY = 'loui.daw.lastManualSave';
/** Ids we keep a time for.  A project saved once a year ago is not news. */
const MAX_ENTRIES = 64;

type Times = Record<string, number>;

function read(): Times {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Times = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record that `sessionId` was saved by hand at `nowMs`. */
export function noteManualSave(sessionId: string, nowMs = Date.now()): void {
  if (!sessionId) return;
  const times = read();
  times[sessionId] = nowMs;
  // Oldest first out, so a machine that has opened hundreds of projects does
  // not grow this without bound.
  const trimmed = Object.entries(times)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch { /* no store, or it is full — the rule just falls back to null */ }
}

/** When `sessionId` was last saved by hand, or null if it never was here. */
export function lastManualSaveMs(sessionId: string): number | null {
  if (!sessionId) return null;
  const at = read()[sessionId];
  return typeof at === 'number' ? at : null;
}
