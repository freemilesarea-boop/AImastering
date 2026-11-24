// How many times a command has already shown a student its key.
//
// The DAW has 241 commands and every one of them has a key.  Nobody learns
// that from a list, and the right-click menus have shown their chords from
// the start — but the toolbar is what a beginner actually clicks, and until
// now it said nothing about the keyboard at all.
//
// So after a command is run from a BUTTON, a MENU or the PALETTE (never from
// the keyboard — that person already knows), the app shows the key once in a
// small chip.  Three times per command and then it stops: a hint that keeps
// arriving after it has been read is nagging, and nagging gets dismissed
// without reading, which is the one thing it must not train.
//
// The count has to survive a restart or the fourth session starts the three
// over again, so it goes in localStorage next to the other per-person
// records.  Everything here shrugs off a missing or hostile store: a private
// window, a cleared profile, or somebody else's JSON under our key.  A hint
// that throws would take the command down with it, and the command matters.

const KEY = 'loui.daw.chordHints';

/** Shown at most this many times per command, ever. */
export const MAX_HINTS_PER_COMMAND = 3;

/** Ids we keep a count for.  Bounded so this cannot grow without end. */
const MAX_ENTRIES = 256;

type Counts = Record<string, number>;

function read(): Counts {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Counts = {};
    for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
    }
    return out;
  } catch {
    return {};
  }
}

function write(counts: Counts): void {
  // Highest counts first out of the trim, because a command already at the
  // limit is the one whose record matters least.
  const trimmed = Object.entries(counts).sort((a, b) => a[1] - b[1]).slice(0, MAX_ENTRIES);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch { /* no store, or it is full — the hint just shows again next time */ }
}

/**
 * Should this command show its key now?  Counts the showing if so.
 *
 * One function rather than a read and a separate write, so a caller cannot
 * show the hint and forget to count it — which is how three becomes forever.
 */
export function takeHintTurn(id: string): boolean {
  if (!id) return false;
  const counts = read();
  const shown = counts[id] ?? 0;
  if (shown >= MAX_HINTS_PER_COMMAND) return false;
  counts[id] = shown + 1;
  write(counts);
  return true;
}

/** Forget every count — for a test, or for someone starting the course again. */
export function resetHints(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch { /* nothing to clear */ }
}
