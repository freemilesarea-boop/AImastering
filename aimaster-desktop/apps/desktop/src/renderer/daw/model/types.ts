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

export type TrackId    = string;
export type ClipId     = string;
export type PlaylistId = string;
export type LaneId     = string;
export type SendId     = string;
export type InsertId   = string;
export type GroupId    = string;
export type BusId      = string;
export type FileId     = string;

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
  fileId: FileId;
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
  | { kind: 'plugin';    insertId: InsertId; paramId: string };

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

export type TrackKind = 'audio' | 'aux' | 'master' | 'vca';

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
  frozen: FrozenState | null;
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

// ── Markers / session ─────────────────────────────────────────────────────────

export interface Marker {
  id: string;
  name: string;
  timeSec: number;
}

export const DAW_SESSION_VERSION = 1 as const;

export interface DawSession {
  version: typeof DAW_SESSION_VERSION;
  id: string;
  name: string;
  sampleRate: number;
  tempoBpm: number;
  timeSignature: [number, number];
  files: AudioFileRef[];
  tracks: Track[];
  buses: BusDef[];
  groups: GroupDef[];
  markers: Marker[];
  /** Delay compensation on/off — mirrors the Pro Tools engine switch. */
  delayCompensation: boolean;
}
