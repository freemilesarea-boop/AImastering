import { create } from 'zustand';

export type Page = 'home' | 'mastering' | 'result' | 'tweak' | 'studio' | 'qc' | 'settings' | 'daw';

/** How long a message stays on screen, when nothing replaces it. */
export const NOTIFY_MS = 3500;

/** How long the key hint stays. Shorter than a message — it is an aside. */
export const CHORD_HINT_MS = 2600;

/**
 * How long the projector keeps a key.
 *
 * Long enough to write down, short enough that the next one is not queued
 * behind it: an instructor demonstrating a chain of edits presses a key every
 * couple of seconds.
 */
export const DEMO_CAST_MS = 1600;

interface Notification {
  /** The first line, for readers that want one string. */
  message: string;
  /**
   * Everything this turn said, in order — usually one line.
   *
   * Fourteen places in this app report trouble like this:
   *
   *     for (const problem of result.problems.slice(0, 3)) notify(problem, 'warning');
   *
   * and with one slot and nothing else, that showed the THIRD problem and
   * threw the other two away.  One of them is worse: `daw-commands.ts` emits
   * its warnings, then its skipped tracks, then a success line — so the only
   * thing that ever reached the screen was "saved", from a run that had
   * warnings.  Every one of those loops was written as if the notifier
   * queued, and that is the behaviour that was missing, not fourteen bugs.
   *
   * So messages raised in the SAME turn join one notification instead of
   * replacing each other.  A later turn — the next thing the user does —
   * still replaces, which is what a confirmation wants.
   */
  lines: string[];
  /** How many more there were than `lines` holds. */
  hidden: number;
  type: 'info' | 'success' | 'error' | 'warning';
  /**
   * Which call put this here.
   *
   * There is one slot, so a new message replaces whatever is showing — that
   * part is fine.  What was not is that every call also scheduled a bare
   * `setTimeout(clear)`, and those timers outlive the message they were for:
   * a message arriving 3.3 s after another was wiped 0.2 s later by the
   * older one's countdown.  Measured in the app at 0.2 s against the 3.5 s
   * it was supposed to get.  A timer now only clears the message it was
   * scheduled for.
   *
   * A group keeps the id of its first line, so that one timer still governs
   * the whole group and the rule above is unchanged.
   */
  id: number;
}

/** Lines one toast will hold before it starts counting the rest. */
export const NOTIFY_MAX_LINES = 6;

/** Which type wins when a turn raises more than one kind. */
const SEVERITY: Record<Notification['type'], number> = {
  info: 0, success: 1, warning: 2, error: 3,
};

/**
 * "That button has a key" — shown beside the message, never instead of it.
 *
 * Its own slot because the notifier has exactly one, and a hint that competed
 * for it would cut the command's own message short: measured at 0.2 s against
 * the 3.5 s it was supposed to get, which is the comment above this one.
 */
interface ChordHint {
  label: string;
  chord: string;
  id: number;
}

/**
 * What the instructor just ran, for the projector.
 *
 * Its own slot again, and a short one: this replaces itself several times a
 * minute during a demonstration, while the message slot has to hold what the
 * command SAID for long enough to read.  Two things, two lifetimes.
 */
interface DemoCast {
  label: string;
  /** The key, or null when it was a click. */
  chord: string | null;
  id: number;
}

interface AppStore {
  currentPage: Page;
  notification: Notification | null;
  chordHint: ChordHint | null;
  demoCast: DemoCast | null;
  setPage: (page: Page) => void;
  notify: (message: string, type?: Notification['type']) => void;
  /** Show a command's key. The policy for WHETHER lives in chord-hints.ts. */
  showChordHint: (label: string, chord: string) => void;
  /** Announce a command on the projector. The flag lives in demo-mode.ts. */
  castCommand: (label: string, chord: string | null) => void;
}

// ── Bootstrap guard ───────────────────────────────────────────────────────────
// Block any automatic navigation to the result page before the first real user
// interaction.  Spurious setPage('result') calls during boot (e.g. from hot
// reload state leakage or stale callbacks) are silently dropped instead of
// loading ProductPage with no data → white screen.
let _userHasInteracted = false;

