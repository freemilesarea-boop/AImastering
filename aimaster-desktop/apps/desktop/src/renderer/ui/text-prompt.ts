// text-prompt — asking for one line of text, in a window that has no prompt().
//
// Electron does not implement `window.prompt`.  It is not missing, which a
// `?.` call would survive: it is a function that THROWS —
//
//     prompt() is and will not be supported.
//
// so every caller died at the call, with whatever it was in the middle of
// left half done.  Measured in the packaged app, not inferred from the docs.
// Five features were reached only through it — rename a track, rename a clip,
// a track memo, paste a template, and take a mix snapshot — and all five were
// dead in the shipped build while working in a browser tab, which is why no
// dev-server session ever showed it.
//
// `askText` keeps the shape of the thing it replaces (a promise of the typed
// string, or null for cancel) so a call site reads the same way it did.  The
// dialog is one <input>, which is also what keeps the keyboard layer quiet:
// useDawShortcuts already stands down while an INPUT has focus, so typing an
// 's' into a track name does not solo anything.

import { create } from 'zustand';

export interface TextPromptRequest {
  title: string;
  initial: string;
  /** The typed text, or null when cancelled. */
  resolve: (value: string | null) => void;
}

interface TextPromptStore {
  request: TextPromptRequest | null;
  /** Answer the open request and close.  Idempotent: a double-click cannot resolve twice. */
  answer: (value: string | null) => void;
}

export const useTextPromptStore = create<TextPromptStore>((set, get) => ({
  request: null,
  answer: (value) => {
    const open = get().request;
    if (!open) return;
    set({ request: null });
    open.resolve(value);
  },
}));

/**
 * Ask for one line of text.  Resolves with it, or with null if cancelled.
 *
 * A second ask while one is open cancels the first rather than dropping it:
 * an unresolved promise is a caller waiting forever, and "the dialog was
 * replaced" is a cancel from that caller's point of view.
 */
export function askText(title: string, initial = ''): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useTextPromptStore.getState().answer(null);
    useTextPromptStore.setState({ request: { title, initial, resolve } });
  });
}
