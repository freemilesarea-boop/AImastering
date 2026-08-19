// Intelligence store — the one place that turns audio into measurements and
// measurements into proposals.
//
// The layer under it is pure: `diagnose`, `autoMix`, `autoMaster`,
// `matchActions` and `interpret` are all functions from measurements to typed
// actions.  This store is the impure shell — it renders the session, holds the
// analysis, and applies what the user accepts.
//
// Nothing here decides anything.  It never applies a suggestion on its own,
// because a tool that moves faders without being asked is a tool nobody
// trusts twice.

import { create } from 'zustand';
import { analysableTracks, analyzeMix, type MixAnalysis } from '../daw/ai/analysis.js';
import { diagnose, type Finding } from '../daw/ai/diagnose.js';
import { autoMix, resetSuggestionIds } from '../daw/ai/mix.js';
import { autoMaster, resetMasterIds, type MasterTarget } from '../daw/ai/master.js';
import { matchActions, resetMatchIds } from '../daw/ai/reference-intel.js';
import {
  duckCurve, duckSuggestion, levelEnvelope, rideCurve, rideSuggestion,
} from '../daw/ai/auto-automation.js';
import { applyActions, type Suggestion } from '../daw/ai/actions.js';
import { interpret, type Interpretation } from '../daw/ai/language.js';
import { renderSession, renderTrack, sessionRange } from '../daw/engine/offline-render.js';
import { transientsFor } from '../daw/engine/audio-cache.js';
import { compareToReference } from '../daw/analysis/reference.js';
import { findTrack, trackClips } from '../daw/model/session-ops.js';
import { useDawStore } from './dawStore.js';
import { useReferenceStore } from './referenceStore.js';
import type { TrackId } from '../daw/model/types.js';

export type IntelTab = 'analyze' | 'mix' | 'master' | 'reference' | 'automation' | 'command';

interface IntelState {
  tab: IntelTab;
  busy: string | null;
  error: string | null;

  analysis: MixAnalysis | null;
  /** When the analysis was taken, so a stale one is visible as stale. */
  analyzedAtMs: number | null;
  findings: Finding[];

  mixSuggestions: Suggestion[];
  masterSuggestions: Suggestion[];
  matchSuggestions: Suggestion[];
  automationSuggestions: Suggestion[];

  masterTarget: MasterTarget;
  /** Suggestions the user has ticked. */
  selected: Set<string>;

  command: string;
  interpretation: Interpretation | null;

  setTab: (tab: IntelTab) => void;
  setMasterTarget: (target: MasterTarget) => void;
  toggleSelected: (id: string) => void;
  selectAll: (suggestions: readonly Suggestion[]) => void;
  clearSelection: () => void;

  analyze: () => Promise<void>;
  runMix: () => void;
  runMaster: () => void;
  runMatch: () => void;
  runRide: (trackId: TrackId) => Promise<void>;
  runDuck: (sourceId: TrackId, targetId: TrackId) => Promise<void>;

  setCommand: (text: string) => void;
  runCommand: () => void;
  applyInterpretation: () => void;
  apply: (suggestions: readonly Suggestion[]) => void;
}

