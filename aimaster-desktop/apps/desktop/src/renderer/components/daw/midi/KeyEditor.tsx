// KeyEditor — the piano roll.
//
// Canvas for the grid, notes, scale guides and the controller lane; React for
// the chrome.  Hit-testing happens against the session's notes directly, so
// what you click is what the engine plays — there is no parallel view model
// to fall out of sync.
//
// Gestures follow the reference editor: draw with the pencil, select and drag
// with the arrow, drag the right edge to resize, drag in the lane to set
// velocity or draw a controller curve.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import {
  useMidiEditorStore, currentGridBeat, snapBeatToGrid, CONTROLLER_TARGETS,
  GRID_DIVISIONS, type GridDivision,
} from '../../../stores/midiEditorStore.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import { findTrack, trackClips, updateClip } from '../../../daw/model/session-ops.js';
import { clipNotes, notesInClipTime, writeClipNotes } from '../../../daw/model/patterns.js';
import {
  createNote, isBlackKey, pitchName, targetLabel, to7bit, from7bit, noteEndBeat,
  curveValueAt, findExpression, setExpression, type ExpressionTarget, type MidiNote,
} from '../../../daw/model/midi.js';
import { isInScale, scalePitchClasses } from '../../../daw/model/scales.js';
import { describeSlot, diamondHalfPx, rowOf, rowsFor } from '../../../daw/model/drum-map.js';
import {
  assignDrumMap, drumMapFor, drumMapsOf,
} from '../../../daw/model/drum-map-session.js';
import { GM_DRUM_MAP } from '../../../daw/model/drum-map.js';
import DrumMapEditor from './DrumMapEditor.js';
import LogicalEditor from './LogicalEditor.js';
import ListEditor from './ListEditor.js';
import MidiInsertRack from './MidiInsertRack.js';
import { trackHasInserts } from '../../../daw/model/midi-insert-track.js';
import { detectChord, formatChord } from '../../../daw/model/chords.js';
import { notesAt, MIN_NOTE_BEATS } from '../../../daw/edit/midi-edit.js';
import { beatsToSecAt, partClock, timelineSecToBeat } from '../../../daw/model/note-time.js';
import { barBeatAt, tempoMapOf } from '../../../daw/model/tempo-map.js';
import KeyEditorInspector from './KeyEditorInspector.js';

const KEYBOARD_WIDTH = 62;
// Wide enough for '46 오픈 하이햇' without truncating the part that identifies it.
const DRUM_HEADER_WIDTH = 116;
const LANE_HEIGHT = 116;
const RULER_HEIGHT = 22;
const RESIZE_HANDLE_PX = 6;

type Drag =
  | { kind: 'move'; noteIds: string[]; startX: number; startY: number; originals: MidiNote[] }
  | { kind: 'resize'; noteIds: string[]; startX: number; originals: MidiNote[] }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'lane'; lastX: number };

