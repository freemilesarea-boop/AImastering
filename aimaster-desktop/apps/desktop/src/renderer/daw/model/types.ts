// DAW session model — the Pro Tools-shaped data behind the Edit and Mix
// windows.
//
// Design rules:
//   • Plain JSON-serialisable data.  No class instances, no AudioNodes, no
//     React.  The engine and the UI both read THIS; neither owns state.
//   • Every mutation is an immutable pure function (see session-ops.ts), so
//     undo is a stack of session snapshots and nothing can mutate behind the
//     UI's back.
//   • Time is seconds (double).  Sample conversion happens only at the
//     engine boundary — mixing units is how DAW code rots.

import type { ControllerLane, MidiNote, MidiPartConfig } from './midi.js';
import type { Section } from './arrangement.js';
import type { ChordEvent } from './chords.js';
import type { VariSegment } from '../audio/pitch-analysis.js';
import type { MacroRack } from './macros.js';
import type { VideoRef } from './video.js';
import type { DeviceGraph } from './device-graph.js';
import type { Rack } from './racks.js';
import type { SessionGrid } from './session-view.js';
import type { WarpConfig } from './warp.js';
import type { Pattern } from './patterns.js';
import type { StepPattern } from './step-sequencer.js';
export type {
  ControllerLane, MidiNote, MidiPartConfig, ChordEvent, VariSegment, MacroRack,
  Section,
  DeviceGraph, Rack, SessionGrid,
};

export type TrackId    = string;
export type ClipId     = string;
export type PlaylistId = string;
export type LaneId     = string;
export type SendId     = string;
export type InsertId   = string;
export type GroupId    = string;
export type BusId      = string;
export type FileId     = string;

export type ClipKind = 'audio' | 'midi';

// ── Audio sources ─────────────────────────────────────────────────────────────

export interface AudioFileRef {
  id: FileId;
  /** Absolute path on disk (the renderer loads it through the local scheme). */
  path: string;
  name: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
}

// ── Clips ─────────────────────────────────────────────────────────────────────

export type FadeShape = 'linear' | 'equalPower' | 'sCurve';

export interface Fade {
  durationSec: number;
  shape: FadeShape;
}

export const NO_FADE: Fade = { durationSec: 0, shape: 'equalPower' };

export interface Clip {
  id: ClipId;
  /**
   * Audio clips reference a decoded file; MIDI parts carry `notes` instead
   * and leave this empty.
   */
  kind: ClipKind;
  fileId: FileId;
  /** MIDI notes — always empty on an audio clip. */
  notes: MidiNote[];
  /** Part-level controller lanes (CC / bend / pressure automation). */
  controllers: ControllerLane[];
  /**
   * Vocal pitch analysis for an AUDIO clip — the segments a VariAudio-style
   * editor edits.  Empty until the clip has been analysed.
   */
  pitchSegments: VariSegment[];
  /** Bend range + MPE flag for this part. */
  midiConfig: MidiPartConfig;
  name: string;
  /** Position on the timeline. */
  startSec: number;
  /** Offset into the source file where this clip begins. */
  offsetSec: number;
  durationSec: number;
  /** Clip gain — the pre-fader, per-clip trim (Pro Tools "clip gain"). */
  gainDb: number;
  fadeIn: Fade;
  fadeOut: Fade;
  muted: boolean;
  /**
   * Warp settings — absent on clips saved before warp existed and on clips
   * that were never warped.  Read it through `clipWarp()` in model/warp.ts.
   */
  warp?: WarpConfig;
  /**
   * A pattern-backed MIDI clip stores no notes of its own — they live in the
   * session's pattern library, so every placement shares one copy.  Read
   * through `clipNotes()` in model/patterns.ts, never `clip.notes` directly.
   */
  patternId?: string;
  /**
   * A chain applied to THIS CLIP ALONE, and what it replaced.
   *
   * Set when the clip has been through the region lab.  The original file
   * reference is kept so a re-render always starts from the untouched audio —
   * without it, changing one knob and applying again would run the chain over
   * material that had already been through the chain once.
   *
   * Absent on every clip that has never been processed, which is nearly all
   * of them; read it through `clipRegionFx()` rather than reaching in.
   */
  regionFx?: RegionFx;
}

/** How far past the clip's end the chain is allowed to keep ringing. */
export type TailMode =
  /** Stop at the clip's end.  Correct for EQ and gain, wrong for a delay. */
  | 'cut'
  /** Render the ring too and let the clip run long over what follows. */
  | 'keep'
  /**
   * Do not render at all: an aux carries the chain and an automated send
   * opens for the clip.  Shutting a send stops FEEDING the aux rather than
   * silencing it, so the ring continues on its own.
   *
   * Never stored in `RegionFx` — nothing was baked, so there is nothing for a
   * clip to remember.  It exists as a `TailMode` because it is the third
   * answer to the same question the window asks.
   */
  | 'live';

