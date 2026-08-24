// DawPage — the Pro Tools-shaped workspace: one session, two windows.
//
// Edit and Mix are two views of the SAME session object, so a fader move in
// Mix is on the clip lane's automation the moment you switch back.  The page
// owns the chrome (transport, track creation, bounce/freeze); the windows own
// their own interaction.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { useDawStore } from '../stores/dawStore.js';
import EditWindow from '../components/daw/edit/EditWindow.js';
import MixWindow from '../components/daw/mix/MixWindow.js';
import KeyEditor from '../components/daw/midi/KeyEditor.js';
import SmartControlPanel from '../components/daw/smart/SmartControlPanel.js';
import DeviceChainView from '../components/daw/chain/DeviceChainView.js';
import SessionViewGrid from '../components/daw/session/SessionViewGrid.js';
import SpectralEditor from '../components/daw/spectral/SpectralEditor.js';
import VocalEditor from '../components/daw/vocal/VocalEditor.js';
import VideoViewer from '../components/daw/video/VideoViewer.js';
import { useVideoStore } from '../stores/videoStore.js';
import { findRecoveries, loadRecovery, type RecoveryOffer } from '../daw/engine/autosave-driver.js';
import { premium } from '../theme/premium.js';
import ReferencePanel from '../components/daw/reference/ReferencePanel.js';
import WarpEditor from '../components/daw/warp/WarpEditor.js';
import RestorePanel from '../components/daw/restore/RestorePanel.js';
import SeparatePanel from '../components/daw/separate/SeparatePanel.js';
import RecordStrip from '../components/daw/record/RecordStrip.js';
import StepSequencer from '../components/daw/steps/StepSequencer.js';
import IntelPanel from '../components/daw/intel/IntelPanel.js';
import PluginWindowLayer from '../components/daw/plugin/PluginWindowLayer.js';
import { createStack } from '../daw/model/stacks.js';
import { setSessionTempo } from '../daw/model/warp.js';
import { useMidiEditorStore } from '../stores/midiEditorStore.js';
import {
  addTrack, createTrack, createBus, createMidiPart, findTrack, sessionEndSec, updateClips,
} from '../daw/model/session-ops.js';
import { shouldAdoptQueue } from '../daw/model/import-audio.js';
import { describeImport, importIntoSession } from '../daw/edit/session-import.js';
import { importSessionData, deserializeDawSession, serializeDawSession } from '../daw/model/session-io.js';
import {
  bounceSession, commitTrack, freezeTrack, stageForMastering, unfreezeTrack,
} from '../daw/engine/offline-render.js';
import {
  handoffFileName, handoffMessage, handoffProblem,
} from '../daw/edit/master-handoff.js';
import { describePlan, exportStems, planStems } from '../daw/engine/stem-export.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import TemplatePanel from '../components/daw/template/TemplatePanel.js';
import { describeFailure, exportAaf, importAaf } from '../daw/io/aaf-actions.js';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.000';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export default function DawPage() {
  const setPage      = useAppStore((s) => s.setPage);
  const notify       = useAppStore((s) => s.notify);
  const session      = useDawStore((s) => s.session);
  const apply        = useDawStore((s) => s.apply);
  const loadSession  = useDawStore((s) => s.loadSession);
  const windowMode   = useDawStore((s) => s.window);
  const setWindow    = useDawStore((s) => s.setWindow);
  const isPlaying    = useDawStore((s) => s.isPlaying);
  const togglePlay   = useDawStore((s) => s.togglePlay);
  const seek         = useDawStore((s) => s.seek);
  const playheadSec  = useDawStore((s) => s.playheadSec);
  const metronomeOn  = useDawStore((s) => s.metronomeOn);
  const loopEnabled  = useDawStore((s) => s.loopEnabled);
  const toggleLoop   = useDawStore((s) => s.toggleLoop);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const selection    = useDawStore((s) => s.selection);
  const [busy, setBusy] = useState<string | null>(null);

  // Files the user loaded on the home screen.  The DAW used to ignore them
  // entirely, which meant opening it always showed an empty session — you
  // could not start a project with the music you had just imported.
  const queue = useAudioStore((s) => s.queue);
  const importedOnce = useRef(false);

  const invoke = useCallback(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const api = window.electronAPI;
    if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
    return api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
  }, []);

  /** Pull the home screen's files in as audio tracks. */
  const importQueue = useCallback(async (silent = false) => {
    const paths = useAudioStore.getState().queue.map((q) => q.filePath).filter(Boolean);
    if (paths.length === 0) {
      if (!silent) notify('홈 화면에 불러온 곡이 없습니다', 'warning');
      return;
    }
    setBusy(`홈에서 불러온 곡을 가져오는 중… 0/${paths.length}`);
    try {
      // Decoding is sequential, so the count is real progress, not a spinner.
      const report = await importIntoSession(paths, [], 0,
        (done, total) => setBusy(`홈에서 불러온 곡을 가져오는 중… ${done}/${total}`));
      notify(describeImport(report), report.failed.length ? 'warning' : 'success');
    } catch (err) {
      notify(`가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify]);

  /**
   * On the first visit, an empty session adopts whatever is on the home
   * screen.  Nothing can be lost — the session has no audio yet — and it is
   * the only behaviour that makes "load songs, open the DAW" work the way
   * anyone would expect.
   */
  useEffect(() => {
    if (importedOnce.current) return;
    if (!shouldAdoptQueue(session, queue.length)) return;
    importedOnce.current = true;
    void importQueue(true);
  }, [queue.length, session.tracks, importQueue]);

  const handleImportAudio = useCallback(async () => {
    const paths = await invoke('file:open-dialog-multi') as string[] | null;
    if (!paths?.length) return;
    setBusy(`오디오 불러오는 중… 0/${paths.length}`);
    try {
      const report = await importIntoSession(paths, [], playheadSec,
        (done, total) => setBusy(`오디오 불러오는 중… ${done}/${total}`));
      notify(describeImport(report), report.failed.length ? 'warning' : 'success');
    } catch (err) {
      notify(`가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [invoke, notify, playheadSec]);

  /** New instrument track with an empty four-bar part, opened for editing. */
  const handleAddInstrument = useCallback(() => {
    const current = useDawStore.getState().session;
    const barSec = (60 / current.tempoBpm) * current.timeSignature[0];
    const track = createTrack(`Synth ${current.tracks.filter((t) => t.kind === 'instrument').length + 1}`, 'instrument');
    const part = createMidiPart(`${track.name} 1`, { startSec: 0, durationSec: barSec * 4 });
    apply((s) => updateClips(addTrack(s, track), track.id, () => [part]));
    useDawStore.getState().setFocusedTrack(track.id);
    useMidiEditorStore.getState().openPart({ trackId: track.id, clipId: part.id });
    setWindow('midi');
    notify('인스트루먼트 트랙을 만들고 Key Editor 를 열었습니다', 'success');
  }, [apply, notify, setWindow]);

  /** Import a .mid — one instrument track per source track, MPE preserved. */
  const handleImportMidi = useCallback(async () => {
    const paths = await invoke('file:open-dialog-multi') as string[] | null;
    const first = paths?.[0];
    if (!first) return;
    setBusy('MIDI 읽는 중…');
    try {
      const report = await importIntoSession([], [first], 0);
      if (report.midiParts === 0) { notify('노트가 있는 트랙이 없습니다', 'warning'); return; }
      if (report.firstMidiPart) {
        useMidiEditorStore.getState().openPart(report.firstMidiPart);
        setWindow('midi');
      }
      notify(describeImport(report), 'success');
    } catch (err) {
      notify(`MIDI 가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [invoke, notify, setWindow]);

  /** Wrap the selected tracks (or the focused one) in a summing stack. */
  const handleCreateStack = useCallback(() => {
    const state = useDawStore.getState();
    const ids = state.selectedTrackIds.length > 0
      ? state.selectedTrackIds
      : (state.focusedTrackId ? [state.focusedTrackId] : []);
    if (ids.length === 0) { notify('스택으로 묶을 트랙을 선택하세요', 'warning'); return; }
    let folderId = '';
    apply((s) => {
      const result = createStack(s, `STACK ${s.tracks.filter((t) => t.kind === 'folder').length + 1}`, ids, 'summing');
      folderId = result.folderId;
      return result.session;
    });
    if (folderId) state.setFocusedTrack(folderId);
    notify(`${ids.length}개 트랙을 스택으로 묶었습니다`, 'success');
  }, [apply, notify]);

  const handleSaveSession = useCallback(async () => {
    const json = serializeDawSession(useDawStore.getState().session);
    const dest = await invoke('session:save', json) as string | null;
    if (dest) notify('세션 저장 완료', 'success');
  }, [invoke, notify]);

  const handleOpenSession = useCallback(async () => {
    const loaded = await invoke('session:load') as { path: string; data: string } | null;
    if (!loaded) return;
    const parsed = deserializeDawSession(loaded.data);
    if (!parsed.ok) { notify(parsed.error, 'error'); return; }
    loadSession(parsed.session);
    notify('세션을 열었습니다', 'success');
  }, [invoke, notify, loadSession]);

  const handleImportSession = useCallback(async () => {
    const loaded = await invoke('session:load') as { path: string; data: string } | null;
    if (!loaded) return;
    const parsed = deserializeDawSession(loaded.data);
    if (!parsed.ok) { notify(parsed.error, 'error'); return; }
    const result = importSessionData(useDawStore.getState().session, parsed.session, {
      includeAlternatePlaylists: true, includeAutomation: true,
    });
    apply(() => result.session);
    notify(`${result.importedTrackIds.length}개 트랙을 가져왔습니다`, 'success');
    for (const w of result.warnings) notify(w, 'warning');
  }, [invoke, notify, apply]);

  /**
   * Bring in a picture editor's AAF.
   *
   * The media it names lives on the machine that wrote it, so the import
   * reports what came across and leaves the audio to be relinked — a session
   * of clips at the right times with the wrong paths is still the day's work
   * saved, and pretending the files are here would not be.
   */
  const handleImportAaf = useCallback(async () => {
    const loaded = await invoke('daw:aaf-open') as { path: string; bytes: number[] } | null;
    if (!loaded) return;
    try {
      const result = importAaf(Uint8Array.from(loaded.bytes));
      loadSession(result.session);
      for (const p of result.problems.slice(0, 5)) notify(p, 'warning');
      if (result.problems.length > 5) {
        notify(`… 그리고 ${result.problems.length - 5}가지 더`, 'warning');
      }
      notify(`${result.summary} · 미디어는 다시 연결해야 합니다`, 'success');
    } catch (err) {
      notify(describeFailure(err), 'error');
    }
  }, [invoke, notify, loadSession]);

  const handleExportAaf = useCallback(async () => {
    const current = useDawStore.getState().session;
    try {
      const result = exportAaf(current);
      for (const p of result.problems.slice(0, 5)) notify(p, 'warning');
      if (result.problems.length > 5) {
        notify(`… 그리고 ${result.problems.length - 5}가지 더`, 'warning');
      }
      const dest = await invoke('daw:aaf-save', {
        name: current.name, bytes: Array.from(result.bytes),
      }) as string | null;
      if (!dest) { notify('AAF 내보내기를 취소했습니다', 'info'); return; }
      notify(`AAF 저장 — ${result.summary}`, 'success');
    } catch (err) {
      notify(describeFailure(err), 'error');
    }
  }, [invoke, notify]);

  const handleBounce = useCallback(async () => {
    const current = useDawStore.getState().session;
    if (sessionEndSec(current) <= 0) { notify('바운스할 오디오가 없습니다', 'warning'); return; }
    setBusy('바운스 렌더링 중…');
    try {
      const range = selection.endSec > selection.startSec
        ? { startSec: selection.startSec, endSec: selection.endSec }
        : undefined;
      const dest = await bounceSession(current, range);
      notify(dest ? `바운스 완료 — ${dest.split(/[\\/]/).pop()}` : '바운스를 취소했습니다',
        dest ? 'success' : 'info');
    } catch (err) {
      notify(`바운스 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify, selection]);

  /**
   * Render the mix and hand it to the mastering queue, then go there.
   *
   * The navigation is part of the action, not a courtesy.  Sending a mix to a
   * list on another screen and staying put leaves the person to wonder whether
   * it worked; the whole point of the button is that mixing and mastering stop
   * being two errands.
   */
  const handleSendToMastering = useCallback(async () => {
    const current = useDawStore.getState().session;
    const problem = handoffProblem(current, { queued: useAudioStore.getState().queue.length });
    if (problem) { notify(problem, 'warning'); return; }
    setBusy('믹스를 렌더링하는 중…');
    try {
      const path = await stageForMastering(current);
      const before = useAudioStore.getState().queue.length;
      useAudioStore.getState().addFilesToQueue([path]);
      const after = useAudioStore.getState().queue.length;
      if (after === before) {
        notify('대기열에 넣지 못했습니다 — 홈에서 자리를 만든 뒤 다시 보내세요', 'error');
        return;
      }
      setPage('home');
      notify(handoffMessage(handoffFileName(current.name), after), 'success');
    } catch (err) {
      notify(`마스터링으로 보내지 못했습니다: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify, setPage]);

  const [templatesOpen, setTemplatesOpen] = useState(false);

  const handleStems = useCallback(async () => {
    const current = useDawStore.getState().session;
    const plan = planStems(current);
    if (plan.items.length === 0) {
      notify('내보낼 스템이 없습니다 — 들리는 오디오 트랙이 없습니다', 'warning');
      return;
    }
    // What is about to be written, said before the folder dialog: the count,
    // the length, and anything being left out.
    notify(`${describePlan(plan)} — 폴더를 선택하세요`);
    setBusy('스템 렌더링 준비 중…');
    try {
      const result = await exportStems(current, {}, (p) => {
        setBusy(`스템 ${p.index}/${p.total} — ${p.trackName}`);
      });
      if (!result.directory) { notify('스템 내보내기를 취소했습니다', 'info'); return; }
      for (const w of result.warnings) notify(w, 'warning');
      // Skipped tracks are named, not counted: "3 skipped" sends you hunting.
      for (const s of result.skipped) notify(`${s.trackName} 제외 — ${s.reason}`, 'info');
      notify(`스템 ${result.written.length}개 저장 — ${result.directory}`, 'success');
    } catch (err) {
      notify(`스템 내보내기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify]);

  const handleFreeze = useCallback(async () => {
    if (!focusedTrackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
    const current = useDawStore.getState().session;
    const track = findTrack(current, focusedTrackId);
    if (!track) return;
    if (track.frozen) { apply((s) => unfreezeTrack(s, focusedTrackId)); notify('프리즈 해제'); return; }
    setBusy('프리즈 렌더링 중…');
    try {
      const result = await freezeTrack(current, focusedTrackId);
      apply(() => result.session);
      notify(`${track.name} 프리즈 완료`, 'success');
    } catch (err) {
      notify(`프리즈 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [focusedTrackId, apply, notify]);

  const handleCommit = useCallback(async () => {
    if (!focusedTrackId) { notify('트랙을 먼저 선택하세요', 'warning'); return; }
    setBusy('커밋 렌더링 중…');
    try {
      const next = await commitTrack(useDawStore.getState().session, focusedTrackId);
      apply(() => next);
      notify('커밋 완료 — 인서트를 오디오에 렌더링했습니다', 'success');
    } catch (err) {
      notify(`커밋 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [focusedTrackId, apply, notify]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle={`DAW · ${windowMode.toUpperCase()}`}
        actions={
          <button onClick={() => setPage('home')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">← 홈</button>
        }
      />

      {/* Transport / session chrome */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800 bg-[#15151d] flex-wrap">
        <div className="flex rounded-md overflow-hidden border border-zinc-700 mr-1">
          {(['edit', 'mix', 'midi', 'chain', 'session', 'steps', 'warp', 'spectral', 'vocal', 'stems', 'restore', 'reference', 'intel'] as const).map((w) => (
            <button key={w} onClick={() => setWindow(w)}
              className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                windowMode === w ? 'bg-indigo-600/30 text-indigo-300' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
            >{
              w === 'edit' ? 'EDIT'
              : w === 'mix' ? 'MIX'
              : w === 'midi' ? 'KEY'
              : w === 'chain' ? 'CHAIN'
              : w === 'session' ? 'SESSION'
              : w === 'steps' ? 'STEPS'
              : w === 'warp' ? 'WARP'
              : w === 'spectral' ? 'SPECTRAL'
              : w === 'vocal' ? 'VOCAL'
              : w === 'stems' ? 'STEMS'
              : w === 'restore' ? 'RESTORE'
              : w === 'reference' ? 'REFERENCE'
              : 'AI'
            }</button>
          ))}
        </div>

        <button onClick={() => { dawRuntime.ensure(session.sampleRate); seek(0); }}
          title="처음으로 (Home)"
          className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[11px]">⏮</button>
        <button onClick={() => { dawRuntime.ensure(session.sampleRate); togglePlay(); }}
          title="재생 / 정지 (Space)"
          className={`h-7 px-3 rounded border text-[11px] ${isPlaying
            ? 'bg-emerald-600/25 border-emerald-500/50 text-emerald-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-300'}`}>{isPlaying ? '❚❚' : '▶'}</button>
        <button onClick={() => useVideoStore.getState().toggle()} title="픽처 창 (Shift+Alt+P)"
          className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[11px]">PIC</button>
        <button onClick={() => useDawStore.getState().toggleMetronome()}
          title="메트로놈 (C) — 템포 맵을 따라갑니다"
          className={`h-7 px-2 rounded border text-[11px] ${metronomeOn
            ? 'bg-amber-600/25 border-amber-500/50 text-amber-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}>♩</button>
        <button onClick={toggleLoop} title="루프 (Numpad /)"
          className={`h-7 px-2 rounded border text-[11px] ${loopEnabled
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}>LOOP</button>

        <span className="ml-2 text-[12px] font-mono text-zinc-200 tabular-nums">{fmt(playheadSec)}</span>

        <label className="ml-2 flex items-center gap-1 text-[10px] text-zinc-500" title="세션 템포 — 워프된 클립이 따라옵니다">
          <input
            type="number" min={20} max={300} step={0.5} value={session.tempoBpm}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value) || value <= 0) return;
              const { session: next, unwarpedClipIds } = setSessionTempo(
                useDawStore.getState().session, value);
              apply(() => next);
              if (unwarpedClipIds.length > 0) {
                notify(`${next.tempoBpm} BPM — 워프가 꺼진 클립 ${unwarpedClipIds.length}개는 길이가 그대로입니다`, 'warning');
              }
            }}
            className="w-16 h-7 px-1.5 rounded bg-zinc-900 border border-zinc-700
                       text-zinc-200 text-[11px] font-mono tabular-nums"
          />
          BPM
        </label>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleImportAudio}>오디오 추가</ToolbarButton>
        {queue.length > 0 && (
          <ToolbarButton onClick={() => void importQueue()}>
            홈 트랙 가져오기 ({queue.length})
          </ToolbarButton>
        )}
        <ToolbarButton onClick={() => apply((s) => addTrack(s, createTrack(`Audio ${s.tracks.length}`, 'audio')))}>
          + 트랙
        </ToolbarButton>
        <ToolbarButton onClick={handleAddInstrument}>+ 인스트루먼트</ToolbarButton>
        <ToolbarButton onClick={handleImportMidi}>MIDI 가져오기</ToolbarButton>
        <ToolbarButton onClick={() => apply((s) => {
          const bus = createBus(`Bus ${s.buses.length + 1}`);
          const aux = createTrack(`Aux ${s.tracks.filter((t) => t.kind === 'aux').length + 1}`, 'aux', {
            input: bus.id,
          });
          return addTrack({ ...s, buses: [...s.buses, bus] }, aux);
        })}>+ Aux</ToolbarButton>
        <ToolbarButton onClick={() => apply((s) => addTrack(s,
          createTrack(`VCA ${s.tracks.filter((t) => t.kind === 'vca').length + 1}`, 'vca', {
            output: { kind: 'none' },
          })))}>+ VCA</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={() => {
          const id = focusedTrackId ?? session.tracks.find((t) => t.kind !== 'master')?.id ?? null;
          if (!id) { notify('트랙이 없습니다', 'warning'); return; }
          useDawStore.getState().openSmartControls(id);
        }}>스마트 컨트롤</ToolbarButton>
        <ToolbarButton onClick={handleCreateStack}>스택 만들기</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleFreeze}>프리즈</ToolbarButton>
        <ToolbarButton onClick={handleCommit}>커밋</ToolbarButton>
        <ToolbarButton onClick={handleBounce}>바운스</ToolbarButton>
        {/* The seam this app is actually for: mix here, master there, one
            press.  Highlighted because it is the finish line, and placed next
            to 바운스 because that is where someone goes looking for "I am
            done" — the difference being that this one does not ask for a
            folder or count as an export. */}
        <ToolbarButton onClick={() => void handleSendToMastering()} accent>
          마스터링으로 →
        </ToolbarButton>
        <ToolbarButton onClick={handleStems}>스템</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={() => setTemplatesOpen(true)}>템플릿</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleSaveSession}>세션 저장</ToolbarButton>
        <ToolbarButton onClick={handleOpenSession}>세션 열기</ToolbarButton>
        <ToolbarButton onClick={handleImportSession}>세션 가져오기</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleImportAaf}>AAF 가져오기</ToolbarButton>
        <ToolbarButton onClick={handleExportAaf}>AAF 내보내기</ToolbarButton>

        <div className="flex-1" />
        {busy && <span className="text-[11px] text-amber-400">{busy}</span>}
      </div>

      {/* Floating plugin windows live above every view, so switching from Edit
          to Mix does not close the compressor you were setting. */}
      <PluginWindowLayer />

      <RecordStrip />

      <SmartControlPanel />

      {windowMode === 'edit' ? <EditWindow />
        : windowMode === 'mix' ? <MixWindow />
        : windowMode === 'midi' ? <KeyEditor />
        : windowMode === 'chain' ? <DeviceChainView />
        : windowMode === 'session' ? <SessionViewGrid />
        : windowMode === 'steps' ? <StepSequencer />
        : windowMode === 'warp' ? <WarpEditor />
        : windowMode === 'spectral' ? <SpectralEditor />
        : windowMode === 'vocal' ? <VocalEditor />
        : windowMode === 'stems' ? <SeparatePanel />
        : windowMode === 'restore' ? <RestorePanel />
        : windowMode === 'intel' ? <IntelPanel />
        : <ReferencePanel />}

      {templatesOpen && <TemplatePanel onClose={() => setTemplatesOpen(false)} />}

      {/* Floats over every window — scoring means watching the picture WHILE
          arranging, not instead of it. */}
      <VideoViewer />
      <RecoveryPrompt />
    </div>
  );
}

function ToolbarButton(
  { onClick, children, accent }:
  { onClick: () => void; children: React.ReactNode; accent?: boolean },
) {
  // One button in this row is the finish line and the rest are tools.  The
  // accent is the app's own gold rather than a new colour, so the row still
  // reads as one row.
  if (accent === true) {
    return (
      <button
        onClick={onClick}
        className="h-7 px-2.5 rounded text-[11px] transition-colors"
        style={{
          background: 'rgba(198,167,104,0.16)',
          color: premium.accent.light,
          border: `1px solid ${premium.accent.deep}`,
        }}
      >{children}</button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400
                 text-[11px] hover:text-zinc-200 hover:border-zinc-600 transition-colors"
    >{children}</button>
  );
}

/**
 * The crash-recovery offer.
 *
 * Shown ONCE, at startup, and only when there is something worth offering —
 * a full-width banner every time the app opens would train people to dismiss
 * it, which is the one thing it must not do.
 *
 * It never opens anything by itself.  Restoring replaces the open session, so
 * it is a decision, not a convenience.
 */
function RecoveryPrompt() {
  const [offers, setOffers] = useState<RecoveryOffer[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const notify = useAppStore((s) => s.notify);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    void findRecoveries((c, ...a) => api.invoke(c as never, ...a)).then(setOffers);
  }, []);

  if (dismissed || offers.length === 0) return null;
  const offer = offers[0]!;

  const restore = async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;
    const result = await loadRecovery((c, ...a) => api.invoke(c as never, ...a), offer.info);
    setDismissed(true);
    if ('error' in result) { notify(`복구하지 못했습니다: ${result.error}`, 'error'); return; }
    useDawStore.getState().loadSession(result.session);
    notify(`${offer.info.sessionName} 을 복구했습니다`, 'success');
  };

  return (
    <div className="fixed z-50 rounded shadow-2xl"
         style={{
           right: 20, bottom: 20, width: 320, padding: '14px 16px',
           background: premium.surface.frame,
           border: `1px solid ${premium.accent.deep}`,
         }}>
      <div style={{ fontSize: 11, letterSpacing: '0.12em', color: premium.accent.base }}>
        복구할 세션이 있습니다
      </div>
      <div style={{ fontSize: 12.5, color: premium.text.primary, margin: '6px 0 2px' }}>
        {offer.label}
      </div>
      <p style={{ fontSize: 11, color: premium.text.muted, margin: '0 0 10px' }}>
        앱이 예기치 않게 종료됐을 때 저장된 것입니다. 복구하면 지금 열려 있는
        세션을 대체합니다.
      </p>
      <div className="flex gap-1.5">
        <button onClick={() => { void restore(); }}
          className="h-6 px-2.5 rounded text-[11px]"
          style={{ background: 'rgba(198,167,104,0.16)', color: premium.accent.light,
                   border: `1px solid ${premium.accent.deep}` }}>복구</button>
        <button onClick={() => setDismissed(true)}
          className="h-6 px-2.5 rounded text-[11px]"
          style={{ background: 'transparent', color: premium.text.muted,
                   border: `1px solid ${premium.surface.hairline}` }}>무시</button>
      </div>
    </div>
  );
}