export default function KeyEditor() {
  const session   = useDawStore((s) => s.session);
  const apply     = useDawStore((s) => s.apply);
  const applyT    = useDawStore((s) => s.applyTransient);
  const commit    = useDawStore((s) => s.commitEdit);
  const playhead  = useDawStore((s) => s.playheadSec);
  const seek      = useDawStore((s) => s.seek);
  const tool      = useWorkspaceStore((s) => s.tool);

  const open            = useMidiEditorStore((s) => s.open);
  const closeEditor     = useMidiEditorStore((s) => s.close);
  const selectedIds     = useMidiEditorStore((s) => s.selectedNoteIds);
  const setSelection    = useMidiEditorStore((s) => s.setSelection);
  const division        = useMidiEditorStore((s) => s.division);
  const setDivision     = useMidiEditorStore((s) => s.setDivision);
  const triplet         = useMidiEditorStore((s) => s.triplet);
  const toggleTriplet   = useMidiEditorStore((s) => s.toggleTriplet);
  const snapEnabled     = useMidiEditorStore((s) => s.snapEnabled);
  const toggleSnap      = useMidiEditorStore((s) => s.toggleSnap);
  const scale           = useMidiEditorStore((s) => s.scale);
  const showGuides      = useMidiEditorStore((s) => s.showScaleGuides);
  const snapPitch       = useMidiEditorStore((s) => s.snapPitchEditing);
  const laneMode        = useMidiEditorStore((s) => s.laneMode);
  const setLaneMode     = useMidiEditorStore((s) => s.setLaneMode);
  const controllerTarget = useMidiEditorStore((s) => s.controllerTarget);
  const setControllerTarget = useMidiEditorStore((s) => s.setControllerTarget);
  const pxPerBeat        = useMidiEditorStore((s) => s.pxPerBeat);
  const setPxPerBeat     = useMidiEditorStore((s) => s.setPxPerBeat);
  const pitchHeight     = useMidiEditorStore((s) => s.pitchHeight);
  const setPitchHeight  = useMidiEditorStore((s) => s.setPitchHeight);
  const scrollBeat       = useMidiEditorStore((s) => s.scrollBeat);
  const setScrollBeat    = useMidiEditorStore((s) => s.setScrollBeat);
  const bottomPitch     = useMidiEditorStore((s) => s.bottomPitch);
  const setBottomPitch  = useMidiEditorStore((s) => s.setBottomPitch);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneRef   = useRef<HTMLCanvasElement>(null);
  const areaRef   = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 460 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [showKitEditor, setShowKitEditor] = useState(false);
  const [showLogical, setShowLogical] = useState(false);
  const [showList, setShowList] = useState(false);
  const [showInserts, setShowInserts] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{ beat: number; pitch: number } | null>(null);

  const track = open ? findTrack(session, open.trackId) : undefined;
  const part = track ? trackClips(track).find((c) => c.id === open?.clipId) : undefined;
  // Pattern-backed clips store no notes of their own — resolve the link, so a
  // placed pattern opens and edits like any other part.
  const notes = useMemo(() => (part ? clipNotes(session, part) : []), [session, part]);

  // Ghost notes: another part drawn faintly behind this one, never editable.
  const ghost = useMidiEditorStore((s) => s.ghost);
  const setGhost = useMidiEditorStore((s) => s.setGhost);
  // Ghost notes are drawn in the EDITED part's time base, so a chord part that
  // sits elsewhere on the timeline still lines up with what you write.
  const ghostNotes = useMemo(() => (ghost && part
    ? notesInClipTime(session, part, ghost.trackId, ghost.clipId)
    : []), [session, ghost, part]);

  /** MIDI parts other than the one open, as ghost candidates. */
  const ghostCandidates = useMemo(() => session.tracks.flatMap((t) =>
    trackClips(t)
      .filter((c) => c.kind === 'midi' && c.id !== open?.clipId)
      .map((c) => ({ trackId: t.id, clipId: c.id, label: `${t.name} · ${c.name}` }))),
  [session, open?.clipId]);
  const tempo = session.tempoBpm;
  const gridBeat = currentGridBeat();
  // Notes are in beats and the roll draws in beats; the clock is needed only
  // where the timeline intrudes — the play head, and the part's own box.
  const tempoMap = useMemo(() => tempoMapOf(session), [session]);
  const clock = useMemo(
    () => partClock(tempoMap, part?.startSec ?? 0),
    [tempoMap, part?.startSec],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // A drum track turns the vertical axis into KIT ORDER instead of pitch, so
  // the kick is one row and the crash is another, in the order a drummer would
  // list them.  Null on every other track, and everything below then behaves
  // exactly as it did.
  const drumMap = useMemo(() => drumMapFor(session, track), [session, track]);
  const rows = useMemo(
    () => (drumMap ? rowsFor(drumMap, notes) : null), [drumMap, notes]);

  // ── Geometry ────────────────────────────────────────────────────────────
  const toX = useCallback((beat: number) => (beat - scrollBeat) * pxPerBeat, [scrollBeat, pxPerBeat]);
  const toBeat = useCallback((x: number) => scrollBeat + x / pxPerBeat, [scrollBeat, pxPerBeat]);
  const gridHeight = size.height;

  // The two adapters that make the whole editor drum-aware.  Everything below
  // still speaks pitch; only these know that a drum row is a position in a
  // list rather than a semitone.  Row 0 is drawn at the TOP, so it takes the
  // highest value on an axis that counts upward.
  const axisOf = useCallback((pitch: number): number => {
    if (!rows) return pitch;
    const index = rowOf(rows, pitch);
    // A pitch with no row cannot be placed.  `rowsFor` gives every pitch in
    // the part a row, so this is only reachable while dragging past the end.
    return index < 0 ? -1 : rows.length - 1 - index;
  }, [rows]);
  const pitchOfAxis = useCallback((value: number): number => {
    if (!rows) return value;
    // Held inside the kit rather than allowed to fall off it.  A drag past the
    // last row would otherwise land on "no row", which the caller clamps to
    // pitch 0 — a note on an instrument nobody chose, drawn at the bottom of
    // a kit it does not belong to.
    const index = Math.max(0, Math.min(rows.length - 1, rows.length - 1 - value));
    return (rows[index]?.pitch ?? -1);
  }, [rows]);

  // A keyboard is read UPWARD from the bottom, so a piano roll anchors there.
  // A kit is a list read DOWNWARD from the kick, so the drum rows are anchored
  // to the TOP instead — otherwise a 26-row kit floats in the lower half of
  // the grid with several hundred empty pixels above it.
  const visibleRows = Math.max(1, gridHeight / pitchHeight);
  const axisBottom = rows ? rows.length - visibleRows : bottomPitch;

  /**
   * Half-width of a drum hit's diamond, in pixels.
   *
   * ONE definition, used by the drawing, the hit test, the marquee and the
   * resize handle alike.  A shape whose target is computed somewhere else is
   * a shape whose target is not where it is: the diamond was drawn centred on
   * the note start while the click test used the note's RECTANGLE from that
   * start rightwards, so the left half of every diamond was dead and the
   * empty space to its right clicked anyway.
   */
  const drumHalf = useCallback(
    (note: MidiNote): number => diamondHalfPx(note.durationBeat, pxPerBeat, pitchHeight),
    [pitchHeight, pxPerBeat]);
  const toY = useCallback(
    (pitch: number) => gridHeight - (axisOf(pitch) - axisBottom + 1) * pitchHeight,
    [gridHeight, axisBottom, pitchHeight, axisOf],
  );
  const toPitch = useCallback(
    (y: number) => pitchOfAxis(
      Math.round(axisBottom + (gridHeight - y) / pitchHeight - 0.5)),
    [gridHeight, axisBottom, pitchHeight, pitchOfAxis],
  );

  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: Math.max(200, r.width), height: Math.max(160, r.height) });
    });
    ro.observe(el);
    setSize({ width: Math.max(200, el.clientWidth), height: Math.max(160, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  // ── Note updates ────────────────────────────────────────────────────────
  const writeNotes = useCallback((next: MidiNote[], transient = false) => {
    if (!open) return;
    const mutate = (s: typeof session) => {
      // Writing through the link edits the PATTERN, so every placement of it
      // changes at once — that is what makes a pattern a pattern.
      const written = writeClipNotes(s, open.trackId, open.clipId, next);
      // A part always covers its notes, so nothing plays outside the part.
      return updateClip(written, open.trackId, open.clipId, (c) => ({
        ...c,
        durationSec: Math.max(
          c.durationSec,
          beatsToSecAt(clock, next.reduce((m, n) => Math.max(m, noteEndBeat(n)), 0)),
        ),
      }));
    };
    if (transient) applyT(mutate); else apply(mutate);
  }, [open, apply, applyT, session]);

  // ── Drawing ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const inScale = scalePitchClasses(scale);
    const topPitch = bottomPitch + Math.ceil(size.height / pitchHeight);

    // Rows.  On a drum track the rows are kit instruments, so they are striped
    // by position rather than by black/white key, and the scale guides are
    // meaningless and left off — a hi-hat is not in or out of D minor.
    const rowPitches = rows
      ? rows.map((r) => r.pitch)
      : Array.from({ length: topPitch - bottomPitch + 1 }, (_, i) => bottomPitch + i);
    for (let index = 0; index < rowPitches.length; index++) {
      const pitch = rowPitches[index] as number;
      const y = toY(pitch);
      const black = rows ? index % 2 === 1 : isBlackKey(pitch);
      const guided = !rows && showGuides && inScale.has(((pitch % 12) + 12) % 12);
      ctx.fillStyle = black ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      if (!rows && showGuides) {
        ctx.fillStyle = guided
          ? (black ? 'rgba(120,170,255,0.10)' : 'rgba(120,170,255,0.16)')
          : 'rgba(0,0,0,0.25)';
      }
      ctx.fillRect(0, y, size.width, pitchHeight);
      ctx.strokeStyle = pitch % 12 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(0, y + pitchHeight + 0.5);
      ctx.lineTo(size.width, y + pitchHeight + 0.5);
      ctx.stroke();
    }

    // Grid lines
    if (gridBeat > 0) {
      const first = Math.floor(scrollBeat / gridBeat) * gridBeat;
      for (let t = first; t < scrollBeat + size.width / pxPerBeat; t += gridBeat) {
        const x = toX(t);
        const onBeat = Math.abs(t - Math.round(t)) < 1e-6;
        ctx.strokeStyle = onBeat ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, size.height);
        ctx.stroke();
      }
    }

    // Ghost notes — behind everything, dim, and never interactive.
    for (const note of ghostNotes) {
      const x = toX(note.startBeat);
      const w = Math.max(2, note.durationBeat * pxPerBeat);
      const y = toY(note.pitch);
      if (x + w < 0 || x > size.width) continue;
      ctx.fillStyle = 'rgba(190,160,255,0.16)';
      ctx.fillRect(x, y + 1, w, pitchHeight - 2);
      ctx.strokeStyle = 'rgba(190,160,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 1.5, Math.max(1, w - 1), pitchHeight - 3);
    }

    // Notes
    for (const note of notes) {
      const x = toX(note.startBeat);
      const w = Math.max(2, note.durationBeat * pxPerBeat);
      const y = toY(note.pitch);
      if (x + w < 0 || x > size.width) continue;
      const isSelected = selected.has(note.id);
      const intensity = 0.35 + 0.5 * note.velocity;
      ctx.fillStyle = note.muted
        ? 'rgba(120,120,140,0.35)'
        : isSelected ? `rgba(235,80,80,${intensity})` : `rgba(90,150,240,${intensity})`;
      ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;

      if (rows) {
        // A drum hit has no useful length — it is a strike.  Drawn as a
        // diamond at its start, so a 1/32 hi-hat is as visible and as
        // clickable as a whole-bar crash instead of being two pixels wide.
        const half = drumHalf(note);
        // Sit on the SAME device pixel the grid line is drawn on.  The line
        // rounds; a diamond left on the raw coordinate lands up to a pixel
        // beside it, which on a ten-pixel shape reads as "not quite on the
        // beat" — and that is the whole thing a drum editor is for.
        const cx = Math.round(x) + 0.5;
        const cy = Math.round(y + pitchHeight / 2) + 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - half);
        ctx.lineTo(cx + half, cy);
        ctx.lineTo(cx, cy + half);
        ctx.lineTo(cx - half, cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        continue;
      }

      ctx.fillRect(x, y + 1, w, pitchHeight - 2);
      ctx.strokeRect(x + 0.5, y + 1.5, Math.max(1, w - 1), pitchHeight - 3);

      // Per-note expression is visible on the note itself, so MPE data is
      // never invisible in the piano roll.
      const bend = findExpression(note, { kind: 'pitchBend' });
      if (bend && bend.points.length > 1 && w > 8) {
        ctx.strokeStyle = 'rgba(255,235,140,0.9)';
        ctx.beginPath();
        for (let i = 0; i <= 16; i++) {
          const t = (note.durationBeat * i) / 16;
          const v = curveValueAt(bend.points, t, 0);
          const px = x + t * pxPerBeat;
          const py = y + pitchHeight / 2 - v * (pitchHeight / 2 - 1);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      if (w > 26 && pitchHeight >= 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(pitchName(note.pitch), x + 3, y + pitchHeight - 3);
      }
    }

    // Marquee
    if (drag?.kind === 'marquee') {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1),
        Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0),
      );
      ctx.setLineDash([]);
    }

    // Play head (part-relative)
    if (part) {
      const x = toX(timelineSecToBeat(clock, playhead));
      if (x >= 0 && x <= size.width) {
        ctx.strokeStyle = 'rgba(255,90,90,0.95)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
        ctx.stroke();
      }
    }
  }, [notes, size, scale, showGuides, bottomPitch, pitchHeight, pxPerBeat, scrollBeat,
      selected, drag, gridBeat, tempo, toX, toY, part, playhead, rows, ghostNotes,
      drumHalf]);

  // ── Controller / velocity lane ──────────────────────────────────────────
  useEffect(() => {
    const canvas = laneRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(LANE_HEIGHT * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${LANE_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, LANE_HEIGHT);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, size.width, LANE_HEIGHT);

    if (laneMode === 'velocity') {
      for (const note of notes) {
        const x = toX(note.startBeat);
        if (x < -20 || x > size.width) continue;
        const h = note.velocity * (LANE_HEIGHT - 8);
        ctx.fillStyle = selected.has(note.id) ? 'rgba(235,80,80,0.95)' : 'rgba(90,150,240,0.9)';
        ctx.fillRect(x, LANE_HEIGHT - h - 2, 3, h);
      }
    } else {
      // Bipolar targets (pitch bend) draw from the centre.
      const bipolar = controllerTarget.kind === 'pitchBend';
      const zeroY = bipolar ? LANE_HEIGHT / 2 : LANE_HEIGHT - 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(size.width, zeroY);
      ctx.stroke();

      for (const note of notes) {
        const curve = findExpression(note, controllerTarget);
        if (!curve || curve.points.length === 0) continue;
        ctx.strokeStyle = selected.has(note.id) ? 'rgba(255,120,120,0.95)' : 'rgba(255,215,120,0.9)';
        ctx.beginPath();
        for (let i = 0; i <= 32; i++) {
          const t = (note.durationBeat * i) / 32;
          const v = curveValueAt(curve.points, t, 0);
          const px = toX(note.startBeat + t);
          const py = bipolar
            ? zeroY - v * (LANE_HEIGHT / 2 - 4)
            : LANE_HEIGHT - 2 - v * (LANE_HEIGHT - 8);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }, [notes, size.width, laneMode, controllerTarget, selected, toX]);

  // ── Hit testing ─────────────────────────────────────────────────────────
  const localPoint = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const noteAtPoint = useCallback((x: number, y: number): MidiNote | null => {
    const pitch = toPitch(y);
    const sec = toBeat(x);
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (!n) continue;
      if (n.pitch !== pitch) continue;
      // A drum hit's target is the diamond that was drawn — centred on the
      // start — not the note's length, which a strike does not really have.
      if (rows) {
        if (Math.abs(toX(n.startBeat) - x) <= drumHalf(n)) return n;
        continue;
      }
      if (sec >= n.startBeat && sec <= noteEndBeat(n)) return n;
    }
    return null;
  }, [notes, toPitch, toBeat, toX, rows, drumHalf]);

  // ── Grid gestures ───────────────────────────────────────────────────────
  const onGridDown = useCallback((e: React.MouseEvent) => {
    if (!part) return;
    const { x, y } = localPoint(e);
    const hit = noteAtPoint(x, y);

    if (tool === 'erase' || (hit && e.altKey)) {
      if (hit) { writeNotes(notes.filter((n) => n.id !== hit.id)); setSelection([]); }
      return;
    }

    if (!hit) {
      if (tool === 'draw' || e.metaKey || e.ctrlKey) {
        const startBeat = snapBeatToGrid(toBeat(x));
        const note = createNote({
          pitch: Math.max(0, Math.min(127, toPitch(y))),
          startBeat,
          durationBeat: gridBeat > 0 ? gridBeat : 0.25,
          velocity: from7bit(100),
        });
        writeNotes([...notes, note]);
        setSelection([note.id]);
        return;
      }
      setDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y });
      if (!e.shiftKey) setSelection([]);
      return;
    }

    // Clicking a note selects it (shift adds), then drags body or right edge.
    const ids = e.shiftKey
      ? (selected.has(hit.id) ? selectedIds : [...selectedIds, hit.id])
      : (selected.has(hit.id) ? selectedIds : [hit.id]);
    setSelection(ids);

    const noteRight = toX(noteEndBeat(hit));
    const originals = notes.filter((n) => ids.includes(n.id));
    // No resize on a drum row: the diamond has no right edge, so the handle
    // would sit in empty space well past the shape it claims to belong to.
    if (!rows && Math.abs(x - noteRight) <= RESIZE_HANDLE_PX) {
      setDrag({ kind: 'resize', noteIds: ids, startX: x, originals });
    } else {
      setDrag({ kind: 'move', noteIds: ids, startX: x, startY: y, originals });
    }
  }, [part, noteAtPoint, tool, notes, writeNotes, setSelection, toBeat, toPitch, tempo,
      gridBeat, selected, selectedIds, toX, rows]);

  const onGridMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = localPoint(e);
    setHoverInfo({ beat: toBeat(x), pitch: toPitch(y) });
    if (!drag) return;

    if (drag.kind === 'marquee') {
      setDrag({ ...drag, x1: x, y1: y });
      const x0 = Math.min(drag.x0, x); const x1 = Math.max(drag.x0, x);
      const y0 = Math.min(drag.y0, y); const y1 = Math.max(drag.y0, y);
      const inside = notes.filter((n) => {
        const nx = toX(n.startBeat);
        const ny = toY(n.pitch);
        // Rubber-banding has to catch what is DRAWN.  On a drum row that is a
        // diamond around the start, not a bar running off to the right.
        const left = rows ? nx - drumHalf(n) : nx;
        const right = rows ? nx + drumHalf(n) : nx + n.durationBeat * pxPerBeat;
        return right >= x0 && left <= x1 && ny + pitchHeight >= y0 && ny <= y1;
      });
      setSelection(inside.map((n) => n.id));
      return;
    }

    if (drag.kind === 'move') {
      const deltaBeat = (x - drag.startX) / pxPerBeat;
      const deltaPitch = Math.round((drag.startY - y) / pitchHeight);
      const byId = new Map(drag.originals.map((n) => [n.id, n] as const));
      const next = notes.map((n) => {
        const original = byId.get(n.id);
        if (!original) return n;
        const startBeat = snapBeatToGrid(original.startBeat + deltaBeat);
        let pitch = Math.max(0, Math.min(127, original.pitch + deltaPitch));
        if (snapPitch && !isInScale(pitch, scale)) {
          pitch = Math.max(0, Math.min(127, pitch));
        }
        return { ...n, startBeat, pitch };
      });
      writeNotes(next, true);
      return;
    }

    if (drag.kind === 'resize') {
      const deltaBeat = (x - drag.startX) / pxPerBeat;
      const byId = new Map(drag.originals.map((n) => [n.id, n] as const));
      const next = notes.map((n) => {
        const original = byId.get(n.id);
        if (!original) return n;
        const end = snapBeatToGrid(noteEndBeat(original) + deltaBeat);
        return { ...n, durationBeat: Math.max(MIN_NOTE_BEATS, end - n.startBeat) };
      });
      writeNotes(next, true);
    }
  }, [drag, notes, pxPerBeat, pitchHeight, toX, toY, toBeat, toPitch, setSelection,
      writeNotes, tempo, snapPitch, scale, rows, drumHalf]);

  const endDrag = useCallback(() => {
    if (drag && (drag.kind === 'move' || drag.kind === 'resize')) commit();
    setDrag(null);
  }, [drag, commit]);

  // ── Lane gestures ───────────────────────────────────────────────────────
  const onLaneDown = useCallback((e: React.MouseEvent) => {
    setDrag({ kind: 'lane', lastX: 0 });
    applyLanePoint(e);
  }, []);

  const applyLanePoint = useCallback((e: React.MouseEvent) => {
    if (!part) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const beat = toBeat(x);

    if (laneMode === 'velocity') {
      const value = Math.max(0, Math.min(1, 1 - y / LANE_HEIGHT));
      const target = notes.filter((n) => Math.abs(toX(n.startBeat) - x) < 5);
      if (target.length === 0) return;
      const targetIds = new Set(target.map((n) => n.id));
      writeNotes(notes.map((n) => (targetIds.has(n.id) ? { ...n, velocity: value } : n)), true);
      return;
    }

    // Controller lane: write a point into every note sounding at that time.
    const bipolar = controllerTarget.kind === 'pitchBend';
    const value = bipolar
      ? Math.max(-1, Math.min(1, (LANE_HEIGHT / 2 - y) / (LANE_HEIGHT / 2 - 4)))
      : Math.max(0, Math.min(1, 1 - y / LANE_HEIGHT));
    const sounding = notesAt(notes, beat);
    if (sounding.length === 0) return;
    const soundingIds = new Set(sounding.map((n) => n.id));
    writeNotes(notes.map((n) => {
      if (!soundingIds.has(n.id)) return n;
      const relative = beat - n.startBeat;
      const existing = findExpression(n, controllerTarget);
      const points = [...(existing?.points ?? [])]
        .filter((p) => Math.abs(p.timeBeat - relative) > 0.01)
        .concat({ timeBeat: Math.max(0, relative), value })
        .sort((a, b) => a.timeBeat - b.timeBeat);
      return setExpression(n, { target: controllerTarget, points });
    }), true);
  }, [part, notes, laneMode, controllerTarget, toBeat, toX, writeNotes]);

  const onLaneMove = useCallback((e: React.MouseEvent) => {
    if (drag?.kind !== 'lane') return;
    applyLanePoint(e);
  }, [drag, applyLanePoint]);

  // ── Readouts ────────────────────────────────────────────────────────────
  const firstSelected = notes.find((n) => selected.has(n.id)) ?? null;
  const chord = useMemo(() => {
    const sounding = part ? notesAt(notes, timelineSecToBeat(clock, playhead)) : [];
    if (sounding.length < 2) return null;
    return detectChord(sounding.map((n) => n.pitch));
  }, [notes, part, playhead]);

  if (!open || !part || !track) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#101018] text-zinc-600 text-sm">
        MIDI 파트를 선택하고 Enter 를 누르면 Key Editor 가 열립니다.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#101018] text-zinc-200">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800 bg-[#15151d] flex-wrap">
        <span className="text-[11px] text-zinc-300 font-medium">Key Editor: {part.name}</span>
        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <label className="text-[10px] text-zinc-600">Grid</label>
        <select
          value={division}
          onChange={(e) => setDivision(Number(e.target.value) as GridDivision)}
          className="h-6 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300"
        >
          {GRID_DIVISIONS.map((d) => <option key={d} value={d}>1/{d}</option>)}
        </select>
        <button onClick={toggleTriplet}
          className={`h-6 px-2 rounded text-[10px] border ${triplet
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>3</button>
        <button onClick={toggleSnap}
          className={`h-6 px-2 rounded text-[10px] border ${snapEnabled
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>SNAP</button>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        {/* The kit.  Choosing one turns the vertical axis from semitones into
            instruments; "드럼 아님" turns it back, and neither touches a note. */}
        <select
          value={drumMap?.id ?? ''}
          onChange={(e) => {
            if (!open) return;
            const id = e.target.value;
            const picked = id === 'gm' && !drumMapsOf(session).some((m) => m.id === 'gm')
              ? GM_DRUM_MAP
              : drumMapsOf(session).find((m) => m.id === id) ?? null;
            apply((s2) => assignDrumMap(s2, open.trackId, picked));
            if (!picked) setShowKitEditor(false);
          }}
          title="이 트랙을 드럼 트랙으로 읽습니다 — 세로축이 음정 대신 악기가 됩니다"
          className="h-6 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300 max-w-[140px]"
        >
          <option value="">드럼 아님</option>
          {!drumMapsOf(session).some((m) => m.id === 'gm') && (
            <option value="gm">{GM_DRUM_MAP.name}</option>
          )}
          {drumMapsOf(session).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {drumMap && (
          <button onClick={() => { setShowKitEditor((v) => !v); setShowLogical(false); setShowList(false); setShowInserts(false); }}
            title="이름 · 출력 노트 · 초크 그룹 · 악기별 그리드"
            className={`h-6 px-2 rounded text-[10px] border ${showKitEditor
              ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>킷</button>
        )}

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        {/* Ghost notes — write a bass line against the chords you can see. */}
        <select
          value={ghost ? `${ghost.trackId}|${ghost.clipId}` : ''}
          onChange={(e) => {
            const value = e.target.value;
            if (!value) { setGhost(null); return; }
            const [trackId, clipId] = value.split('|');
            if (trackId && clipId) setGhost({ trackId, clipId });
          }}
          title="다른 파트를 뒤에 흐리게 겹쳐 봅니다 — 편집은 되지 않습니다"
          className="h-6 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300 max-w-[150px]"
        >
          <option value="">고스트 없음</option>
          {ghostCandidates.map((c) => (
            <option key={`${c.trackId}|${c.clipId}`} value={`${c.trackId}|${c.clipId}`}>{c.label}</option>
          ))}
        </select>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <select
          value={laneMode === 'velocity' ? 'velocity' : JSON.stringify(controllerTarget)}
          onChange={(e) => {
            if (e.target.value === 'velocity') setLaneMode('velocity');
            else setControllerTarget(JSON.parse(e.target.value) as ExpressionTarget);
          }}
          className="h-6 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300"
        >
          <option value="velocity">Velocity</option>
          {CONTROLLER_TARGETS.map((t) => (
            <option key={targetLabel(t)} value={JSON.stringify(t)}>{targetLabel(t)}</option>
          ))}
        </select>

        <button onClick={() => {
            setShowInserts((v) => !v);
            setShowLogical(false); setShowKitEditor(false); setShowList(false);
          }}
          title="건반과 악기 사이의 체인 — 아르페지에이터·코더·스플릿. 파트는 그대로 두고 들리는 것만 바꿉니다"
          className={`h-6 px-2 rounded text-[10px] border ${showInserts
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : track && trackHasInserts(track)
              ? 'bg-zinc-900 border-indigo-700/60 text-indigo-400'
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>INS</button>

        <button onClick={() => { setShowList((v) => !v); setShowLogical(false); setShowKitEditor(false); setShowInserts(false); }}
          title="파트의 모든 이벤트를 숫자로 — 유일하게 값을 읽고 타이핑할 수 있는 곳"
          className={`h-6 px-2 rounded text-[10px] border ${showList
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>LIST</button>

        <button onClick={() => { setShowLogical((v) => !v); setShowKitEditor(false); setShowList(false); setShowInserts(false); }}
          title="규칙으로 고르고 규칙으로 바꿉니다 — 고정된 동사로는 말할 수 없는 편집"
          className={`h-6 px-2 rounded text-[10px] border ${showLogical
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>LOGIC</button>

        <div className="flex-1" />
        <button onClick={() => setPxPerBeat(pxPerBeat / 1.4)}
          className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">−</button>
        <button onClick={() => setPxPerBeat(pxPerBeat * 1.4)}
          className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">+</button>
        <button onClick={() => setPitchHeight(pitchHeight - 2)}
          className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">⇕−</button>
        <button onClick={() => setPitchHeight(pitchHeight + 2)}
          className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">⇕+</button>
        <button onClick={closeEditor}
          className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">닫기</button>
      </div>

      {/* Info line — the selected note's data, like the reference editor */}
      <div className="flex items-center gap-4 px-3 py-1 border-b border-zinc-800 bg-[#12121a] text-[10px] font-mono">
        <Readout label="Start"    value={firstSelected ? `${firstSelected.startBeat.toFixed(3)}박` : '—'} />
        <Readout label="Length"   value={firstSelected ? `${firstSelected.durationBeat.toFixed(3)}박` : '—'} />
        <Readout label="Pitch"    value={firstSelected ? pitchName(firstSelected.pitch) : '—'} />
        <Readout label="Velocity" value={firstSelected ? String(to7bit(firstSelected.velocity)) : '—'} />
        <Readout label="Channel"  value={firstSelected ? String(firstSelected.channel + 1) : '—'} />
        <Readout label="Chord"    value={chord ? formatChord(chord.chord) : '—'} />
        <Readout label="Mouse"    value={hoverInfo ? `${hoverInfo.beat.toFixed(2)}박 ${pitchName(hoverInfo.pitch)}` : '—'} />
        <div className="flex-1" />
        <span className="text-zinc-600">{selectedIds.length} selected · {notes.length} notes</span>
      </div>

      {/* `relative` so the floating panels below position against the CONTENT
          area rather than against something above the toolbar — without it
          they sit on top of the very buttons that open and close them. */}
      <div className="flex-1 flex overflow-hidden relative">
        {showInserts && open && (
          <MidiInsertRack trackId={open.trackId} onClose={() => setShowInserts(false)} />
        )}
        {showList && open && <ListEditor onClose={() => setShowList(false)} />}
        {showLogical && open && <LogicalEditor onClose={() => setShowLogical(false)} />}
        {drumMap && showKitEditor && open && (
          <DrumMapEditor map={drumMap} trackId={open.trackId} clipId={open.clipId}
                         onClose={() => setShowKitEditor(false)} />
        )}
        <KeyEditorInspector />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Ruler */}
          <div className="flex border-b border-zinc-800 bg-[#12121a]" style={{ height: RULER_HEIGHT }}>
            <div style={{ width: KEYBOARD_WIDTH }} className="shrink-0 border-r border-zinc-800" />
            <div className="relative flex-1 overflow-hidden">
              {/* One label per whole beat, reading bar|beat off the tempo map —
                  which the roll can now do directly, because its axis IS beats. */}
              {Array.from({ length: Math.ceil(size.width / pxPerBeat) + 1 }, (_, i) => {
                const t = Math.floor(scrollBeat) + i;
                const { bar, beat } = barBeatAt(tempoMap, clock.startBeat + t);
                const barStart = beat === 1;
                return (
                  <span key={t}
                        className={`absolute top-1 text-[9px] font-mono ${barStart ? 'text-zinc-400' : 'text-zinc-600'}`}
                        style={{ left: toX(t) + 2 }}>
                    {barStart ? bar : `${bar}.${beat}`}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Piano keys — or, on a drum track, the kit's row headers.
                A drum part edited against a keyboard is a wall of numbers;
                this is the whole reason a drum map exists. */}
            <div style={{ width: rows ? DRUM_HEADER_WIDTH : KEYBOARD_WIDTH }}
                 className="shrink-0 relative border-r border-zinc-800 bg-[#0e0e15] overflow-hidden">
              {rows ? rows.map((slot, i) => (
                <div
                  key={slot.pitch}
                  onMouseDown={() => setSelection(
                    notes.filter((n) => n.pitch === slot.pitch).map((n) => n.id))}
                  title={`${describeSlot(slot)} — 눌러서 이 악기의 모든 히트를 선택`}
                  className="absolute left-0 right-0 border-b border-black/40 flex items-center
                             gap-1 pl-1 pr-1 cursor-pointer hover:bg-white/5"
                  style={{
                    top: toY(slot.pitch), height: pitchHeight,
                    background: i % 2 === 1 ? 'rgba(255,255,255,0.03)' : 'transparent',
                  }}
                >
                  <span className="text-[8px] font-mono shrink-0"
                        style={{ color: slot.muted ? '#8a5050' : '#5f6070' }}>{slot.pitch}</span>
                  <span className="text-[9px] truncate"
                        style={{
                          color: slot.muted ? '#8a5050' : '#c9ccd8',
                          textDecoration: slot.muted ? 'line-through' : 'none',
                        }}>{slot.name}</span>
                </div>
              )) : Array.from({ length: Math.ceil(size.height / pitchHeight) + 1 }, (_, i) => {
                const pitch = bottomPitch + i;
                const black = isBlackKey(pitch);
                return (
                  <div
                    key={pitch}
                    onMouseDown={() => {
                      // Auditioning by clicking a key writes a short note only
                      // when the pencil is active; otherwise it just scrolls
                      // the selection focus.
                      setSelection([]);
                    }}
                    className={`absolute left-0 right-0 border-b border-black/40 flex items-center justify-end pr-1
                                ${black ? 'bg-zinc-900' : 'bg-zinc-300'}`}
                    style={{ top: toY(pitch), height: pitchHeight }}
                  >
                    {pitch % 12 === 0 && (
                      <span className={`text-[8px] font-mono ${black ? 'text-zinc-500' : 'text-zinc-700'}`}>
                        {pitchName(pitch)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Note grid */}
            <div
              ref={areaRef}
              className="flex-1 relative overflow-hidden cursor-crosshair"
              onMouseDown={onGridDown}
              onMouseMove={onGridMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
              onDoubleClick={(e) => {
                const { x } = localPoint(e);
                if (part) seek(part.startSec + toBeat(x));
              }}
            >
              <canvas ref={canvasRef} className="block" />
            </div>
          </div>

          {/* Controller / velocity lane */}
          <div className="flex border-t border-zinc-800" style={{ height: LANE_HEIGHT }}>
            <div style={{ width: KEYBOARD_WIDTH }}
                 className="shrink-0 border-r border-zinc-800 bg-[#12121a] flex items-start justify-center pt-1">
              <span className="text-[9px] text-zinc-500">
                {laneMode === 'velocity' ? 'Velocity' : targetLabel(controllerTarget)}
              </span>
            </div>
            <div
              className="flex-1 relative cursor-ns-resize"
              onMouseDown={onLaneDown}
              onMouseMove={onLaneMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              <canvas ref={laneRef} className="block" />
            </div>
          </div>

          {/* Scroll */}
          <div className="flex items-center gap-2 px-3 py-1 border-t border-zinc-800 bg-[#12121a]">
            <span className="text-[10px] font-mono text-zinc-600">시간</span>
            <input type="range" min={0} max={Math.max(1, part.durationSec)} step={0.01}
              value={Math.min(scrollBeat, part.durationSec)}
              onChange={(e) => setScrollBeat(parseFloat(e.target.value))}
              className="flex-1 accent-indigo-500" />
            <span className="text-[10px] font-mono text-zinc-600">음역</span>
            <input type="range" min={0} max={108} step={1} value={bottomPitch}
              onChange={(e) => setBottomPitch(parseInt(e.target.value, 10))}
              className="w-32 accent-indigo-500" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-zinc-600">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </span>
  );
}
