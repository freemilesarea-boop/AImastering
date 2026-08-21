// Reference store — the analysed pair the Mastering Reference view compares.
//
// Both sides are kept as ANALYSES, not buffers: a two-minute stereo file is
// 40 MB of samples but ~4 KB of measurements, and once it is measured nothing
// downstream needs the audio again.

import { create } from 'zustand';
import {
  analyzeForReference, compareToReference, matchSuggestions,
  type MatchSuggestion, type ReferenceAnalysis, type ReferenceComparison,
} from '../daw/analysis/reference.js';
import type { AudioBufferLike } from '../audio/loudnessCore.js';

export type OverlayTab = 'frequency' | 'dynamics' | 'stereo' | 'tonal';

interface ReferenceState {
  reference: ReferenceAnalysis | null;
  mix: ReferenceAnalysis | null;
  comparison: ReferenceComparison | null;
  suggestions: MatchSuggestion[];
  overlay: OverlayTab;
  analyzing: string | null;

  setOverlay: (tab: OverlayTab) => void;
  setAnalyzing: (label: string | null) => void;
  setReference: (buffer: AudioBufferLike, name: string) => void;
  setMix: (buffer: AudioBufferLike, name: string) => void;
  clear: () => void;
}

function recompare(
  reference: ReferenceAnalysis | null, mix: ReferenceAnalysis | null,
): Pick<ReferenceState, 'comparison' | 'suggestions'> {
  if (!reference || !mix) return { comparison: null, suggestions: [] };
  const comparison = compareToReference(reference, mix);
  return { comparison, suggestions: matchSuggestions(comparison) };
}

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  reference: null,
  mix: null,
  comparison: null,
  suggestions: [],
  overlay: 'frequency',
  analyzing: null,

  setOverlay: (overlay) => set({ overlay }),
  setAnalyzing: (analyzing) => set({ analyzing }),

  setReference: (buffer, name) => {
    const reference = analyzeForReference(buffer, name);
    set({ reference, ...recompare(reference, get().mix) });
  },
  setMix: (buffer, name) => {
    const mix = analyzeForReference(buffer, name);
    set({ mix, ...recompare(get().reference, mix) });
  },
  clear: () => set({ reference: null, mix: null, comparison: null, suggestions: [] }),
}));
