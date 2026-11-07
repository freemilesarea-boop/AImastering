// Course templates — the sessions a class starts from.
//
// Three things a student should not have to build before their first lesson:
// a channel strip that is not mad, a reverb they can actually HEAR, and a
// submix that reaches the master.  Each of those is one wrong routing step
// away from silence, and silence in a classroom is twenty minutes of twenty
// people guessing.
//
// These live in CODE, not in the template store, and for a reason:
//
//   A SEEDED STORE ROTS.  Writing these into `localStorage` on first run
//   means a student who deletes one never gets it back, a student who edits
//   one never gets the fix, and a better template in the next build never
//   reaches anyone who already launched the old one.  Read from code, they
//   are the same on every machine and the store stays the student's own.
//
//   NOTHING HERE IS WRITTEN BACK.  The panel lists them, applies them, and
//   cannot delete them — there is nothing to delete.  Saving over one makes
//   an ordinary user template; the built-in is still underneath it.
//
// A bus in this model is a routing node with no processing of its own, so a
// send is inaudible until an AUX track listens to that bus.  Every template
// below that has a send also has the return channel, because "I put a reverb
// on a bus and heard nothing" is the single most common first-week question.
//
// The insert parameters are starting points, not answers.  They are written
// out in full rather than left at the device default so that the first thing
// a student does is MOVE one and hear the difference.

import { EMPTY_RACK } from './macros.js';
import { DEFAULT_TRACK_HEIGHT } from './session-ops.js';
import { TRACK_COLORS } from './track-header.js';
import type { SessionTemplate, TemplateOutput, TemplateSend, TrackTemplate } from './track-template.js';
import type { RackDevice } from './rack-preset.js';
import type { TrackKind } from './types.js';

// Ids carry this prefix so nothing can mistake a built-in for a saved one.
// Not exported: the app never asks "is this one of ours" — built-ins are a
// separate list, not entries in the store to be told apart from the rest.
const COURSE_TEMPLATE_PREFIX = 'builtin:';

// Fixed, not `Date.now()`: a built-in's dates are part of the build, and a
// timestamp that moves every launch would sort these differently each time.
const BUILT_IN_AT = Date.UTC(2026, 0, 1);

const hex = (id: string): string => {
  const found = TRACK_COLORS.find((c) => c.id === id);
  if (!found) throw new Error(`course-templates: 팔레트에 없는 색 ${id}`);
  return found.hex;
};

/** Seconds at the start of 4/4 bar `bar` (1-based) at `bpm`. */
const barAt = (bar: number, bpm: number): number => ((bar - 1) * 4 * 60) / bpm;

interface TrackSpec {
  /** The track's name — also how groups and sends refer to it. */
  name: string;
  color: string;
  kind?: TrackKind;
  volumeDb?: number;
  pan?: number;
  /** Instrument id for an instrument track. */
  instrument?: string;
  /** Insert chain in order; the slot is the position in this list. */
  inserts?: readonly (readonly [string, Record<string, number>])[];
  sends?: readonly { bus: string; levelDb: number }[];
  /** Bus name this channel's output feeds; the master when absent. */
  out?: string;
  /** For an aux: the bus it returns. */
  input?: string;
}

function device(slot: number, [pluginId, params]: readonly [string, Record<string, number>]): RackDevice {
  return { slot, pluginId, label: '', bypass: false, params };
}

function send(s: { bus: string; levelDb: number }, slot: number): TemplateSend {
  return { slot, busName: s.bus, levelDb: s.levelDb, pan: 0, preFader: false, mute: false };
}

function track(spec: TrackSpec): TrackTemplate {
  const output: TemplateOutput = spec.out ? { kind: 'bus', busName: spec.out } : { kind: 'master' };
  return {
    id: '', name: spec.name, note: '',
    createdAt: BUILT_IN_AT, updatedAt: BUILT_IN_AT,
    trackName: spec.name,
    kind: spec.kind ?? (spec.instrument ? 'instrument' : 'audio'),
    color: hex(spec.color),
    height: DEFAULT_TRACK_HEIGHT,
    volumeDb: spec.volumeDb ?? 0,
    pan: spec.pan ?? 0,
    soloSafe: false,
    delayMs: 0,
    instrumentId: spec.instrument ?? null,
    instrumentParams: {},
    inserts: (spec.inserts ?? []).map((d, i) => device(i, d)),
    macros: EMPTY_RACK,
    sends: (spec.sends ?? []).map(send),
    output,
    inputBusName: spec.input ?? null,
  };
}

interface SessionSpec {
  id: string;
  name: string;
  note: string;
  tempoBpm: number;
  buses?: readonly string[];
  groups?: readonly { name: string; members: readonly string[] }[];
  /** Marker names against 4/4 bar numbers, turned into seconds at `tempoBpm`. */
  markers?: readonly (readonly [string, number])[];
  tracks: readonly TrackSpec[];
}