export const useIntelStore = create<IntelState>((set, get) => ({
  tab: 'analyze',
  busy: null,
  error: null,
  analysis: null,
  analyzedAtMs: null,
  findings: [],
  mixSuggestions: [],
  masterSuggestions: [],
  matchSuggestions: [],
  automationSuggestions: [],
  masterTarget: 'streaming',
  selected: new Set(),
  command: '',
  interpretation: null,

  setTab: (tab) => set({ tab }),
  setMasterTarget: (masterTarget) => set({ masterTarget }),

  toggleSelected: (id) => set((s) => {
    const next = new Set(s.selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { selected: next };
  }),
  selectAll: (suggestions) => set({ selected: new Set(suggestions.map((s) => s.id)) }),
  clearSelection: () => set({ selected: new Set() }),

  /**
   * Render the mix and every track, and measure them.  This is the expensive
   * step — everything else in the layer runs on its output.
   */
  analyze: async () => {
    const session = useDawStore.getState().session;
    const range = sessionRange(session);
    if (range.endSec - range.startSec < 0.2) {
      set({ error: '분석할 오디오가 없습니다' });
      return;
    }
    set({ busy: '믹스 렌더링 중…', error: null });
    try {
      const master = await renderSession(session, range);
      const wanted = analysableTracks(session);
      const tracks: Parameters<typeof analyzeMix>[1][number][] = [];

      for (const [index, entry] of wanted.entries()) {
        set({ busy: `트랙 분석 중… (${index + 1}/${wanted.length}) ${entry.name}` });
        try {
          const buffer = await renderTrack(session, entry.id);
          tracks.push({ trackId: entry.id, name: entry.name, kind: entry.kind, buffer });
        } catch {
          // A track that cannot be rendered is left out rather than faked.
        }
      }

      const analysis = analyzeMix(master, tracks, session.name || 'YOUR MIX');
      set({
        analysis,
        analyzedAtMs: Date.now(),
        findings: diagnose(session, analysis),
        busy: null,
      });
    } catch (err) {
      set({ busy: null, error: `분석 실패: ${(err as Error).message}` });
    }
  },

  runMix: () => {
    const { analysis } = get();
    if (!analysis) { set({ error: '먼저 분석하세요' }); return; }
    resetSuggestionIds();
    const suggestions = autoMix(useDawStore.getState().session, analysis);
    set({
      mixSuggestions: suggestions,
      // Pre-select only what the layer is actually confident about.
      selected: new Set(suggestions.filter((s) => s.confidence >= 0.6).map((s) => s.id)),
      error: suggestions.length === 0 ? '제안할 것이 없습니다 — 밸런스가 이미 괜찮습니다' : null,
    });
  },

  runMaster: () => {
    const { analysis, masterTarget } = get();
    if (!analysis) { set({ error: '먼저 분석하세요' }); return; }
    resetMasterIds();
    const reference = useReferenceStore.getState().reference;
    const suggestions = autoMaster(useDawStore.getState().session, analysis, {
      target: masterTarget,
      reference,
    });
    set({
      masterSuggestions: suggestions,
      selected: new Set(suggestions.map((s) => s.id)),
      error: masterTarget === 'reference' && !reference
        ? '레퍼런스를 먼저 불러오세요 (REFERENCE 창)' : null,
    });
  },

  runMatch: () => {
    const { analysis } = get();
    const reference = useReferenceStore.getState().reference;
    if (!reference) { set({ error: '레퍼런스를 먼저 불러오세요 (REFERENCE 창)' }); return; }
    if (!analysis) { set({ error: '먼저 분석하세요' }); return; }
    resetMatchIds();
    const comparison = compareToReference(reference, analysis.master);
    const suggestions = matchActions(useDawStore.getState().session, comparison);
    set({
      matchSuggestions: suggestions,
      selected: new Set(suggestions.map((s) => s.id)),
      error: suggestions.length === 0 ? `이미 ${comparison.score}% 일치합니다` : null,
    });
  },

  runRide: async (trackId) => {
    const session = useDawStore.getState().session;
    const track = findTrack(session, trackId);
    if (!track) return;
    set({ busy: `${track.name} 라이딩 계산 중…`, error: null });
    try {
      const buffer = await renderTrack(session, trackId);
      const channels = buffer.getChannelData(0);
      const envelope = levelEnvelope(channels, buffer.sampleRate);
      const points = rideCurve(envelope);
      const suggestion = rideSuggestion(trackId, track.name, track.volumeDb, points);
      set({
        automationSuggestions: suggestion ? [suggestion] : [],
        selected: suggestion ? new Set([suggestion.id]) : new Set(),
        busy: null,
        error: suggestion ? null : '레벨이 이미 고릅니다 — 라이딩할 것이 없습니다',
      });
    } catch (err) {
      set({ busy: null, error: `라이딩 실패: ${(err as Error).message}` });
    }
  },

  runDuck: async (sourceId, targetId) => {
    const session = useDawStore.getState().session;
    const source = findTrack(session, sourceId);
    const target = findTrack(session, targetId);
    if (!source || !target) return;

    // Triggers come from the source's own transients, in timeline time.
    const triggers: number[] = [];
    for (const clip of trackClips(source)) {
      if (clip.kind !== 'audio') continue;
      for (const onset of transientsFor(clip.fileId)) {
        if (onset < clip.offsetSec || onset > clip.offsetSec + clip.durationSec) continue;
        triggers.push(clip.startSec + (onset - clip.offsetSec));
      }
    }
    if (triggers.length === 0) {
      set({ error: `${source.name} 에서 트리거를 찾지 못했습니다 (오디오가 디코딩되었는지 확인하세요)` });
      return;
    }

    const range = sessionRange(session);
    const points = duckCurve(triggers, range.endSec);
    const suggestion = duckSuggestion(targetId, target.name, source.name, target.volumeDb, points, 4);
    set({
      automationSuggestions: suggestion ? [suggestion] : [],
      selected: suggestion ? new Set([suggestion.id]) : new Set(),
      error: suggestion ? null : '덕킹 곡선을 만들지 못했습니다',
    });
  },

  setCommand: (command) => set({ command }),

  /** Parse only.  The interpretation is shown, and applied on a second press. */
  runCommand: () => {
    const daw = useDawStore.getState();
    const interpretation = interpret(daw.session, get().command, daw.focusedTrackId);
    set({ interpretation, error: interpretation.error ?? null });
  },

  applyInterpretation: () => {
    const { interpretation } = get();
    if (!interpretation || interpretation.actions.length === 0) return;
    useDawStore.getState().apply((s) => applyActions(s, interpretation.actions));
    set({ interpretation: null, command: '' });
  },

  apply: (suggestions) => {
    const { selected } = get();
    const chosen = suggestions.filter((s) => selected.has(s.id));
    if (chosen.length === 0) return;
    useDawStore.getState().apply((s) =>
      chosen.reduce((acc, suggestion) => applyActions(acc, suggestion.actions), s));
    set({ selected: new Set() });
  },
}));