export interface RegionFx {
  inserts: Insert[];
  /** `live` never appears: nothing was baked, so there is nothing to remember. */
  tailMode: Exclude<TailMode, 'live'>;
  /** Seconds of ring the chain reported when this was rendered. */
  tailSec: number;
  /** What the clip pointed at before any of this — the way back. */
  original: { fileId: FileId; offsetSec: number; durationSec: number };
}

/** A take lane.  One playlist is active per track; the rest are alternates. */
export interface Playlist {
  id: PlaylistId;
  name: string;
  clips: Clip[];
}

// ── Inserts / sends ───────────────────────────────────────────────────────────

export const INSERT_SLOTS = 10;   // A–J, as in Pro Tools
export const SEND_SLOTS   = 10;

export interface Insert {
  id: InsertId;
  /** 0–9 → slot A–J. */
  slot: number;
  pluginId: string;
  label: string;
  bypass: boolean;
  /** Reported plugin latency — feeds delay compensation. */
  latencySamples: number;
  params: Record<string, number>;
  /** Bus tapped as the sidechain key input, if the plugin has one. */
  sidechainSource: BusId | null;
  /**
   * Set when this insert is a plugin installed on the machine rather than one
   * of ours.  Kept in the session so opening it somewhere the plugin is not
   * installed can say WHICH plugin is missing instead of dropping the slot.
   */
  external?: ExternalPluginRef;
}

/** Enough to find an installed plugin again, and to name it if we cannot. */
export interface ExternalPluginRef {
  /** `reference` is the device this app defines to exercise the host path. */
  format: 'vst3' | 'au' | 'vst2' | 'clap' | 'reference';
  /** Where it was when it was added; a moved plugin is re-found by `uid`. */
  path: string;
  uid: string;
  name: string;
  vendor: string;
}

export interface Send {
  id: SendId;
  slot: number;
  target: BusId;
  levelDb: number;
  pan: number;
  /** Pre-fader sends ignore the channel fader (cue/parallel work). */
  preFader: boolean;
  mute: boolean;
}

// ── Automation ────────────────────────────────────────────────────────────────

export type AutomationMode = 'off' | 'read' | 'touch' | 'latch' | 'write' | 'trim';

export type AutomationTarget =
  | { kind: 'volume' }
  | { kind: 'pan' }
  | { kind: 'mute' }
  | { kind: 'sendLevel'; sendId: SendId }
  | { kind: 'sendPan';   sendId: SendId }
  | { kind: 'sendMute';  sendId: SendId }
  | { kind: 'plugin';    insertId: InsertId; paramId: string }
  /**
   * One Smart Control knob, which moves the whole macro rack.
   *
   * Not a `plugin` target: the rack's modules are not inserts and have no
   * insert id — they are materialised from the macro values themselves.
   */
  | { kind: 'macro';     macroId: string };

export interface AutomationPoint {
  timeSec: number;
  value: number;
}

export interface AutomationLane {
  id: LaneId;
  target: AutomationTarget;
  mode: AutomationMode;
  /** Sorted by time.  Empty = the lane's static value applies. */
  points: AutomationPoint[];
  visible: boolean;
}

// ── Tracks ────────────────────────────────────────────────────────────────────

/**
 * `instrument` is a MIDI track with its own sound source: it holds MIDI parts
 * and renders them through an instrument, then down the normal channel path
 * (inserts → fader → pan → output), exactly like Cubase's instrument track.
 */
export type TrackKind = 'audio' | 'instrument' | 'aux' | 'master' | 'vca' | 'folder';

/** Where a channel's main output goes. */
export type OutputTarget =
  | { kind: 'bus';    busId: BusId }
  | { kind: 'master' }
  | { kind: 'none' };

export interface FrozenState {
  /** Rendered file replacing live processing while frozen. */
  fileId: FileId;
  /** Inserts that were rendered into the file (kept so unfreeze can restore). */
  renderedInsertIds: InsertId[];
  frozenAt: number;
}

export interface Track {
  id: TrackId;
  name: string;
  kind: TrackKind;
  color: string;
  /** Aux/master/VCA tracks carry no clips; their playlists stay empty. */
  playlists: Playlist[];
  activePlaylistId: PlaylistId;

  volumeDb: number;
  pan: number;            // -1 = hard left, +1 = hard right
  mute: boolean;
  solo: boolean;
  /** Solo-safe channels are never implicitly muted by someone else's solo. */
  soloSafe: boolean;
  recordArm: boolean;

  inserts: Insert[];
  sends: Send[];
  /** Aux inputs read from a bus; audio tracks read from their clips. */
  input: BusId | null;
  output: OutputTarget;

  groupIds: GroupId[];
  /** VCA track controlling this channel's fader, if any. */
  vcaId: TrackId | null;

