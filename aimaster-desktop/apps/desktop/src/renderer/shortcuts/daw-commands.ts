// DAW command implementations for the keyboard layer.
//
// Two exports:
//   • buildDawCommands   — the DAW-only verbs (separate, heal, comp, bounce…)
//   • buildDawOverrides  — existing shortcuts that must mean something
//                          different while the DAW workspace is on screen
//                          (Space plays the session, not the master preview;
//                          Mod+Z undoes an edit, not a slider move).
//
// Both take the same deps as the mastering commands plus a live accessor for
// the DAW store, so the selftest can drive them against the real store with
// fake IPC.

import type { DawState } from '../stores/dawStore.js';
import { snapToGrid, targetTrackIds } from '../stores/dawStore.js';
import {
  clearRange, crossfadeAt, duplicateSelection, fadeToCursor, healSeparation,
  nudgeClipGain, nudgeSelection, selectionLength, separateAt, trimToSelection, hasRange,
  type TimeSelection,
} from '../daw/edit/clip-edit.js';
import { compRange, cyclePlaylist } from '../daw/edit/comping.js';
import { editPoints, tabBackward, tabForward } from '../daw/edit/navigation.js';
import {
  addTrack, createTrack, findTrack, sessionEndSec,
} from '../daw/model/session-ops.js';
import { clearAllMute, clearAllSolo, toggleMute, toggleSolo } from '../daw/model/mixer-math.js';
import { createSession } from '../daw/model/session-ops.js';
import {
  deserializeDawSession, importSessionData, serializeDawSession,
} from '../daw/model/session-io.js';
import { isEmptyPlan, planDrop } from '../daw/model/drop-target.js';
import { describeImport, importIntoSession } from '../daw/edit/session-import.js';
import {
  bounceSession, commitTrack, consolidateSelection, freezeTrack, renderSession, sessionRange, unfreezeTrack,
} from '../daw/engine/offline-render.js';
import { useReferenceStore } from '../stores/referenceStore.js';
import {
  autoWarpClip, setWarpEnabled, unwarpClip, warpClipToTempo,
} from '../daw/edit/warp-actions.js';
import { clipWarp } from '../daw/model/warp.js';
import { declickClip } from '../daw/edit/restore-actions.js';
import { useRecordingStore } from '../stores/recordingStore.js';
import { canRecord } from '../daw/model/recording.js';
import {
  addSection, createSection, nextSectionStart, previousSectionStart, rangeOf, sectionAt,
  sectionLabel, sectionsOf, withSections,
} from '../daw/model/arrangement.js';
import {
  describeOrder, nudgeSection, selectionForSection, songEnd,
} from '../daw/edit/arrange-ops.js';
import { applySlides, arpeggiate, strum } from '../daw/edit/note-tools.js';
import { captureAsPattern } from '../daw/model/patterns.js';
import { useIntelStore } from '../stores/intelStore.js';
import { summarise as summariseFindings } from '../daw/ai/diagnose.js';
import { transientsFor } from '../daw/engine/audio-cache.js';
import { useMidiEditorStore, currentGridBeat } from '../stores/midiEditorStore.js';
import { updateClip, trackClips, updateTrack } from '../daw/model/session-ops.js';
import { findLane } from '../daw/model/automation.js';
import {
  addTempoEvent, barBeatAt, beatsPerBar, meterAtBeat, secToBeat, tempoAtBeat,
  tempoMapOf, updateTempoEvent,
  withTempoMap,
} from '../daw/model/tempo-map.js';
import {
  availableTargets, ensureLane, setLaneVisible, visibleLanes,
} from '../daw/edit/automation-lanes.js';
import type { AutomationMode, Clip, DawSession } from '../daw/model/types.js';
import {
  quantizeNotes, humanizeNotes, transposeNotes, nudgeVelocity, applyLegato,
} from '../daw/edit/midi-edit.js';
import { noteEndBeat, type MidiNote } from '../daw/model/midi.js';
import { detectChordTrack } from '../daw/edit/chord-detect.js';
import { beatsToSecAt, partClock, secToBeatsAt, type PartClock } from '../daw/model/note-time.js';
import { describePlan, exportStems, planStems } from '../daw/engine/stem-export.js';
import { setChordTrack } from '../daw/model/session-ops.js';
import { reharmonize, formatProgression, makeChord } from '../daw/model/chords.js';
import { addChord, sortedChords, withChords } from '../daw/edit/chord-edit.js';
import { useVocalEditorStore } from '../stores/vocalEditorStore.js';
import { useVideoStore } from '../stores/videoStore.js';
import {
  copyRange, cutRange, describeClipboard, insertSilence, isEmptyClipboard, pasteAt,
  type PasteMode,
} from '../daw/edit/clipboard.js';
import { snapDistanceMs, snapSecToZero } from '../daw/edit/zero-cross.js';
import { describeStrip, findSoundRegions, stripClipSilence } from '../daw/edit/strip-silence.js';
import { getCached, monoSum } from '../daw/engine/audio-cache.js';
import {
  applyNormalize, cleanClipName, describeNormalize, measureClip, normalizePlan,
  renameClip, renameSelection, selectedAudioClips,
} from '../daw/edit/clip-dsp.js';
import { reverseClip } from '../daw/edit/clip-dsp-actions.js';
import {
  cleanTrackName, describeHeight, renameTrack, setHeights, stepTrackHeight,
} from '../daw/model/track-header.js';
import { frameSec, videoOf } from '../daw/model/video.js';
import {
  analyzeClipPitch, applyCorrection, guideNotesFor, renderClipPitch, tuningSummary,
} from '../daw/audio/varia-actions.js';
import { clipEnd } from '../daw/model/session-ops.js';
import { createStack, unpackStack, toggleCollapsed, stackAncestors } from '../daw/model/stacks.js';
import { dawRuntime as runtime } from '../daw/engine/daw-runtime.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import type { CommandFn, NotifyType } from './commands.js';
import type { CommandId } from './definitions.js';

export type DawCommandId =
  | 'daw.open' | 'daw.toggleWindow'
  | 'daw.tabNext' | 'daw.tabPrev' | 'daw.toggleTabToTransient'
  | 'daw.separate' | 'daw.heal' | 'daw.trimToSelection' | 'daw.consolidate' | 'daw.clearRange'
  | 'daw.clipGainUp' | 'daw.clipGainDown'
  | 'daw.nudgeForward' | 'daw.nudgeBack'
  | 'daw.fadeIn' | 'daw.fadeOut' | 'daw.crossfade'
  | 'daw.newTrack' | 'daw.playlistNext' | 'daw.playlistPrev' | 'daw.compSelection'
  | 'daw.freeze' | 'daw.commit' | 'daw.bounce' | 'daw.exportStems'
  | 'daw.importAudio' | 'daw.importSession'
  | 'daw.zoomIn' | 'daw.zoomOut'
  | 'daw.quantize' | 'daw.humanize' | 'daw.selectAllNotes' | 'daw.legatoNotes'
  | 'daw.transposeUp' | 'daw.transposeDown'
  | 'daw.octaveUp' | 'daw.octaveDown'
  | 'daw.velocityUp' | 'daw.velocityDown'
  | 'daw.detectChords' | 'daw.reharmonize'
  | 'daw.analyzeVocal' | 'daw.tuneVocal'
  | 'daw.smartControls' | 'daw.createStack' | 'daw.unpackStack' | 'daw.toggleStack'
  | 'daw.toggleAutomation' | 'daw.automationMode'
  | 'daw.tempoChange' | 'daw.tempoRamp'
  | 'daw.sectionNext' | 'daw.sectionPrev' | 'daw.sectionSelect' | 'daw.sectionAdd'
  | 'daw.sectionMoveBack' | 'daw.sectionMoveForward'
  | 'daw.showChain' | 'daw.showSession' | 'daw.launchScene' | 'daw.stopAllClips'
  | 'daw.showSpectral' | 'daw.showReference' | 'daw.analyzeMix'
  | 'daw.showWarp' | 'daw.autoWarp' | 'daw.toggleWarp'
  | 'daw.showRestore' | 'daw.declick'
  | 'daw.toggleArm' | 'daw.record' | 'daw.punchFromSelection'
  | 'daw.showSteps' | 'daw.arpeggiate' | 'daw.strum' | 'daw.slide' | 'daw.capturePattern'
  | 'daw.showIntel' | 'daw.analyzeMixAi' | 'daw.aiCommand'
  | 'daw.tuneToGuide' | 'daw.riff'
  | 'daw.addChord' | 'daw.openVocalEditor'
  | 'daw.togglePicture' | 'daw.nudgeFrameBack' | 'daw.nudgeFrameForward'
  | 'daw.copy' | 'daw.cut' | 'daw.cutRipple' | 'daw.paste' | 'daw.pasteInsert'
  | 'daw.insertSilence' | 'daw.stripSilence' | 'daw.snapZeroCross'
  | 'daw.normalizeClip' | 'daw.reverseClip' | 'daw.renameClip'
  | 'daw.renameTrack' | 'daw.trackHeightUp' | 'daw.trackHeightDown';

