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
  nudgeClipGain, nudgeSelection, separateAt, trimToSelection, hasRange,
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
import { importAudioFiles } from '../daw/model/import-audio.js';
import {
  bounceSession, commitTrack, consolidateSelection, freezeTrack, renderSession, sessionRange, unfreezeTrack,
} from '../daw/engine/offline-render.js';
import { useReferenceStore } from '../stores/referenceStore.js';
import {
  autoWarpClip, setWarpEnabled, unwarpClip, warpClipToTempo,
} from '../daw/edit/warp-actions.js';
import { clipWarp } from '../daw/model/warp.js';
import { transientsFor } from '../daw/engine/audio-cache.js';
import { useMidiEditorStore, currentGridSec } from '../stores/midiEditorStore.js';
import { updateClip, trackClips } from '../daw/model/session-ops.js';
import {
  quantizeNotes, humanizeNotes, transposeNotes, nudgeVelocity, applyLegato,
} from '../daw/edit/midi-edit.js';
import { noteEnd, type MidiNote } from '../daw/model/midi.js';
import { detectChordTrack, barSeconds } from '../daw/edit/chord-detect.js';
import { setChordTrack } from '../daw/model/session-ops.js';
import { reharmonize, formatProgression } from '../daw/model/chords.js';
import {
  analyzeClipPitch, applyCorrection, renderClipPitch, tuningSummary,
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
  | 'daw.freeze' | 'daw.commit' | 'daw.bounce'
  | 'daw.importAudio' | 'daw.importSession'
  | 'daw.zoomIn' | 'daw.zoomOut'
  | 'daw.quantize' | 'daw.humanize' | 'daw.selectAllNotes' | 'daw.legatoNotes'
  | 'daw.transposeUp' | 'daw.transposeDown'
  | 'daw.octaveUp' | 'daw.octaveDown'
  | 'daw.velocityUp' | 'daw.velocityDown'
  | 'daw.detectChords' | 'daw.reharmonize'
  | 'daw.analyzeVocal' | 'daw.tuneVocal'
  | 'daw.smartControls' | 'daw.createStack' | 'daw.unpackStack' | 'daw.toggleStack'
  | 'daw.showChain' | 'daw.showSession' | 'daw.launchScene' | 'daw.stopAllClips'
  | 'daw.showSpectral' | 'daw.showReference' | 'daw.analyzeMix'
  | 'daw.showWarp' | 'daw.autoWarp' | 'daw.toggleWarp';

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
  } | null => {
    const editor = useMidiEditorStore.getState();
    const open = editor.open;
    if (!open) { notify('Key Editor 에서 MIDI 파트를 먼저 여세요', 'warning'); return null; }
    const track = findTrack(daw().session, open.trackId);
    const part = track ? trackClips(track).find((c) => c.id === open.clipId) : undefined;
    if (!part) { notify('열린 MIDI 파트를 찾을 수 없습니다', 'warning'); return null; }
    const selected = editor.selectedNoteIds;
    const ids = new Set(selected.length > 0 ? selected : part.notes.map((n) => n.id));
    return { trackId: open.trackId, clipId: open.clipId, notes: part.notes, ids };
  };

  /** Write notes back, keeping the part long enough to contain them. */
  const writeNotes = (trackId: string, clipId: string, notes: MidiNote[]): void => {
    daw().apply((s) => updateClip(s, trackId, clipId, (c) => ({
      ...c,
      notes,
      durationSec: Math.max(c.durationSec, notes.reduce((m, n) => Math.max(m, noteEnd(n)), 0)),
    })));
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

    'daw.importAudio': async () => {
      const paths = await invoke('file:open-dialog-multi') as string[] | null;
      if (!paths?.length) return;
      const result = await importAudioFiles(daw().session, paths, daw().playheadSec);
      daw().apply(() => result.session);
      if (result.failed.length) notify(`${result.failed.length}개 파일 디코딩 실패`, 'warning');
      else notify(`${result.trackIds.length}개 트랙 추가`, 'success');
    },

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
      const gridSec = currentGridSec(daw().session.tempoBpm);
      writeNotes(context.trackId, context.clipId,
        quantizeNotes(context.notes, context.ids, { ...editor.quantize, gridSec }));
      notify(`퀀타이즈 (강도 ${editor.quantize.strengthPercent ?? 100}%)`);
    },

    'daw.humanize': () => {
      const context = midiContext();
      if (!context) return;
      const editor = useMidiEditorStore.getState();
      writeNotes(context.trackId, context.clipId, humanizeNotes(context.notes, context.ids, {
        timingSec: editor.humanizeTimingMs / 1000,
        velocity: editor.humanizeVelocity,
        gridSec: currentGridSec(daw().session.tempoBpm),
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

    // ── Chord Track ───────────────────────────────────────────────────────
    'daw.detectChords': () => {
      const context = midiContext();
      if (!context) return;
      const state = daw();
      const track = findTrack(state.session, context.trackId);
      const part = track ? trackClips(track).find((c) => c.id === context.clipId) : undefined;
      const interval = barSeconds(state.session.tempoBpm, state.session.timeSignature[0]);
      const events = detectChordTrack(context.notes, {
        intervalSec: interval,
        offsetSec: part?.startSec ?? 0,
      });
      if (events.length === 0) { notify('화성을 읽을 만한 노트가 없습니다', 'warning'); return; }
      state.apply((s) => setChordTrack(s, events));
      notify(`코드 트랙: ${formatProgression(events)}`, 'success');
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

    // ── Smart Controls / Track Stacks ─────────────────────────────────────
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
    'transport.toggleLoop': () => {
      daw().toggleLoop();
      notify(daw().loopEnabled ? '루프 ON' : '루프 OFF');
    },
    'transport.gotoLoopStart': () => { daw().seek(daw().loopStartSec); },
    'transport.gotoLoopEnd':   () => { daw().seek(daw().loopEndSec); },

    'view.zoomInH':  () => { daw().setPxPerSec(daw().pxPerSec * 1.5); },
    'view.zoomOutH': () => { daw().setPxPerSec(daw().pxPerSec / 1.5); },

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
    'file.open': async () => {
      const paths = await invoke('file:open-dialog-multi') as string[] | null;
      if (!paths?.length) return;
      const result = await importAudioFiles(daw().session, paths, daw().playheadSec);
      daw().apply(() => result.session);
      notify(`${result.trackIds.length}개 트랙 추가`, 'success');
    },
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
