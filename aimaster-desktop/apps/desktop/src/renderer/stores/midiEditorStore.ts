// midiEditorStore — everything the Key Editor needs that is not the session.
//
// The notes themselves live in the session (so undo, playback and bounce all
// see the same data); this store holds which part is open, what is selected,
// and the editor's own preferences — grid, scale, controller lane, quantize
// and humanize settings.

import { create } from 'zustand';
import type { ExpressionTarget } from '../daw/model/midi.js';
import type { Scale } from '../daw/model/scales.js';
import type { QuantizeOptions } from '../daw/edit/midi-edit.js';

export interface OpenPart {
  trackId: string;
  clipId: string;
}

/** Note-value denominators, as the grid menu shows them. */
export const GRID_DIVISIONS = [1, 2, 4, 8, 16, 32, 64] as const;
export type GridDivision = typeof GRID_DIVISIONS[number];

export const CONTROLLER_TARGETS: ExpressionTarget[] = [
  { kind: 'pitchBend' },
  { kind: 'pressure' },
  { kind: 'timbre' },
  { kind: 'cc', controller: 1 },
  { kind: 'cc', controller: 11 },
  { kind: 'cc', controller: 64 },
];

export type LaneMode = 'velocity' | 'controller';

interface MidiEditorState {
  open: OpenPart | null;
  openPart: (part: OpenPart) => void;
  close: () => void;

  /**
   * Ghost notes — another part drawn faintly behind the one being edited.
   *
   * FL's idea, and it is purely a display concern: the notes are read from the
   * session like any others and are never editable here, so writing a bass
   * line against the chords you can see costs nothing but a lookup.  Null is
   * "off", and the ghost is dropped automatically when the part it points at
   * disappears.
   */
  ghost: OpenPart | null;
  setGhost: (part: OpenPart | null) => void;

  selectedNoteIds: string[];
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string, additive: boolean) => void;
  clearSelection: () => void;

  /** Grid + snap. */
  division: GridDivision;
  setDivision: (d: GridDivision) => void;
  triplet: boolean;
  toggleTriplet: () => void;
  snapEnabled: boolean;
  toggleSnap: () => void;

  /** Scale Assistant. */
  scale: Scale;
  setScale: (s: Scale) => void;
  showScaleGuides: boolean;
  toggleScaleGuides: () => void;
  snapPitchEditing: boolean;
  toggleSnapPitchEditing: () => void;
  /** Follow the chord track instead of the editor scale. */
  useChordTrack: boolean;
  setUseChordTrack: (v: boolean) => void;

  /** Bottom lane. */
  laneMode: LaneMode;
  setLaneMode: (m: LaneMode) => void;
  controllerTarget: ExpressionTarget;
  setControllerTarget: (t: ExpressionTarget) => void;

  /**
   * View.
   *
   * The piano roll's axis is BEATS, not seconds — that is the axis its
   * ruler shows and its notes are stored on, so a tempo change never
   * redraws the roll.
   */
  pxPerBeat: number;
  setPxPerBeat: (v: number) => void;
  pitchHeight: number;
  setPitchHeight: (v: number) => void;
  scrollBeat: number;
  setScrollBeat: (v: number) => void;
  /** Lowest visible pitch (the grid draws upward from here). */
  bottomPitch: number;
  setBottomPitch: (v: number) => void;

  /** Operation settings, remembered between uses like a real editor. */
  quantize: QuantizeOptions;
  setQuantize: (patch: Partial<QuantizeOptions>) => void;
  humanizeTimingMs: number;
  humanizeVelocity: number;
  humanizeSeed: number;
  setHumanize: (patch: Partial<{ timingMs: number; velocity: number; seed: number }>) => void;
  legatoPercent: number;
  setLegatoPercent: (v: number) => void;
  overlapMs: number;
  setOverlapMs: (v: number) => void;
  transposeSemitones: number;
  setTransposeSemitones: (v: number) => void;
  scaleCorrection: boolean;
  toggleScaleCorrection: () => void;
}

