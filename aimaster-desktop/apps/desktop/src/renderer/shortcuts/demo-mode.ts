// 시연 모드 — the key the instructor just pressed, big enough to copy down.
//
// A class watches a projector.  The instructor presses ⌘⌥F, a track freezes,
// and twenty students see the result and not the cause: the keyboard is the
// one part of a demonstration that is invisible.  The usual answer is a
// separate keycast utility, which nobody has installed on the classroom
// machine and which shows the keys WITHOUT the command names.
//
// This app already knows both, in one place: the dispatcher resolves a chord
// to a command before running it, and `runCommand` is the single doorway for
// buttons, menus and the palette.  So demo mode is a flag and two call sites.
//
// ── Off by default, and remembered ──────────────────────────────────────────
//
// Off because a chip announcing every keystroke is the right thing for a
// projector and the wrong thing for working alone.  Remembered because a
// class runs over days and an instructor should not have to find this twice;
// it is per machine, like the other per-person records here, so it goes in
// localStorage and shrugs off a store that is missing or hostile.

const KEY = 'loui.daw.demoMode';

/** Is the instructor's keycast on? */
export function demoModeOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Turn it on or off.  Returns what it now is, which is what the caller says. */
export function setDemoMode(on: boolean): boolean {
  try {
    const store = globalThis.localStorage;
    if (on) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch { /* no store — the flag lives for this run only, which is enough */ }
  return on;
}