if (typeof window !== 'undefined') {
  const _markInteracted = () => { _userHasInteracted = true; };
  window.addEventListener('pointerdown', _markInteracted, { once: true, capture: true });
  window.addEventListener('keydown',     _markInteracted, { once: true, capture: true });
}

/**
 * Which page to open on, in DEV only.
 *
 * `pnpm dev` lands on the home screen, which is right for the product and
 * wrong for working on the DAW: every reload costs two clicks to get back to
 * where you were.  `?page=daw` on the dev-server URL skips them.
 *
 * Gated on `import.meta.env.DEV` rather than trusted from the URL, because in
 * the packaged app the renderer is loaded from a file:// path a user could in
 * principle influence, and a deep link is not worth a route somebody else can
 * choose.  Unknown values fall back to home rather than rendering nothing.
 */
function initialPage(): Page {
  // `env` is optional on purpose: this module is reachable from a headless
  // harness, where `import.meta` exists and its `env` does not, and a
  // build-time flag is not worth a throw at module scope.
  if (!import.meta.env?.DEV || typeof window === 'undefined') return 'home';
  const wanted = new URLSearchParams(window.location.search).get('page');
  const pages: Page[] = ['home', 'mastering', 'result', 'tweak', 'qc', 'settings', 'daw'];
  // 'result' needs data that a fresh boot does not have — it would white-screen.
  return wanted && wanted !== 'result' && (pages as string[]).includes(wanted)
    ? wanted as Page : 'home';
}

let notifySeq = 0;
/**
 * The notification a synchronous burst is still adding to, or null.
 *
 * Closed in a microtask rather than after a number of milliseconds: the
 * boundary is then exactly "the same turn", with nothing to tune and no
 * window in which two unrelated actions can be mistaken for one.  Anything
 * raised after an `await` starts its own notification, which is right —
 * that is a different moment to the user as well.
 */
let openGroup: number | null = null;
let hintSeq = 0;
let castSeq = 0;

export const useAppStore = create<AppStore>((set, get) => ({
  currentPage:  initialPage(),
  notification: null,

  setPage: (page) => {
    if (page === 'result' && !_userHasInteracted) {
      // eslint-disable-next-line no-console
      console.warn('[AppInner] invalid result route, fallback home — caller:', new Error().stack?.split('\n').slice(2, 5).join(' | '));
      return;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[appStore] setPage:', page, new Error('caller stack').stack?.split('\n').slice(1, 6).join(' | '));
    }
    set({ currentPage: page });
  },

  demoCast: null,
  castCommand: (label, chord) => {
    const id = ++castSeq;
    set({ demoCast: { label, chord, id } });
    setTimeout(() => {
      if (get().demoCast?.id === id) set({ demoCast: null });
    }, DEMO_CAST_MS);
  },

  chordHint: null,
  showChordHint: (label, chord) => {
    const id = ++hintSeq;
    set({ chordHint: { label, chord, id } });
    setTimeout(() => {
      // Only if this is still the hint this timer was started for — the same
      // trap the message slot fell into.
      if (get().chordHint?.id === id) set({ chordHint: null });
    }, CHORD_HINT_MS);
  },

  notify: (message, type = 'info') => {
    const current = get().notification;
    if (openGroup !== null && current !== null && current.id === openGroup) {
      // The same line twice is one line: several of these loops run over a
      // list that can repeat, and a toast that says the same thing three
      // times is the same as saying it once, only longer.
      if (current.lines.includes(message)) return;
      const room = current.lines.length < NOTIFY_MAX_LINES;
      set({ notification: {
        ...current,
        lines: room ? [...current.lines, message] : current.lines,
        hidden: room ? current.hidden : current.hidden + 1,
        type: SEVERITY[type] > SEVERITY[current.type] ? type : current.type,
      } });
      return;
    }

    const id = ++notifySeq;
    openGroup = id;
    queueMicrotask(() => { if (openGroup === id) openGroup = null; });
    set({ notification: { message, lines: [message], hidden: 0, type, id } });
    setTimeout(() => {
      // Only if this is still the message this timer was started for.
      if (get().notification?.id === id) set({ notification: null });
    }, NOTIFY_MS);
  },
}));