export const useMidiEditorStore = create<MidiEditorState>((set) => ({
  open: null,
  ghost: null,
  setGhost: (ghost) => set({ ghost }),
  openPart: (part) => set({ open: part, selectedNoteIds: [] }),
  close: () => set({ open: null, selectedNoteIds: [] }),

  selectedNoteIds: [],
  setSelection: (ids) => set({ selectedNoteIds: ids }),
  toggleSelected: (id, additive) => set((s) => {
    if (!additive) return { selectedNoteIds: [id] };
    return s.selectedNoteIds.includes(id)
      ? { selectedNoteIds: s.selectedNoteIds.filter((n) => n !== id) }
      : { selectedNoteIds: [...s.selectedNoteIds, id] };
  }),
  clearSelection: () => set({ selectedNoteIds: [] }),

  division: 16,
  setDivision: (d) => set({ division: d }),
  triplet: false,
  toggleTriplet: () => set((s) => ({ triplet: !s.triplet })),
  snapEnabled: true,
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

  scale: { root: 0, scaleId: 'aeolian' },
  setScale: (scale) => set({ scale }),
  showScaleGuides: true,
  toggleScaleGuides: () => set((s) => ({ showScaleGuides: !s.showScaleGuides })),
  snapPitchEditing: false,
  toggleSnapPitchEditing: () => set((s) => ({ snapPitchEditing: !s.snapPitchEditing })),
  useChordTrack: false,
  setUseChordTrack: (v) => set({ useChordTrack: v }),

  laneMode: 'velocity',
  setLaneMode: (m) => set({ laneMode: m }),
  controllerTarget: { kind: 'pitchBend' },
  setControllerTarget: (t) => set({ controllerTarget: t, laneMode: 'controller' }),

  pxPerBeat: 110,
  setPxPerBeat: (v) => set({ pxPerBeat: Math.max(10, Math.min(1500, v)) }),
  pitchHeight: 12,
  setPitchHeight: (v) => set({ pitchHeight: Math.max(5, Math.min(40, v)) }),
  scrollBeat: 0,
  setScrollBeat: (v) => set({ scrollBeat: Math.max(0, v) }),
  bottomPitch: 48,
  setBottomPitch: (v) => set({ bottomPitch: Math.max(0, Math.min(120, v)) }),

  quantize: {
    gridBeat: 0.25,          // a sixteenth, at every tempo
    strengthPercent: 100,
    swingPercent: 0,
    tuplet: 1,
    catchRangeBeat: 0,
    safeRangeBeat: 0,
    randomizeBeat: 0,
    seed: 1,
  },
  setQuantize: (patch) => set((s) => ({ quantize: { ...s.quantize, ...patch } })),

  humanizeTimingMs: 12,
  humanizeVelocity: 0.06,
  humanizeSeed: 1,
  setHumanize: (patch) => set((s) => ({
    humanizeTimingMs: patch.timingMs ?? s.humanizeTimingMs,
    humanizeVelocity: patch.velocity ?? s.humanizeVelocity,
    humanizeSeed: patch.seed ?? s.humanizeSeed,
  })),

  legatoPercent: 0,
  setLegatoPercent: (v) => set({ legatoPercent: Math.max(0, Math.min(100, v)) }),
  overlapMs: 0,
  setOverlapMs: (v) => set({ overlapMs: v }),
  transposeSemitones: 0,
  setTransposeSemitones: (v) => set({ transposeSemitones: Math.round(v) }),
  scaleCorrection: false,
  toggleScaleCorrection: () => set((s) => ({ scaleCorrection: !s.scaleCorrection })),
}));

/**
 * Grid step in BEATS for a division.
 *
 * No tempo argument: a sixteenth is a quarter of a beat at 60 BPM and at
 * 174 BPM alike.  The tempo only ever mattered because the grid used to be
 * measured in seconds.
 */
export function gridBeatsFor(division: GridDivision, triplet: boolean): number {
  const straight = 4 / division;
  return triplet ? (straight * 2) / 3 : straight;
}

/** The editor's current grid, in beats. */
export function currentGridBeat(): number {
  const { division, triplet } = useMidiEditorStore.getState();
  return gridBeatsFor(division, triplet);
}

/** Snap a part-relative beat to the grid when snapping is on. */
export function snapBeatToGrid(beat: number): number {
  const { snapEnabled } = useMidiEditorStore.getState();
  if (!snapEnabled) return Math.max(0, beat);
  const grid = currentGridBeat();
  return grid > 0 ? Math.max(0, Math.round(beat / grid) * grid) : Math.max(0, beat);
}