export interface DawCommandDeps {
  notify: (message: string, type?: NotifyType) => void;
  /** Bring the DAW workspace on screen. */
  openWorkspace: () => void;
  daw: () => DawState;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Transients per file — injectable so the selftest can supply its own. */
  transients?: (fileId: string) => readonly number[];
}

const CLIP_GAIN_STEP_DB = 0.5;

function currentSelection(daw: DawState): TimeSelection {
  const sel = daw.selection;
  if (sel.trackIds.length > 0) return sel;
  return { ...sel, trackIds: targetTrackIds() };
}

/** Selection if there is one, else a zero-length range at the play head. */
function selectionOrPlayhead(daw: DawState): TimeSelection {
  const sel = currentSelection(daw);
  if (hasRange(sel)) return sel;
  return { startSec: daw.playheadSec, endSec: daw.playheadSec, trackIds: targetTrackIds() };
}

export function buildDawCommands(deps: DawCommandDeps): Record<DawCommandId, CommandFn> {
  const { notify, daw, invoke, openWorkspace } = deps;
  const marks = deps.transients ?? transientsFor;

  // ── Key Editor helpers ──────────────────────────────────────────────────

  /** The part the Key Editor has open, plus the notes it should act on. */
  const midiContext = (): {
    trackId: string; clipId: string; notes: MidiNote[]; ids: Set<string>;
    /** The open part's time frame — every beat↔second conversion goes here. */
    clock: PartClock;
  } | null => {
    const editor = useMidiEditorStore.getState();
    const open = editor.open;
    if (!open) { notify('Key Editor 에서 MIDI 파트를 먼저 여세요', 'warning'); return null; }
    const track = findTrack(daw().session, open.trackId);
    const part = track ? trackClips(track).find((c) => c.id === open.clipId) : undefined;
    if (!part) { notify('열린 MIDI 파트를 찾을 수 없습니다', 'warning'); return null; }
    const selected = editor.selectedNoteIds;
    const ids = new Set(selected.length > 0 ? selected : part.notes.map((n) => n.id));
    const clock = partClock(tempoMapOf(daw().session), part.startSec);
    return { trackId: open.trackId, clipId: open.clipId, notes: part.notes, ids, clock };
  };

  /** Write notes back, keeping the part long enough to contain them. */
  const writeNotes = (trackId: string, clipId: string, notes: MidiNote[]): void => {
    daw().apply((s) => updateClip(s, trackId, clipId, (c) => {
      // The part's box is in seconds and its notes are in beats, so "long
      // enough" is a measurement against the tempo map, not an addition.
      const clock = partClock(tempoMapOf(s), c.startSec);
      const lastBeat = notes.reduce((m, n) => Math.max(m, noteEndBeat(n)), 0);
      return {
        ...c,
        notes,
        durationSec: Math.max(c.durationSec, beatsToSecAt(clock, lastBeat)),
      };
    }));
  };

  /**
   * Reorder the section under the playhead, and follow it.
   *
   * Where it landed is read back as the whole running order: a reorder is
   * invisible until the playhead gets there.
   */
  const moveSectionUnderPlayhead = (direction: -1 | 1): void => {
    const state = daw();
    const here = sectionAt(sectionsOf(state.session), state.playheadSec);
    if (!here) { notify('재생헤드에 구간이 없습니다', 'warning'); return; }
    // Where the playhead sits INSIDE the section, so it can be put back there.
    const before = rangeOf(sectionsOf(state.session), here.id, songEnd(state.session));
    const offset = before ? state.playheadSec - before.startSec : 0;

    let problems: string[] = [];
    let landedAt: number | null = null;
    let order = '';
    state.apply((s) => {
      const result = nudgeSection(s, here.id, direction);
      problems = result.problems;
      order = describeOrder(result.session);
      const after = rangeOf(sectionsOf(result.session), here.id, songEnd(result.session));
      landedAt = after ? after.startSec : null;
      return result.session;
    });
    if (problems.length > 0) { notify(problems[0]!, 'warning'); return; }
    if (landedAt !== null) state.seek(landedAt + offset);
    notify(order, 'success');
  };

  const transposeBy = (semitones: number): void => {
    const context = midiContext();
    if (!context) return;
    const editor = useMidiEditorStore.getState();
    writeNotes(context.trackId, context.clipId, transposeNotes(context.notes, context.ids, {
      semitones,
      scale: editor.scaleCorrection ? editor.scale : null,
    }));
    notify(`${semitones > 0 ? '+' : ''}${semitones} 반음`);
  };

  const needSelection = (): TimeSelection | null => {
    const sel = currentSelection(daw());
    if (!hasRange(sel)) { notify('편집할 구간을 먼저 선택하세요', 'warning'); return null; }
    return sel;
  };

  const tab = (direction: 1 | -1): void => {
    const state = daw();
    const tracks = targetTrackIds();
    const scope = tracks.length > 0
      ? tracks
      : state.session.tracks.filter((t) => t.kind === 'audio').map((t) => t.id);
    const points = editPoints(state.session, scope, state.tabToTransient, marks);
    const result = direction === 1
      ? tabForward(points, state.playheadSec, sessionEndSec(state.session))
      : tabBackward(points, state.playheadSec);
    state.seek(result.timeSec);
    // Tabbing with a range selected extends it, like the real thing.
    if (hasRange(state.selection)) {
      state.setSelection(direction === 1
        ? { ...state.selection, endSec: result.timeSec }
        : { ...state.selection, startSec: result.timeSec });
    }
  };

  return {
    'daw.open': () => { openWorkspace(); },

    'daw.toggleWindow': () => {
      daw().toggleWindow();
      notify(`${daw().window === 'edit' ? 'Edit' : 'Mix'} 윈도우`);
    },

    'daw.tabNext': () => tab(1),
    'daw.tabPrev': () => tab(-1),

    'daw.toggleTabToTransient': () => {
      daw().toggleTabToTransient();
      notify(`Tab to Transient ${daw().tabToTransient ? 'ON' : 'OFF'}`);
    },

    'daw.separate': () => {
      const state = daw();
      const tracks = targetTrackIds();
      if (tracks.length === 0) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      const at = snapToGrid(state.playheadSec);
      state.apply((s) => separateAt(s, tracks, at));
      notify('클립을 분리했습니다');
    },

    'daw.heal': () => {
      const sel = needSelection();
      if (!sel) return;
      daw().apply((s) => healSeparation(s, sel));
      notify('분리를 복구했습니다');
    },

    'daw.trimToSelection': () => {
      const sel = needSelection();
      if (!sel) return;
      daw().apply((s) => trimToSelection(s, sel));
      notify('선택 구간으로 트림했습니다');
    },

    'daw.clearRange': () => {
      const sel = needSelection();
      if (!sel) return;
      const ripple = daw().editMode === 'shuffle';
      daw().apply((s) => clearRange(s, sel, ripple));
      notify(ripple ? '구간 삭제 (뒤 클립 당김)' : '구간 삭제');
    },

    'daw.consolidate': async () => {
      const sel = needSelection();
      if (!sel) return;
      const trackId = sel.trackIds[0];
      if (!trackId) return;
      notify('컨솔리데이트 렌더링 중…');
      try {
        const next = await consolidateSelection(daw().session, trackId, sel);
        daw().apply(() => next);
        notify('컨솔리데이트 완료', 'success');
      } catch (err) {
        notify(`컨솔리데이트 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.clipGainUp':   () => {
      const sel = selectionOrPlayhead(daw());
      const range = hasRange(sel) ? sel : clipRangeAtPlayhead(daw());
      if (!range) { notify('클립 위에 커서를 두세요', 'warning'); return; }
      daw().apply((s) => nudgeClipGain(s, range, CLIP_GAIN_STEP_DB));
      notify(`클립 게인 +${CLIP_GAIN_STEP_DB} dB`);
    },

    'daw.clipGainDown': () => {
      const sel = selectionOrPlayhead(daw());
      const range = hasRange(sel) ? sel : clipRangeAtPlayhead(daw());
      if (!range) { notify('클립 위에 커서를 두세요', 'warning'); return; }
      daw().apply((s) => nudgeClipGain(s, range, -CLIP_GAIN_STEP_DB));
      notify(`클립 게인 −${CLIP_GAIN_STEP_DB} dB`);
    },

    'daw.nudgeForward': () => {
      const sel = needSelection();
      if (!sel) return;
      const delta = daw().nudgeSec;
      daw().apply((s) => nudgeSelection(s, sel, delta));
      notify(`+${delta}s 넛지`);
    },

    'daw.nudgeBack': () => {
      const sel = needSelection();
      if (!sel) return;
      const delta = daw().nudgeSec;
      daw().apply((s) => nudgeSelection(s, sel, -delta));
      notify(`−${delta}s 넛지`);
    },

    'daw.fadeIn': () => {
      const state = daw();
      const tracks = targetTrackIds();
      state.apply((s) => fadeToCursor(s, tracks, state.playheadSec, 'in'));
      notify('커서까지 페이드 인');
    },

    'daw.fadeOut': () => {
      const state = daw();
      const tracks = targetTrackIds();
      state.apply((s) => fadeToCursor(s, tracks, state.playheadSec, 'out'));
      notify('커서부터 페이드 아웃');
    },

    'daw.crossfade': () => {
      const state = daw();
      const sel = currentSelection(state);
      const length = hasRange(sel) ? sel.endSec - sel.startSec : 0.02;
      const at = hasRange(sel) ? (sel.startSec + sel.endSec) / 2 : state.playheadSec;
      state.apply((s) => crossfadeAt(s, targetTrackIds(), at, length));
      notify(`크로스페이드 ${(length * 1000).toFixed(0)} ms`);
    },

    'daw.newTrack': () => {
      daw().apply((s) => addTrack(s, createTrack(`Audio ${s.tracks.length}`, 'audio')));
      notify('트랙을 추가했습니다');
    },

    'daw.playlistNext': () => cyclePlaylistOn(daw(), 1, notify),
    'daw.playlistPrev': () => cyclePlaylistOn(daw(), -1, notify),

    'daw.compSelection': () => {
      const state = daw();
      const sel = needSelection();
      if (!sel) return;
      const trackId = sel.trackIds[0];
      const track = trackId ? findTrack(state.session, trackId) : undefined;
      if (!track) return;
      // Comp from the lane just below the active one — the usual workflow is
      // stepping through alternates and grabbing the good bits.
      const index = track.playlists.findIndex((p) => p.id === track.activePlaylistId);
      const source = track.playlists[(index + 1) % track.playlists.length];
      if (!source || source.id === track.activePlaylistId) {
        notify('가져올 다른 테이크가 없습니다', 'warning');
        return;
      }
      state.apply((s) => compRange(s, track.id, source.id, sel));
      notify(`${source.name} 구간을 메인에 반영했습니다`, 'success');
    },

    'daw.freeze': async () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      if (!trackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      const track = findTrack(state.session, trackId);
      if (!track) return;
      if (track.frozen) {
        state.apply((s) => unfreezeTrack(s, trackId));
        notify('프리즈 해제');
        return;
      }
      notify('프리즈 렌더링 중…');
      try {
        const result = await freezeTrack(state.session, trackId);
        state.apply(() => result.session);
        notify(`${track.name} 프리즈 완료`, 'success');
      } catch (err) {
        notify(`프리즈 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.commit': async () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      if (!trackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      notify('커밋 렌더링 중…');
      try {
        const next = await commitTrack(state.session, trackId);
        state.apply(() => next);
        notify('커밋 완료', 'success');
      } catch (err) {
        notify(`커밋 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.bounce': async () => {
      const state = daw();
      if (sessionEndSec(state.session) <= 0) { notify('바운스할 오디오가 없습니다', 'warning'); return; }
      const sel = state.selection;
      notify('바운스 렌더링 중…');
      try {
        const range = sel.endSec > sel.startSec
          ? { startSec: sel.startSec, endSec: sel.endSec }
          : undefined;
        const dest = await bounceSession(state.session, range);
        notify(dest ? '바운스 완료' : '바운스를 취소했습니다', dest ? 'success' : 'info');
      } catch (err) {
        notify(`바운스 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.exportStems': async () => {
      const state = daw();
      const plan = planStems(state.session);
      if (plan.items.length === 0) {
        notify('내보낼 스템이 없습니다 — 들리는 오디오 트랙이 없습니다', 'warning');
        return;
      }
      notify(`${describePlan(plan)} — 폴더를 선택하세요`);
      try {
        const result = await exportStems(state.session, {}, (p) => {
          notify(`스템 ${p.index}/${p.total} — ${p.trackName}`);
        });
        if (!result.directory) { notify('스템 내보내기를 취소했습니다', 'info'); return; }
        for (const w of result.warnings) notify(w, 'warning');
        for (const s of result.skipped) notify(`${s.trackName} 제외 — ${s.reason}`, 'info');
        notify(`스템 ${result.written.length}개 저장`, 'success');
      } catch (err) {
        notify(`스템 내보내기 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.importAudio': () => importAtPlayhead(deps),

    'daw.importSession': async () => {
      const loaded = await invoke('session:load') as { path: string; data: string } | null;
      if (!loaded) return;
      const parsed = deserializeDawSession(loaded.data);
      if (!parsed.ok) { notify(parsed.error, 'error'); return; }
      const result = importSessionData(daw().session, parsed.session, {
        includeAlternatePlaylists: true, includeAutomation: true,
      });
      daw().apply(() => result.session);
      notify(`${result.importedTrackIds.length}개 트랙을 가져왔습니다`, 'success');
    },

    'daw.zoomIn':  () => { daw().setPxPerSec(daw().pxPerSec * 1.5); },
    'daw.zoomOut': () => { daw().setPxPerSec(daw().pxPerSec / 1.5); },

    // ── Key Editor ────────────────────────────────────────────────────────
    'daw.quantize': () => {
      const context = midiContext();
      if (!context) return;
      const editor = useMidiEditorStore.getState();
      const gridBeat = currentGridBeat();
      writeNotes(context.trackId, context.clipId,
        quantizeNotes(context.notes, context.ids, { ...editor.quantize, gridBeat }));
      notify(`퀀타이즈 (강도 ${editor.quantize.strengthPercent ?? 100}%)`);
    },

    'daw.humanize': () => {
      const context = midiContext();
      if (!context) return;
      const editor = useMidiEditorStore.getState();
      writeNotes(context.trackId, context.clipId, humanizeNotes(context.notes, context.ids, {
        // Humanize is a millisecond feel, so it crosses into beats here.
        timingBeat: secToBeatsAt(context.clock, editor.humanizeTimingMs / 1000),
        velocity: editor.humanizeVelocity,
        gridBeat: currentGridBeat(),
        seed: editor.humanizeSeed,
      }));
      notify('휴머나이즈 (시드 고정)');
    },

    'daw.selectAllNotes': () => {
      const context = midiContext();
      if (!context) return;
      useMidiEditorStore.getState().setSelection(context.notes.map((n) => n.id));
      notify(`${context.notes.length}개 노트 선택`);
    },

    'daw.legatoNotes': () => {
      const context = midiContext();
      if (!context) return;
      const editor = useMidiEditorStore.getState();
      writeNotes(context.trackId, context.clipId,
        applyLegato(context.notes, context.ids, editor.overlapMs / 1000));
      notify('레가토');
    },

    'daw.transposeUp':   () => transposeBy(1),
    'daw.transposeDown': () => transposeBy(-1),
    'daw.octaveUp':      () => transposeBy(12),
    'daw.octaveDown':    () => transposeBy(-12),

    'daw.velocityUp': () => {
      const context = midiContext();
      if (!context) return;
      writeNotes(context.trackId, context.clipId, nudgeVelocity(context.notes, context.ids, 5 / 127));
      notify('벨로시티 +5');
    },
    'daw.velocityDown': () => {
      const context = midiContext();
      if (!context) return;
      writeNotes(context.trackId, context.clipId, nudgeVelocity(context.notes, context.ids, -5 / 127));
      notify('벨로시티 −5');
    },

    // ── Clipboard ─────────────────────────────────────────────────────────
    // Copy and cut read the time selection; paste lands at the PLAYHEAD, on
    // the tracks the selection names (or the focused one).  That split is what
    // makes "copy this bar, move there, paste" work without a second gesture
    // to say where.

    'daw.copy': () => {
      const state = daw();
      const board = copyRange(state.session, state.selection);
      if (!board) { notify('구간을 먼저 선택하세요 (2번 툴)', 'warning'); return; }
      state.setClipboard(board);
      notify(`복사했습니다 — ${describeClipboard(board)}`);
    },

    'daw.cut': () => cutInto(daw(), false, notify),
    'daw.cutRipple': () => cutInto(daw(), true, notify),

    'daw.paste': () => pasteInto(daw(), 'overwrite', notify),
    'daw.pasteInsert': () => pasteInto(daw(), 'insert', notify),

    /**
     * Open a gap as long as the selection.
     *
     * The selection is the LENGTH, not the place — the gap opens at the
     * playhead.  Asking for a length in a dialog when the user has just drawn
     * one on the timeline would be asking twice.
     */
    'daw.insertSilence': () => {
      const state = daw();
      const length = selectionLength(state.selection);
      if (length <= 0) { notify('넣을 길이만큼 구간을 선택하세요', 'warning'); return; }
      const tracks = state.selection.trackIds.length > 0
        ? state.selection.trackIds : targetTrackIds();
      if (tracks.length === 0) { notify('트랙을 먼저 고르세요', 'warning'); return; }
      state.apply((s) => insertSilence(s, tracks, state.playheadSec, length));
      notify(`${length.toFixed(1)}초를 넣었습니다 — 뒤의 모든 것이 밀렸습니다`);
    },

    /**
     * Move the selection's edges to the nearest zero crossing.
     *
     * Needs the decoded audio, so it refuses when the file has not been read
     * yet rather than silently doing nothing — "I pressed it and the edit
     * still clicks" is the worst outcome for a command whose whole job is
     * invisible.
     */
    'daw.snapZeroCross': () => {
      const state = daw();
      const sel = state.selection;
      if (sel.endSec - sel.startSec <= 0) { notify('구간을 먼저 선택하세요', 'warning'); return; }
      const source = firstAudioUnder(state, sel);
      if (!source) { notify('구간 안에 오디오 클립이 없습니다', 'warning'); return; }
      const cached = getCached(source.clip.fileId);
      if (!cached) { notify('오디오가 아직 읽히지 않았습니다 — 잠시 후 다시 시도하세요', 'warning'); return; }

      const mono = monoSum(cached.buffer);
      const rate = cached.buffer.sampleRate;
      // Selection time → file time, snap there, and back again.
      const toFile = (t: number): number => t - source.clip.startSec + source.clip.offsetSec;
      const fromFile = (t: number): number => t + source.clip.startSec - source.clip.offsetSec;
      const startSec = fromFile(snapSecToZero(mono, toFile(sel.startSec), rate));
      const endSec = fromFile(snapSecToZero(mono, toFile(sel.endSec), rate));
      if (endSec - startSec <= 0) { notify('영교차를 찾지 못했습니다', 'warning'); return; }

      state.setSelection({ ...sel, startSec, endSec });
      const moved = Math.abs(snapDistanceMs(sel.startSec, startSec))
        + Math.abs(snapDistanceMs(sel.endSec, endSec));
      notify(moved < 0.001
        ? '이미 영교차에 있습니다'
        : `영교차로 옮겼습니다 — 합계 ${moved.toFixed(2)} ms`);
    },

    /**
     * Cut the silence out of the clip under the playhead.
     *
     * One clip, not the whole track: stripping is a decision about a take, and
     * a threshold that suits the vocal will shred the drum overheads.
     */
    'daw.stripSilence': () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip) return;
      const cached = getCached(clip.fileId);
      if (!cached) { notify('오디오가 아직 읽히지 않았습니다', 'warning'); return; }

      const mono = monoSum(cached.buffer);
      const rate = cached.buffer.sampleRate;
      // The analysis runs over the clip's own span of the file, so trimming a
      // take does not drag the neighbouring phrase into the decision.
      const from = Math.max(0, Math.round(clip.offsetSec * rate));
      const to = Math.min(mono.length, Math.round((clip.offsetSec + clip.durationSec) * rate));
      const regions = findSoundRegions(mono.subarray(from, to), rate);
      if (regions.length === 0) {
        notify('자를 무음을 찾지 못했습니다 — 임계값을 올려 보세요', 'warning');
        return;
      }

      let summary = '';
      state.apply((s: DawSession) => {
        const result = stripClipSilence(s, target.trackId, target.clipId, regions);
        summary = describeStrip(result);
        return result.session;
      });
      notify(summary, 'success');
    },

    // ── Track header ──────────────────────────────────────────────────────

    'daw.renameTrack': () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      if (!trackId) { notify('트랙을 먼저 고르세요', 'warning'); return; }
      const track = findTrack(state.session, trackId);
      const typed = globalThis.prompt?.('트랙 이름', track?.name ?? '');
      if (typed === null || typed === undefined) return;
      if (cleanTrackName(typed).length === 0) { notify('이름은 비울 수 없습니다', 'warning'); return; }
      state.apply((s: DawSession) => renameTrack(s, trackId, typed));
      notify(`${cleanTrackName(typed)}`);
    },

    /**
     * Step every selected track's height.
     *
     * Stepping rather than adding pixels: "make this big enough to edit in" is
     * a repeated action, and hunting for the same pixel height by hand every
     * time is not editing.
     */
    'daw.trackHeightUp': () => stepHeights(daw(), 1, notify),
    'daw.trackHeightDown': () => stepHeights(daw(), -1, notify),

    // ── Clip processing ───────────────────────────────────────────────────

    /**
     * Normalize the clip under the playhead to −1 dBTP.
     *
     * Sets CLIP GAIN rather than rendering: instant, one undo step, no disk,
     * and pressing it twice does the same thing as pressing it once.  A baked
     * render could not have that last property.
     */
    'daw.normalizeClip': () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip) return;
      const cached = getCached(clip.fileId);
      if (!cached) { notify('오디오가 아직 읽히지 않았습니다', 'warning'); return; }

      const measure = measureClip(cached.buffer, clip);
      const plan = normalizePlan(measure);
      if (plan.refused) { notify(plan.refused, 'warning'); return; }
      state.apply((s: DawSession) => applyNormalize(s, target.trackId, target.clipId, plan));
      notify(describeNormalize(measure, plan), plan.clamped ? 'warning' : 'success');
    },

    /**
     * Reverse the clip under the playhead.
     *
     * The one clip operation that has to make new audio — the original file is
     * never touched, so undo restores the take exactly.
     */
    'daw.reverseClip': async () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      notify('뒤집는 중…');
      try {
        const result = await reverseClip(state.session, target.trackId, target.clipId);
        if (result.error) { notify(result.error, 'error'); return; }
        state.apply(() => result.session);
        notify('클립을 뒤집었습니다 — 페이드도 반대쪽으로 옮겼습니다', 'success');
      } catch (err) {
        notify(`뒤집지 못했습니다: ${(err as Error).message}`, 'error');
      }
    },

    /** Rename the clip under the playhead, or every clip in the selection. */
    'daw.renameClip': () => {
      const state = daw();
      const sel = state.selection;
      const many = hasRange(sel) && selectedAudioClips(state.session, sel).length > 1;
      const target = many ? null : audioClipAtPlayhead(state);
      if (!many && !target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }

      const current = target
        ? findClip(state.session, target.trackId, target.clipId)?.name ?? ''
        : '';
      const typed = globalThis.prompt?.(many ? '선택한 클립들의 이름 (뒤에 번호가 붙습니다)' : '클립 이름', current);
      if (typed === null || typed === undefined) return;
      if (cleanClipName(typed).length === 0) { notify('이름은 비울 수 없습니다', 'warning'); return; }

      if (many) {
        state.apply((s: DawSession) => renameSelection(s, sel, typed));
        notify(`${selectedAudioClips(state.session, sel).length}개 클립의 이름을 바꿨습니다`);
      } else {
        state.apply((s: DawSession) => renameClip(s, target!.trackId, target!.clipId, typed));
        notify(`이름을 ${cleanClipName(typed)} 로 바꿨습니다`);
      }
    },

    // ── Chord Track ───────────────────────────────────────────────────────
    'daw.detectChords': () => {
      const context = midiContext();
      if (!context) return;
      const state = daw();
      const track = findTrack(state.session, context.trackId);
      const part = track ? trackClips(track).find((c) => c.id === context.clipId) : undefined;
      const map = tempoMapOf(state.session);
      const events = detectChordTrack(context.notes, {
        intervalBeat: beatsPerBar(meterAtBeat(map, 0)),
        clock: partClock(map, part?.startSec ?? 0),
      });
      if (events.length === 0) { notify('화성을 읽을 만한 노트가 없습니다', 'warning'); return; }
      state.apply((s) => setChordTrack(s, events));
      notify(`코드 트랙: ${formatProgression(events)}`, 'success');
    },

    /**
     * Drop a chord at the playhead.
     *
     * Always a C, and that is on purpose: the block is a placeholder you
     * double-click and type over, so asking which chord BEFORE there is
     * anywhere to put it would be a dialog in the way of a keystroke.
     */
    'daw.addChord': () => {
      const state = daw();
      const at = state.playheadSec;
      const result = addChord(sortedChords(state.session), at, makeChord(0));
      if (!result.ok) { notify(result.reason, 'warning'); return; }
      state.apply((s) => withChords(s, result.events));
      notify('코드를 놓았습니다 — 블록을 더블클릭해서 고쳐 쓰세요');
    },

    // ── Vocal pitch editing ───────────────────────────────────────────────
    'daw.analyzeVocal': async () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      notify('보컬 피치 분석 중…');
      try {
        const result = await analyzeClipPitch(state.session, target.trackId, target.clipId);
        state.apply(() => result.session);
        const clip = findClip(result.session, target.trackId, target.clipId);
        notify(`피치 분석 완료 — ${tuningSummary(clip?.pitchSegments ?? [])}`, 'success');
      } catch (err) {
        notify(`분석 실패: ${(err as Error).message}`, 'error');
      }
    },

    'daw.tuneVocal': async () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip || clip.pitchSegments.length === 0) {
        notify('먼저 피치 분석을 실행하세요 (Mod+Alt+P)', 'warning');
        return;
      }
      const scale = useMidiEditorStore.getState().scale;
      notify('피치 보정 렌더링 중…');
      try {
        const corrected = applyCorrection(state.session, target.trackId, target.clipId, {
          kind: 'toScale', scale, amount: 1,
        });
        const rendered = await renderClipPitch(corrected, target.trackId, target.clipId);
        state.apply(() => rendered);
        notify(`${clip.pitchSegments.length}개 구간을 스케일에 맞춰 보정했습니다`, 'success');
      } catch (err) {
        notify(`피치 보정 실패: ${(err as Error).message}`, 'error');
      }
    },

    /**
     * Tune a vocal to a GUIDE MELODY rather than to a scale.
     *
     * The guide is the MIDI part open in the Key Editor.  Tuning to a scale
     * can only ask "what is the nearest legal note to what was sung"; a guide
     * says which note was meant, so a phrase sung a whole tone flat lands
     * where it belongs instead of on the wrong scale degree it was closest to.
     */
    'daw.tuneToGuide': async () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip || clip.pitchSegments.length === 0) {
        notify('먼저 피치 분석을 실행하세요 (Mod+Alt+P)', 'warning');
        return;
      }
      const guide = useMidiEditorStore.getState().open;
      if (!guide) {
        notify('Key Editor 에서 가이드 멜로디 파트를 여세요', 'warning');
        return;
      }
      const notes = guideNotesFor(state.session, clip, guide.trackId, guide.clipId);
      if (notes.length === 0) {
        notify('가이드 파트에 노트가 없습니다', 'warning');
        return;
      }
      notify('가이드 멜로디로 보정 중…');
      try {
        const corrected = applyCorrection(state.session, target.trackId, target.clipId, {
          kind: 'toMidi', notes, amount: 1,
          clock: partClock(tempoMapOf(state.session), clip.startSec),
        });
        const rendered = await renderClipPitch(corrected, target.trackId, target.clipId);
        state.apply(() => rendered);
        notify(`가이드 노트 ${notes.length}개에 맞춰 보정했습니다`
          + ' — 3반음 넘게 떨어진 구간은 정렬 오류로 보고 건너뜁니다', 'success');
      } catch (err) {
        notify(`피치 보정 실패: ${(err as Error).message}`, 'error');
      }
    },

    /** Open the clip under the playhead in the blob editor. */
    'daw.openVocalEditor': () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      useVocalEditorStore.getState().openTake({
        trackId: target.trackId, clipId: target.clipId,
      });
      state.setWindow('vocal');
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip || clip.pitchSegments.length === 0) {
        notify('아직 분석되지 않은 테이크입니다 — 에디터에서 피치 분석을 누르세요');
      }
    },

    // ── Picture ───────────────────────────────────────────────────────────
    'daw.togglePicture': () => {
      useVideoStore.getState().toggle();
    },

    /**
     * Move by a FRAME, not by the nudge amount.
     *
     * Against picture the only meaningful step is one frame, and at 23.976
     * that is 41.7 ms — a number nobody would ever set the nudge to.  With no
     * picture loaded there is no frame rate to step by, so it says so rather
     * than inventing 25.
     */
    'daw.nudgeFrameBack': () => stepFramesWith(daw(), -1, notify),
    'daw.nudgeFrameForward': () => stepFramesWith(daw(), 1, notify),

    // ── Smart Controls / Track Stacks ─────────────────────────────────────
    'daw.tempoChange': () => {
      const state = daw();
      const map = tempoMapOf(state.session);
      const beat = secToBeat(map, state.playheadSec);
      // At the tempo already in force, so dropping one does not move the
      // music — it gives you a handle to move it with.
      const bpm = tempoAtBeat(map, beat);
      state.apply((s) => withTempoMap(s, addTempoEvent(tempoMapOf(s), beat, bpm)));
      const where = barBeatAt(map, beat);
      notify(`${where.bar}마디 — 템포 이벤트 ${bpm.toFixed(1)} BPM`, 'info');
    },

    'daw.tempoRamp': () => {
      const state = daw();
      const map = tempoMapOf(state.session);
      const beat = secToBeat(map, state.playheadSec);
      // The event at or before the playhead: the one whose curve reaches here.
      const event = [...map.tempos].reverse().find((e) => e.beat <= beat + 1e-6);
      if (!event) { notify('템포 이벤트가 없습니다', 'warning'); return; }
      const next = event.curve === 'ramp' ? 'jump' : 'ramp';
      state.apply((s) => withTempoMap(s, updateTempoEvent(tempoMapOf(s), event.id, { curve: next })));
      notify(next === 'ramp'
        ? `${barBeatAt(map, event.beat).bar}마디부터 다음 이벤트까지 템포가 이어집니다`
        : `${barBeatAt(map, event.beat).bar}마디 템포 고정`, 'info');
    },

    'daw.toggleAutomation': () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      const track = trackId ? state.session.tracks.find((t) => t.id === trackId) : undefined;
      if (!track) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      const open = visibleLanes(track).length > 0;
      state.apply((s) => {
        if (open) {
          let next = s;
          for (const lane of track.automation) {
            next = setLaneVisible(next, track.id, lane.target, false);
          }
          return next;
        }
        const first = availableTargets(track)[0];
        return first ? setLaneVisible(s, track.id, first, true) : s;
      });
      notify(open ? '오토메이션 레인을 접었습니다' : `${track.name} — 오토메이션 레인`, 'info');
    },

    'daw.automationMode': () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      const track = trackId ? state.session.tracks.find((t) => t.id === trackId) : undefined;
      if (!track) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      const current = findLane(track.automation, { kind: 'volume' })?.mode
        ?? track.automation[0]?.mode ?? 'read';
      const order: AutomationMode[] = ['read', 'touch', 'latch', 'write', 'trim'];
      const next = order[(order.indexOf(current) + 1) % order.length] ?? 'read';
      state.apply((s) => {
        // Setting a mode on a track with no lanes has to make one, or the
        // selector would say "touch" with nothing able to record.
        const withLane = ensureLane(s, track.id, { kind: 'volume' }, next).session;
        return updateTrack(withLane, track.id, (t) => ({
          ...t,
          automation: t.automation.map((lane) => ({ ...lane, mode: next })),
        }));
      });
      notify(`${track.name} — 오토메이션 ${next}`,
        next === 'write' ? 'warning' : 'info');
    },

    'daw.smartControls': () => {
      const state = daw();
      const trackId = targetTrackIds()[0] ?? state.session.tracks.find((t) => t.kind !== 'master')?.id;
      if (!trackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      state.openSmartControls(trackId);
    },

    'daw.createStack': () => {
      const state = daw();
      const ids = state.selectedTrackIds.length > 0 ? state.selectedTrackIds : targetTrackIds();
      if (ids.length === 0) { notify('스택으로 묶을 트랙을 선택하세요', 'warning'); return; }
      let folderId = '';
      state.apply((s) => {
        const result = createStack(
          s, `STACK ${s.tracks.filter((t) => t.kind === 'folder').length + 1}`, ids, 'summing',
        );
        folderId = result.folderId;
        return result.session;
      });
      if (folderId) state.setFocusedTrack(folderId);
      notify(`${ids.length}개 트랙을 스택으로 묶었습니다`, 'success');
    },

    'daw.unpackStack': () => {
      const state = daw();
      const folderId = folderForSelection(state);
      if (!folderId) { notify('스택을 선택하세요', 'warning'); return; }
      state.apply((s) => unpackStack(s, folderId));
      notify('스택을 해제했습니다');
    },

    'daw.toggleStack': () => {
      const state = daw();
      const folderId = folderForSelection(state);
      if (!folderId) { notify('스택을 선택하세요', 'warning'); return; }
      state.apply((s) => toggleCollapsed(s, folderId));
    },

    // ── Device Chain / Session View ───────────────────────────────────────
    'daw.showChain': () => {
      const state = daw();
      state.setWindow('chain');
      notify('Device Chain');
    },

    'daw.showSession': () => {
      daw().setWindow('session');
      notify('Session View');
    },

    // ── Warp ──────────────────────────────────────────────────────────────
    'daw.showWarp': () => {
      daw().setWindow('warp');
      notify('Warp');
    },

    'daw.autoWarp': () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      try {
        const result = autoWarpClip(state.session, target.trackId, target.clipId);
        state.apply(() => result.session);
        state.setWindow('warp');
        notify(`Auto-Warp · ${result.sourceBpm.toFixed(1)} BPM · 마커 ${result.markerCount}개`, 'success');
      } catch (err) {
        notify((err as Error).message, 'warning');
      }
    },

    'daw.toggleWarp': () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      const clip = findClip(state.session, target.trackId, target.clipId);
      if (!clip) return;
      const on = clipWarp(clip) !== null;
      if (on) {
        state.apply((s) => unwarpClip(s, target.trackId, target.clipId));
        notify('Warp 끔');
        return;
      }
      if ((clip.warp?.markers.length ?? 0) >= 2) {
        state.apply((s) => setWarpEnabled(s, target.trackId, target.clipId, true));
        notify('Warp 켬');
        return;
      }
      try {
        const result = warpClipToTempo(state.session, target.trackId, target.clipId);
        state.apply(() => result.session);
        notify(`Warp 켬 · ${result.sourceBpm.toFixed(1)} BPM${result.estimated ? ' (추정)' : ''}`, 'success');
      } catch (err) {
        notify((err as Error).message, 'warning');
      }
    },

    // ── Intelligence ──────────────────────────────────────────────────────
    'daw.showIntel': () => {
      daw().setWindow('intel');
      notify('Intelligence');
    },

    'daw.analyzeMixAi': () => {
      daw().setWindow('intel');
      useIntelStore.getState().setTab('analyze');
      notify('믹스 분석 중…');
      void useIntelStore.getState().analyze().then(() => {
        const { findings, error } = useIntelStore.getState();
        if (error) { notify(error, 'warning'); return; }
        notify(summariseFindings(findings), findings.length > 0 ? 'warning' : 'success');
      });
    },

    'daw.riff': () => {
      const state = daw();
      if (!useMidiEditorStore.getState().open) {
        notify('Key Editor 에서 MIDI 파트를 먼저 여세요', 'warning');
        return;
      }
      state.setWindow('intel');
      const intel = useIntelStore.getState();
      intel.setTab('riff');
      intel.runRiff(false);
      const { riffSuggestions, error } = useIntelStore.getState();
      notify(error ?? (riffSuggestions[0]?.title ?? '리프를 만들지 못했습니다'),
        error ? 'warning' : 'success');
    },

    'daw.aiCommand': () => {
      daw().setWindow('intel');
      useIntelStore.getState().setTab('command');
      notify('말로 지시하세요 — 예: "보컬 2dB 올려"');
    },

    // ── Arrangement sections ──────────────────────────────────────────────
    'daw.sectionAdd': () => {
      const state = daw();
      const at = snapToGrid(state.playheadSec);
      const result = addSection(sectionsOf(state.session), createSection('verse', at));
      if (!result.ok) { notify(result.reason, 'warning'); return; }
      state.apply((s) => withSections(s, result.sections));
      notify('구간 경계 추가');
    },

    'daw.sectionNext': () => {
      const state = daw();
      const at = nextSectionStart(sectionsOf(state.session), state.playheadSec);
      if (at === null) { notify('다음 구간이 없습니다', 'warning'); return; }
      state.seek(at);
    },

    'daw.sectionPrev': () => {
      const state = daw();
      const at = previousSectionStart(sectionsOf(state.session), state.playheadSec);
      if (at === null) { notify('이전 구간이 없습니다', 'warning'); return; }
      state.seek(at);
    },

    'daw.sectionSelect': () => {
      const state = daw();
      const here = sectionAt(sectionsOf(state.session), state.playheadSec);
      if (!here) { notify('재생헤드에 구간이 없습니다', 'warning'); return; }
      const selection = selectionForSection(state.session, here.id);
      if (!selection) return;
      state.setSelection(selection);
      notify(`${sectionLabel(here)} 선택`);
    },

    /**
     * Move the section the playhead is in, one place along the running order.
     *
     * The playhead follows it: after "put this chorus before the bridge" the
     * thing you were listening to is somewhere else, and being left where it
     * used to be means hunting for it.
     */
    'daw.sectionMoveBack': () => moveSectionUnderPlayhead(-1),
    'daw.sectionMoveForward': () => moveSectionUnderPlayhead(1),

    // ── FL: step sequencer · patterns · note tools ─────────────────────────
    'daw.showSteps': () => {
      daw().setWindow('steps');
      notify('Channel Rack');
    },

    'daw.arpeggiate': () => {
      const context = midiContext();
      if (!context) return;
      const selected = context.notes.filter((n) => context.ids.has(n.id));
      if (selected.length === 0) { notify('노트를 선택하세요', 'warning'); return; }
      const rate = currentGridBeat();
      const arped = arpeggiate(selected, { rateBeat: rate, direction: 'up' });
      writeNotes(context.trackId, context.clipId, [
        ...context.notes.filter((n) => !context.ids.has(n.id)),
        ...arped,
      ]);
      notify(`아르페지오 ${arped.length}노트 · ${rate.toFixed(3)}박 간격`, 'success');
    },

    'daw.strum': () => {
      const context = midiContext();
      if (!context) return;
      const selected = context.notes.filter((n) => context.ids.has(n.id));
      if (selected.length === 0) { notify('노트를 선택하세요', 'warning'); return; }
      // 22 ms of hand travel, expressed in the beats the notes live in.
      const strummed = strum(selected, {
        spreadBeat: secToBeatsAt(context.clock, 0.022), direction: 'up',
      });
      writeNotes(context.trackId, context.clipId, [
        ...context.notes.filter((n) => !context.ids.has(n.id)),
        ...strummed,
      ]);
      notify('스트럼 — 끝은 함께 끝납니다', 'success');
    },

    'daw.slide': () => {
      const context = midiContext();
      if (!context) return;
      const selected = context.notes.filter((n) => context.ids.has(n.id));
      if (selected.length < 2) { notify('두 개 이상의 노트를 선택하세요', 'warning'); return; }
      const slid = applySlides(selected, { bendRangeSemitones: 2 });
      const changed = slid.filter((n) => n.expression.length > 0).length;
      writeNotes(context.trackId, context.clipId, [
        ...context.notes.filter((n) => !context.ids.has(n.id)),
        ...slid,
      ]);
      notify(changed > 0
        ? `슬라이드 ${changed}개 — 피치벤드로 기록`
        : '붙일 만한 간격이 없습니다 (7반음 초과는 건너뜁니다)', changed > 0 ? 'success' : 'warning');
    },

    'daw.capturePattern': () => {
      const state = daw();
      const open = useMidiEditorStore.getState().open;
      if (!open) { notify('Key Editor 에서 파트를 여세요', 'warning'); return; }
      const captured = captureAsPattern(
        state.session, open.trackId, open.clipId,
        findClip(state.session, open.trackId, open.clipId)?.name ?? 'Pattern',
        state.session.tempoBpm);
      if (!captured) { notify('이미 패턴에 링크된 클립입니다', 'warning'); return; }
      state.apply(() => captured.session);
      notify(`${captured.pattern.name} 패턴으로 저장 — 이 클립은 이제 링크입니다`, 'success');
    },

    // ── Recording ─────────────────────────────────────────────────────────
    'daw.toggleArm': () => {
      const state = daw();
      const trackId = state.focusedTrackId
        ?? state.session.tracks.find((t) => t.kind === 'audio')?.id ?? null;
      if (!trackId) { notify('오디오 트랙이 없습니다', 'warning'); return; }
      const track = findTrack(state.session, trackId);
      if (!track) return;
      void useRecordingStore.getState().toggleArm(trackId);
      notify(track.recordArm ? `${track.name} 무장 해제` : `${track.name} 녹음 무장`);
    },

    'daw.record': () => {
      const recorder = useRecordingStore.getState();
      if (recorder.status === 'recording' || recorder.status === 'countIn') {
        void recorder.stop();
        notify('녹음 정지');
        return;
      }
      // The armed tracks decide which inputs have to be open, so the shortcut
      // refuses for the same reason the button does instead of saying
      // "녹음 시작" and having the store quietly bail.
      const readiness = canRecord(daw().session, recorder.settings, {
        audioOpen: dawRuntime.openInputTracks,
        midiOpen: recorder.midiOpen,
      });
      if (!readiness.ok) { notify(readiness.reason ?? '녹음할 수 없습니다', 'warning'); return; }
      void recorder.start();
      notify('녹음 시작');
    },

    'daw.punchFromSelection': () => {
      const state = daw();
      const sel = state.selection;
      const length = Math.abs(sel.endSec - sel.startSec);
      if (length < 0.05) { notify('구간을 먼저 선택하세요', 'warning'); return; }
      useRecordingStore.getState().setSettings({
        punchEnabled: true,
        punchStartSec: Math.min(sel.startSec, sel.endSec),
        punchEndSec: Math.max(sel.startSec, sel.endSec),
      });
      notify(`펀치 ${Math.min(sel.startSec, sel.endSec).toFixed(3)}–${Math.max(sel.startSec, sel.endSec).toFixed(3)}s`);
    },

    // ── Restoration ───────────────────────────────────────────────────────
    'daw.showRestore': () => {
      daw().setWindow('restore');
      notify('Restoration');
    },

    'daw.declick': async () => {
      const state = daw();
      const target = audioClipAtPlayhead(state);
      if (!target) { notify('오디오 클립 위에 커서를 두세요', 'warning'); return; }
      notify('클릭 검사 중…');
      try {
        const result = await declickClip(state.session, target.trackId, target.clipId);
        if (result.detected > 0) state.apply(() => result.session);
        notify(result.message, result.detected > 0 ? 'success' : 'info');
      } catch (err) {
        notify(`디클릭 실패: ${(err as Error).message}`, 'error');
      }
    },

    // ── Spectral Repair / Mastering Reference ─────────────────────────────
    'daw.showSpectral': () => {
      daw().setWindow('spectral');
      notify('Spectral Repair');
    },

    'daw.showReference': () => {
      daw().setWindow('reference');
      notify('Mastering Reference');
    },

    'daw.analyzeMix': () => {
      const state = daw();
      state.setWindow('reference');
      void (async () => {
        try {
          const rendered = await renderSession(state.session, sessionRange(state.session));
          useReferenceStore.getState().setMix(rendered, state.session.name || 'YOUR MIX');
          notify('현재 믹스를 분석했습니다', 'success');
        } catch (err) {
          notify(`믹스 분석 실패: ${(err as Error).message}`, 'error');
        }
      })();
    },

    'daw.launchScene': () => {
      const state = daw();
      const grid = state.session.sessionGrid;
      if (grid.scenes.length === 0) { notify('씬이 없습니다', 'warning'); return; }
      state.setWindow('session');
      notify('Session View 에서 씬을 실행하세요');
    },

    'daw.stopAllClips': () => {
      runtime.stopAllSlots();
      notify('모든 클립 정지');
    },

    'daw.reharmonize': () => {
      const state = daw();
      if (state.session.chordTrack.length === 0) {
        notify('먼저 코드를 감지하세요 (Mod+Shift+C)', 'warning');
        return;
      }
      const next = reharmonize(state.session.chordTrack, { extend: true, insertTwoFive: true });
      state.apply((s) => setChordTrack(s, next));
      notify(`리하모나이즈: ${formatProgression(next)}`, 'success');
    },
  };
}

/**
 * The stack a shortcut should act on: the selected folder, or the nearest
 * stack above the selected track.
 */
function folderForSelection(state: DawState): string | null {
  const trackId = targetTrackIds()[0];
  if (!trackId) return null;
  const track = findTrack(state.session, trackId);
  if (track?.kind === 'folder') return track.id;
  return stackAncestors(state.session, trackId)[0]?.id ?? null;
}

/** The audio clip under the play head on the focused track. */
/** Grow or shrink the height of whatever the keyboard is pointing at. */
function stepHeights(state: DawState, direction: 1 | -1, notify: DawCommandDeps['notify']): void {
  const ids = targetTrackIds();
  if (ids.length === 0) { notify('트랙을 먼저 고르세요', 'warning'); return; }
  const first = findTrack(state.session, ids[0]!);
  const next = stepTrackHeight(first?.height ?? 72, direction);
  state.apply((s: DawSession) => setHeights(s, ids, next));
  notify(describeHeight(next));
}

/** The first audio clip the selection touches, for a sample-level question. */
function firstAudioUnder(
  state: DawState, sel: TimeSelection,
): { trackId: string; clip: Clip } | null {
  for (const trackId of sel.trackIds) {
    const track = findTrack(state.session, trackId);
    if (!track) continue;
    const clip = trackClips(track).find((c) =>
      c.kind === 'audio' && clipEnd(c) > sel.startSec && c.startSec < sel.endSec);
    if (clip) return { trackId, clip };
  }
  return null;
}

/**
 * Cut into the clipboard.
 *
 * `ripple` closes the gap, which is what turns cut-then-paste into a MOVE
 * rather than a copy plus a hole.
 */
function cutInto(state: DawState, ripple: boolean, notify: DawCommandDeps['notify']): void {
  const result = cutRange(state.session, state.selection, ripple);
  if (!result.clipboard) { notify('구간을 먼저 선택하세요 (2번 툴)', 'warning'); return; }
  state.setClipboard(result.clipboard);
  state.apply(() => result.session);
  notify(`잘라냈습니다 — ${describeClipboard(result.clipboard)}${ripple ? ' (뒤를 당김)' : ''}`);
}

/**
 * Paste at the playhead.
 *
 * Targets are the selection's tracks when there are any, else whatever the
 * keyboard is pointing at — the same rule every other edit command here uses,
 * so paste does not need its own idea of "where".
 */
function pasteInto(state: DawState, mode: PasteMode, notify: DawCommandDeps['notify']): void {
  const board = state.clipboard;
  if (isEmptyClipboard(board)) { notify('복사된 것이 없습니다', 'warning'); return; }
  const tracks = state.selection.trackIds.length > 0
    ? state.selection.trackIds : targetTrackIds();
  if (tracks.length === 0) { notify('붙여넣을 트랙을 고르세요', 'warning'); return; }

  let problems: string[] = [];
  let landed = state.selection;
  state.apply((s: DawSession) => {
    const result = pasteAt(s, board!, state.playheadSec, tracks, mode);
    problems = result.problems;
    landed = result.selection;
    return result.session;
  });
  // The pasted material becomes the selection, so the next edit acts on what
  // was just put down rather than on where it came from.
  if (landed.endSec > landed.startSec) state.setSelection(landed);
  if (problems.length > 0) for (const p of problems.slice(0, 2)) notify(p, 'warning');
  else notify(mode === 'insert' ? '끼워 넣었습니다 — 뒤가 밀렸습니다' : '붙여넣었습니다');
}

/** One frame at the picture's own rate, or a complaint when there is none. */
function stepFramesWith(
  state: DawState, frames: number, notify: DawCommandDeps['notify'],
): void {
  const video = videoOf(state.session);
  if (!video) { notify('픽처가 없습니다 — 영상을 먼저 불러오세요', 'warning'); return; }
  state.seek(Math.max(0, state.playheadSec + frames * frameSec(video.fps)));
}

function audioClipAtPlayhead(state: DawState): { trackId: string; clipId: string } | null {
  for (const trackId of targetTrackIds()) {
    const track = findTrack(state.session, trackId);
    if (!track) continue;
    const clip = trackClips(track).find((c) =>
      c.kind === 'audio' && state.playheadSec >= c.startSec && state.playheadSec < clipEnd(c));
    if (clip) return { trackId, clipId: clip.id };
  }
  return null;
}

function findClip(session: DawState['session'], trackId: string, clipId: string) {
  const track = findTrack(session, trackId);
  return track ? trackClips(track).find((c) => c.id === clipId) : undefined;
}

function cyclePlaylistOn(state: DawState, direction: 1 | -1, notify: DawCommandDeps['notify']): void {
  const trackId = targetTrackIds()[0];
  if (!trackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
  state.apply((s) => cyclePlaylist(s, trackId, direction));
  const track = findTrack(state.session, trackId);
  const active = track?.playlists.find((p) => p.id === track.activePlaylistId);
  notify(`테이크: ${active?.name ?? '—'}`);
}

/** Zero-length play-head position widened to the clip under it. */
function clipRangeAtPlayhead(state: DawState): TimeSelection | null {
  const tracks = targetTrackIds();
  for (const trackId of tracks) {
    const track = findTrack(state.session, trackId);
    if (!track) continue;
    const playlist = track.playlists.find((p) => p.id === track.activePlaylistId);
    const clip = playlist?.clips.find((c) =>
      state.playheadSec >= c.startSec && state.playheadSec < c.startSec + c.durationSec);
    if (clip) {
      return { startSec: clip.startSec, endSec: clip.startSec + clip.durationSec, trackIds: [trackId] };
    }
  }
  return null;
}

/**
 * Open a file dialog and put whatever comes back into the open session, at the
 * play head.  Audio becomes tracks, MIDI becomes parts, and the Key Editor
 * opens on the first part so the notes are in front of you.
 */
async function importAtPlayhead(deps: DawCommandDeps): Promise<void> {
  const { notify, daw, invoke } = deps;
  const paths = await invoke('file:open-dialog-multi') as string[] | null;
  if (!paths?.length) return;

  const plan = planDrop(paths, 'daw', 0);
  if (isEmptyPlan(plan)) { notify('오디오나 MIDI 파일이 아닙니다', 'warning'); return; }

  try {
    const report = await importIntoSession(plan.audio, plan.midi, daw().playheadSec);
    notify(describeImport(report), report.failed.length ? 'warning' : 'success');
    if (report.firstMidiPart) {
      useMidiEditorStore.getState().openPart(report.firstMidiPart);
      daw().setWindow('midi');
    }
  } catch (err) {
    notify(`가져오기 실패: ${(err as Error).message}`, 'error');
  }
}

// ── Context-aware overrides ───────────────────────────────────────────────────

/**
 * While the DAW workspace is on screen these shared keys act on the session
 * instead of the mastering preview.  Everything not listed keeps its
 * mastering behaviour in both places.
 */
export function buildDawOverrides(deps: DawCommandDeps): Partial<Record<CommandId, CommandFn>> {
  const { notify, daw, invoke } = deps;

  const soloMuteTargets = (): string[] => {
    const ids = targetTrackIds();
    return ids.length > 0 ? ids : [];
  };

  return {
    'transport.playPause': () => {
      dawRuntime.ensure(daw().session.sampleRate);
      daw().togglePlay();
    },
    'transport.returnToZero': () => {
      const state = daw();
      state.seek(state.loopEnabled ? state.loopStartSec : 0);
    },
    // Numpad * means nothing in the mastering app; in the DAW it is record.
    'transport.record': () => {
      const recorder = useRecordingStore.getState();
      if (recorder.status === 'recording' || recorder.status === 'countIn') {
        void recorder.stop();
        notify('녹음 정지');
        return;
      }
      // The armed tracks decide which inputs have to be open, so the shortcut
      // refuses for the same reason the button does instead of saying
      // "녹음 시작" and having the store quietly bail.
      const readiness = canRecord(daw().session, recorder.settings, {
        audioOpen: dawRuntime.openInputTracks,
        midiOpen: recorder.midiOpen,
      });
      if (!readiness.ok) { notify(readiness.reason ?? '녹음할 수 없습니다', 'warning'); return; }
      void recorder.start();
      notify('녹음 시작');
    },
    'transport.metronome': () => {
      daw().toggleMetronome();
      notify(daw().metronomeOn ? '메트로놈 ON' : '메트로놈 OFF');
    },
    'transport.toggleLoop': () => {
      daw().toggleLoop();
      notify(daw().loopEnabled ? '루프 ON' : '루프 OFF');
    },
    'transport.gotoLoopStart': () => { daw().seek(daw().loopStartSec); },
    'transport.gotoLoopEnd':   () => { daw().seek(daw().loopEndSec); },

    'view.zoomInH':  () => { daw().setPxPerSec(daw().pxPerSec * 1.5); },
    'view.zoomOutH': () => { daw().setPxPerSec(daw().pxPerSec / 1.5); },

    // Cmd+C / Cmd+X / Cmd+V mean the TIMELINE while the DAW is on screen.
    //
    // One binding rather than a second chord nobody would guess: Cmd+C means
    // "copy what I am looking at", and in the DAW that is a range of audio,
    // not the mastering settings.  With nothing selected it says so rather
    // than quietly copying something else — a Cmd+C that silently did a
    // different thing is worse than one that asks for a selection.
    'edit.copy': () => {
      const state = daw();
      const board = copyRange(state.session, state.selection);
      if (!board) { notify('구간을 먼저 선택하세요 (2번 툴)', 'warning'); return; }
      state.setClipboard(board);
      notify(`복사했습니다 — ${describeClipboard(board)}`);
    },
    'edit.cut': () => cutInto(daw(), false, notify),
    'edit.paste': () => pasteInto(daw(), 'overwrite', notify),

    'edit.undo': () => {
      if (!daw().canUndo()) { notify('되돌릴 편집이 없습니다'); return; }
      daw().undo();
      notify('실행 취소');
    },
    'edit.redo': () => {
      if (!daw().canRedo()) { notify('다시 실행할 편집이 없습니다'); return; }
      daw().redo();
      notify('다시 실행');
    },

    'edit.duplicate': () => {
      const state = daw();
      const sel = currentSelection(state);
      if (!hasRange(sel)) { notify('복제할 구간을 선택하세요', 'warning'); return; }
      state.apply((s) => duplicateSelection(s, sel, 1));
      notify('선택 구간을 복제했습니다');
    },
    'edit.repeat': () => {
      const state = daw();
      const sel = currentSelection(state);
      if (!hasRange(sel)) { notify('반복할 구간을 선택하세요', 'warning'); return; }
      state.apply((s) => duplicateSelection(s, sel, 1));
      notify('선택 구간을 반복했습니다');
    },

    'edit.splitAtCursor': () => {
      const state = daw();
      const tracks = targetTrackIds();
      if (tracks.length === 0) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      state.apply((s) => separateAt(s, tracks, snapToGrid(state.playheadSec)));
      notify('커서에서 분리');
    },

    'edit.toggleSnap': () => {
      const state = daw();
      const next = state.editMode === 'grid' ? 'slip' : 'grid';
      state.setEditMode(next);
      notify(`${next === 'grid' ? 'GRID' : 'SLIP'} 모드`);
    },

    'track.solo': () => {
      const ids = soloMuteTargets();
      if (ids.length === 0) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      daw().apply((s) => ids.reduce((acc, id) => toggleSolo(acc, id), s));
      notify('솔로 토글');
    },
    'track.mute': () => {
      const ids = soloMuteTargets();
      if (ids.length === 0) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
      daw().apply((s) => ids.reduce((acc, id) => toggleMute(acc, id), s));
      notify('뮤트 토글');
    },
    'track.clearSoloMute': () => {
      daw().apply((s) => clearAllMute(clearAllSolo(s)));
      notify('모든 Solo / Mute 해제');
    },

    'window.keyEditor': () => {
      const state = daw();
      const trackId = targetTrackIds()[0];
      const track = trackId ? findTrack(state.session, trackId) : undefined;
      const part = track
        ? trackClips(track).find((c) => c.kind === 'midi'
            && state.playheadSec >= c.startSec && state.playheadSec < c.startSec + c.durationSec)
          ?? trackClips(track).find((c) => c.kind === 'midi')
        : undefined;
      if (!part || !trackId) { notify('MIDI 파트를 가진 트랙을 선택하세요', 'warning'); return; }
      useMidiEditorStore.getState().openPart({ trackId, clipId: part.id });
      state.setWindow('midi');
      notify(`Key Editor: ${part.name}`);
    },

    'loop.toSelection': () => {
      const state = daw();
      const sel = state.selection;
      if (sel.endSec <= sel.startSec) { notify('루프로 지정할 구간이 없습니다', 'warning'); return; }
      state.setLoop(sel.startSec, sel.endSec);
      if (!state.loopEnabled) state.toggleLoop();
      notify('선택 구간을 루프로 지정했습니다');
    },

    'file.new': () => {
      daw().loadSession(createSession('Untitled Session'));
      notify('새 세션', 'success');
    },
    // Mod+O in the mastering app fills the queue and jumps to the home screen.
    // In the DAW that would eject you from the session you are editing, so here
    // it adds tracks at the play head and you stay where you are.
    'file.open': () => importAtPlayhead(deps),
    'file.openSession': async () => {
      const loaded = await invoke('session:load') as { path: string; data: string } | null;
      if (!loaded) return;
      const parsed = deserializeDawSession(loaded.data);
      if (!parsed.ok) { notify(parsed.error, 'error'); return; }
      daw().loadSession(parsed.session);
      notify('세션을 열었습니다', 'success');
    },
    'file.save': async () => {
      const json = serializeDawSession(daw().session);
      const dest = await invoke('session:save', json) as string | null;
      if (dest) notify('세션 저장 완료', 'success');
    },
    'file.saveAs': async () => {
      const json = serializeDawSession(daw().session);
      const dest = await invoke('session:save', json) as string | null;
      if (dest) notify('세션 저장 완료', 'success');
    },
    'file.export': async () => {
      const state = daw();
      if (sessionEndSec(state.session) <= 0) { notify('내보낼 오디오가 없습니다', 'warning'); return; }
      try {
        const dest = await bounceSession(state.session);
        notify(dest ? '바운스 완료' : '바운스를 취소했습니다', dest ? 'success' : 'info');
      } catch (err) {
        notify(`바운스 실패: ${(err as Error).message}`, 'error');
      }
    },
  };
}