  automation: AutomationLane[];
  /** UI lane height in px. */
  height: number;
  /**
   * What this track records FROM, saved with the project.
   *
   * Optional so sessions from before it existed still load; read it through
   * the helpers in `model/track-input.ts`, which also resolve the saved
   * device against what is plugged into THIS machine.
   */
  recordInput?: {
    deviceLabel: string | null;
    deviceId: string | null;
    channels: 1 | 2;
  };
  /**
   * Track Delay in milliseconds — negative plays EARLIER.
   *
   * Optional so sessions saved before it existed still load; read it through
   * the helpers in `model/track-delay.ts`, which treat a missing value as 0
   * and decide which of the two mechanisms a track's kind allows.
   */
  delayMs?: number;
  frozen: FrozenState | null;
  /** Sound source for an instrument track (id from the instrument registry). */
  instrumentId: string | null;
  instrumentParams: Record<string, number>;
  /**
   * Track Stack membership.  A track inside a stack names its folder here;
   * the folder itself is a track of kind 'folder'.
   */
  parentId: TrackId | null;
  /** Folder UI state — a collapsed stack shows one row instead of ten. */
  collapsed: boolean;
  /** Macro (Smart Control) rack driving this channel's processing. */
  macros: MacroRack;
  /**
   * Device Chain.  When present it REPLACES the linear insert list: the
   * signal follows this graph, branches and all.  Null keeps the simple
   * slot chain, which is all a mastering session needs.
   */
  deviceGraph: DeviceGraph | null;
  /** Racks referenced by `rack` nodes in the device graph. */
  racks: Rack[];
}

// ── Groups / buses ────────────────────────────────────────────────────────────

export interface GroupDef {
  id: GroupId;
  name: string;
  /** Group letter shown on the strip, e.g. "a". */
  symbol: string;
  memberIds: TrackId[];
  enabled: boolean;
  /** Which controls are linked across the group. */
  linkVolume: boolean;
  linkMute: boolean;
  linkSolo: boolean;
  linkPan: boolean;
}

export interface BusDef {
  id: BusId;
  name: string;
  channels: 1 | 2;
}

// ── Tempo ─────────────────────────────────────────────────────────────────────
//
// Positioned in QUARTER-NOTE BEATS, never in seconds: an event written in
// seconds has to be rewritten every time an earlier tempo changes, and two
// representations of the same truth is how a tempo map rots.  The arithmetic
// lives in `tempo-map.ts`.

export type TempoCurve = 'jump' | 'ramp';

export interface TempoEvent {
  id: string;
  /** Quarter-note beats from the session start. */
  beat: number;
  bpm: number;
  /** How the tempo travels from here to the next event. */
  curve: TempoCurve;
}

export interface MeterEvent {
  id: string;
  /** 1-based bar this signature starts at. */
  bar: number;
  numerator: number;
  /** 1, 2, 4, 8, 16 — the note that gets the beat. */
  denominator: number;
}

export interface TempoMap {
  /** Sorted by beat.  Always has one at beat 0. */
  tempos: TempoEvent[];
  /** Sorted by bar.  Always has one at bar 1. */
  meters: MeterEvent[];
}

// ── Markers / session ─────────────────────────────────────────────────────────

export interface Marker {
  id: string;
  name: string;
  timeSec: number;
}

export const DAW_SESSION_VERSION = 2 as const;

export interface DawSession {
  version: typeof DAW_SESSION_VERSION;
  id: string;
  name: string;
  sampleRate: number;
  /**
   * The tempo at the start of the song, and its opening signature.
   *
   * Kept in step with `tempoMap` rather than replaced by it: features that
   * have not been taught the map read these, and a session written by an
   * older build has only these.  `tempoMapOf` reconciles the two.
   */
  tempoBpm: number;
  timeSignature: [number, number];
  /**
   * Tempo and signature changes over the song.  Absent in sessions saved
   * before the tempo track existed, which is why every reader goes through
   * `tempoMapOf(session)` instead of touching this.
   */
  tempoMap?: TempoMap;
  files: AudioFileRef[];
  tracks: Track[];
  buses: BusDef[];
  groups: GroupDef[];
  markers: Marker[];
  /**
   * The picture, when scoring to one.  At most one — see model/video.ts.
   *
   * Optional because sessions written before video existed do not have it;
   * every reader goes through `videoOf(session)` rather than touching this.
   */
  video?: VideoRef | null;
  /**
   * The song's shape — intro, verse, chorus.
   *
   * Optional because sessions written before sections existed do not have it;
   * every reader goes through `sectionsOf(session)` rather than touching this.
   * A section stores only where it STARTS: its end is the next one's start, so
   * a gap or an overlap is not representable.
   */
  sections?: Section[];
  /**
   * The project's harmony.  Storing chords as structured symbols (root,
   * quality, bass) rather than text is what lets features reason about them —
   * reharmonising, suggesting scales, or generating a part that fits.
   */
  chordTrack: ChordEvent[];
  /** Delay compensation on/off — mirrors the Pro Tools engine switch. */
  delayCompensation: boolean;
  /** Clip grid for the Session View (empty until someone uses it). */
  sessionGrid: SessionGrid;
  /**
   * Pattern library — phrases written once and placed many times.  Optional so
   * sessions saved before patterns existed still load; read it through the
   * helpers in model/patterns.ts, which tolerate its absence.
   */
  patterns?: Pattern[];
  /** Step-sequencer grids, the FL channel rack. */
  stepPatterns?: StepPattern[];
}
