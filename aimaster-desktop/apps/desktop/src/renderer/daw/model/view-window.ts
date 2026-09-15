// view-window.ts — the DAW window names, on their own.
//
// Split out of dawStore so pure modules can name a window without importing
// the store, which would drag zustand and the audio runtime into a selftest
// that only wanted a string union.

export type DawWindow =
  | 'edit' | 'mix' | 'midi' | 'chain' | 'session' | 'spectral' | 'reference'
  | 'warp' | 'restore' | 'steps' | 'vocal' | 'stems' | 'intel';

/**
 * Every panel the workspace can show, in the order the tab strip shows them.
 *
 * ONE list, because there were two: the tab strip spelled the labels out in a
 * thirteen-arm ternary and the body switch repeated the same thirteen names a
 * hundred and forty lines further down.  Two parallel lists of the same
 * things drift — adding a panel to one and forgetting the other gives you
 * either a tab that opens nothing or a panel nothing can reach.
 *
 * The label is also the title a floated panel wears, so the tab and the
 * window cannot come to disagree about what a thing is called.
 */
export interface DawPanel {
  id: DawWindow;
  /** What the tab says, and what the floating window's title bar says. */
  label: string;
}

export const DAW_PANELS: readonly DawPanel[] = [
  { id: 'edit',      label: 'EDIT' },
  { id: 'mix',       label: 'MIX' },
  { id: 'midi',      label: 'KEY' },
  { id: 'chain',     label: 'CHAIN' },
  { id: 'session',   label: 'SESSION' },
  { id: 'steps',     label: 'STEPS' },
  { id: 'warp',      label: 'WARP' },
  { id: 'spectral',  label: 'SPECTRAL' },
  { id: 'vocal',     label: 'VOCAL' },
  { id: 'stems',     label: 'STEMS' },
  { id: 'restore',   label: 'RESTORE' },
  { id: 'reference', label: 'REFERENCE' },
  { id: 'intel',     label: 'AI' },
];

/** The label for a window, or the id itself when something new is unnamed. */
export function panelLabel(id: DawWindow): string {
  return DAW_PANELS.find((p) => p.id === id)?.label ?? id.toUpperCase();
}