function session(spec: SessionSpec): SessionTemplate {
  return {
    id: `${COURSE_TEMPLATE_PREFIX}${spec.id}`,
    name: spec.name,
    note: spec.note,
    createdAt: BUILT_IN_AT, updatedAt: BUILT_IN_AT,
    tempoBpm: spec.tempoBpm,
    timeSignature: [4, 4],
    delayCompensation: true,
    buses: [...(spec.buses ?? [])],
    // Symbols are the letters the strips show, in the order the groups appear.
    groups: (spec.groups ?? []).map((g, i) => ({
      name: g.name,
      symbol: String.fromCharCode(97 + i),
      memberTrackNames: [...g.members],
    })),
    markers: (spec.markers ?? []).map(([name, bar]) => ({
      name, timeSec: barAt(bar, spec.tempoBpm),
    })),
    tracks: spec.tracks.map(track),
  };
}

// ── The templates ─────────────────────────────────────────────────────────────

const VOCAL_RECORD = session({
  id: 'vocal-record',
  name: '보컬 녹음',
  note: '가이드 한 장, 리드 하나, 더블 둘. 리버브는 리턴 채널로 돌아옵니다.',
  tempoBpm: 90,
  buses: ['Reverb'],
  markers: [['인트로', 1], ['1절', 9], ['후렴', 17], ['2절', 25]],
  groups: [{ name: 'VOX', members: ['Lead Vox', 'Double L', 'Double R'] }],
  tracks: [
    { name: 'Guide', color: 'blue', volumeDb: -6 },
    {
      name: 'Lead Vox', color: 'red',
      inserts: [
        ['eq3', { hpfHz: 90 }],
        ['deesser', { freqHz: 6800, thresholdDb: -24, amount: 0.35 }],
        ['comp', { thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 3 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -14 }],
    },
    {
      name: 'Double L', color: 'rust', pan: -0.6, volumeDb: -4,
      inserts: [
        ['eq3', { hpfHz: 110 }],
        ['comp', { thresholdDb: -16, ratio: 2.5, attackMs: 10, releaseMs: 120, makeupDb: 2 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -18 }],
    },
    {
      name: 'Double R', color: 'rust', pan: 0.6, volumeDb: -4,
      inserts: [
        ['eq3', { hpfHz: 110 }],
        ['comp', { thresholdDb: -16, ratio: 2.5, attackMs: 10, releaseMs: 120, makeupDb: 2 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -18 }],
    },
    {
      name: 'Reverb', color: 'plum', kind: 'aux', input: 'Reverb', volumeDb: -3,
      inserts: [['reverb', { decaySec: 1.6, mix: 1, preDelayMs: 20 }]],
    },
  ],
});

const BAND_MIX = session({
  id: 'band-mix',
  name: '밴드 믹스',
  note: '드럼은 서브믹스로, 리버브와 딜레이는 센드로. 리턴 채널 세 개가 마스터로 갑니다.',
  tempoBpm: 120,
  buses: ['Drums', 'Reverb', 'Delay'],
  markers: [['인트로', 1], ['1절', 9], ['후렴', 25], ['브릿지', 41], ['아웃트로', 57]],
  groups: [
    { name: 'DRM', members: ['Kick', 'Snare', 'Hat', 'OH'] },
    { name: 'GTR', members: ['Gtr L', 'Gtr R'] },
    { name: 'VOX', members: ['Lead Vox', 'Back Vox'] },
  ],
  tracks: [
    {
      name: 'Kick', color: 'slate', out: 'Drums',
      inserts: [
        ['eq3', { hpfHz: 30, lowDb: 2, midDb: -2, midHz: 400 }],
        ['comp', { thresholdDb: -14, ratio: 4, attackMs: 15, releaseMs: 90, makeupDb: 2 }],
      ],
    },
    {
      name: 'Snare', color: 'grey', out: 'Drums',
      inserts: [
        ['eq3', { hpfHz: 90, midDb: 2, midHz: 2500 }],
        ['transient', { attack: 0.25, sustain: 0, mix: 1 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -16 }],
    },
    { name: 'Hat', color: 'olive', out: 'Drums', volumeDb: -3, inserts: [['eq3', { hpfHz: 300 }]] },
    { name: 'OH', color: 'teal', out: 'Drums', volumeDb: -6, inserts: [['eq3', { hpfHz: 150 }]] },
    {
      name: 'Drum Bus', color: 'slate', kind: 'aux', input: 'Drums',
      inserts: [['comp', { thresholdDb: -12, ratio: 2, attackMs: 30, releaseMs: 200, makeupDb: 1.5 }]],
    },
    {
      name: 'Bass', color: 'brass',
      inserts: [
        ['eq3', { hpfHz: 35, lowDb: 1.5 }],
        ['comp', { thresholdDb: -16, ratio: 3, attackMs: 20, releaseMs: 150, makeupDb: 2 }],
        ['saturation', { driveDb: 4, mix: 0.3, bias: 0 }],
      ],
    },
    { name: 'Gtr L', color: 'amber', pan: -0.75, inserts: [['eq3', { hpfHz: 110 }]] },
    { name: 'Gtr R', color: 'amber', pan: 0.75, inserts: [['eq3', { hpfHz: 110 }]] },
    {
      name: 'Keys', color: 'indigo', volumeDb: -3, inserts: [['eq3', { hpfHz: 80 }]],
      sends: [{ bus: 'Reverb', levelDb: -20 }],
    },
    {
      name: 'Lead Vox', color: 'red',
      inserts: [
        ['eq3', { hpfHz: 95 }],
        ['deesser', { freqHz: 6500, thresholdDb: -22, amount: 0.4 }],
        ['comp', { thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 110, makeupDb: 3 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -15 }, { bus: 'Delay', levelDb: -22 }],
    },
    {
      name: 'Back Vox', color: 'rust', volumeDb: -5,
      inserts: [
        ['eq3', { hpfHz: 120 }],
        ['comp', { thresholdDb: -16, ratio: 2.5, attackMs: 12, releaseMs: 140, makeupDb: 2 }],
      ],
      sends: [{ bus: 'Reverb', levelDb: -14 }],
    },
    {
      name: 'Reverb', color: 'plum', kind: 'aux', input: 'Reverb', volumeDb: -2,
      inserts: [['reverb', { decaySec: 2.2, mix: 1, preDelayMs: 25 }]],
    },
    {
      name: 'Delay', color: 'plum', kind: 'aux', input: 'Delay', volumeDb: -4,
      inserts: [['delay', { timeMs: 375, feedback: 0.25, mix: 1 }]],
    },
  ],
});

const STEM_MASTER = session({
  id: 'stem-master',
  name: '스템 마스터링',
  note: '스템 넷을 믹스 버스로 모으고, 그 한 채널에만 체인을 겁니다.',
  tempoBpm: 120,
  buses: ['Mix'],
  tracks: [
    { name: 'Drums', color: 'slate', out: 'Mix', inserts: [['trim', { gainDb: 0 }]] },
    { name: 'Bass', color: 'brass', out: 'Mix', inserts: [['trim', { gainDb: 0 }]] },
    { name: 'Music', color: 'teal', out: 'Mix', inserts: [['trim', { gainDb: 0 }]] },
    { name: 'Vocals', color: 'red', out: 'Mix', inserts: [['trim', { gainDb: 0 }]] },
    {
      name: 'Mix Bus', color: 'grey', kind: 'aux', input: 'Mix',
      inserts: [
        ['eq3', { hpfHz: 25 }],
        ['comp', { thresholdDb: -12, ratio: 2, attackMs: 30, releaseMs: 200, makeupDb: 1 }],
        ['limiter', { ceilingDb: -1, lookaheadMs: 3, releaseMs: 120 }],
      ],
    },
  ],
});

const MIDI_SKETCH = session({
  id: 'midi-sketch',
  name: 'MIDI 스케치',
  note: '악기 네 개와 리버브 리턴. 오디오 파일 없이 바로 그려 넣습니다.',
  tempoBpm: 100,
  buses: ['Reverb'],
  markers: [['인트로', 1], ['A', 9], ['B', 25]],
  tracks: [
    { name: 'Drums', color: 'slate', instrument: 'drummachine' },
    { name: 'Bass', color: 'brass', instrument: 'bass', volumeDb: -3 },
    {
      name: 'Piano', color: 'blue', instrument: 'piano', volumeDb: -4,
      sends: [{ bus: 'Reverb', levelDb: -18 }],
    },
    {
      name: 'Pad', color: 'indigo', instrument: 'polysynth', volumeDb: -8,
      inserts: [['eq3', { hpfHz: 120 }]],
      sends: [{ bus: 'Reverb', levelDb: -12 }],
    },
    {
      name: 'Reverb', color: 'plum', kind: 'aux', input: 'Reverb', volumeDb: -3,
      inserts: [['reverb', { decaySec: 2.6, mix: 1, preDelayMs: 10 }]],
    },
  ],
});

/**
 * In teaching order: record one voice, mix a band, master the stems, and
 * write something from nothing.
 */
export const COURSE_TEMPLATES: readonly SessionTemplate[] = [
  VOCAL_RECORD, BAND_MIX, STEM_MASTER, MIDI_SKETCH,
];
