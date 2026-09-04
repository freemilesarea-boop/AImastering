// view-window.ts — the DAW window names, on their own.
//
// Split out of dawStore so pure modules can name a window without importing
// the store, which would drag zustand and the audio runtime into a selftest
// that only wanted a string union.

export type DawWindow =
  | 'edit' | 'mix' | 'midi' | 'chain' | 'session' | 'spectral' | 'reference'
  | 'warp' | 'restore' | 'steps' | 'vocal' | 'stems' | 'intel';
