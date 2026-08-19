// DawPage — the Pro Tools-shaped workspace: one session, two windows.
//
// Edit and Mix are two views of the SAME session object, so a fader move in
// Mix is on the clip lane's automation the moment you switch back.  The page
// owns the chrome (transport, track creation, bounce/freeze); the windows own
// their own interaction.

import React, { useCallback, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useDawStore } from '../stores/dawStore.js';
import EditWindow from '../components/daw/edit/EditWindow.js';
import MixWindow from '../components/daw/mix/MixWindow.js';
import KeyEditor from '../components/daw/midi/KeyEditor.js';
import SmartControlPanel from '../components/daw/smart/SmartControlPanel.js';
import DeviceChainView from '../components/daw/chain/DeviceChainView.js';
import SessionViewGrid from '../components/daw/session/SessionViewGrid.js';
import SpectralEditor from '../components/daw/spectral/SpectralEditor.js';
import ReferencePanel from '../components/daw/reference/ReferencePanel.js';
import { createStack } from '../daw/model/stacks.js';
import { useMidiEditorStore } from '../stores/midiEditorStore.js';
import {
  addTrack, createTrack, createBus, createMidiPart, findTrack, sessionEndSec, updateClips,
} from '../daw/model/session-ops.js';
import { importMidiFile } from '../daw/io/midi-file.js';
import { importAudioFiles } from '../daw/model/import-audio.js';
import { importSessionData, deserializeDawSession, serializeDawSession } from '../daw/model/session-io.js';
import { bounceSession, commitTrack, freezeTrack, unfreezeTrack } from '../daw/engine/offline-render.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { toFileUrl } from '../utils/fileUrl.js';

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
  const loopEnabled  = useDawStore((s) => s.loopEnabled);
  const toggleLoop   = useDawStore((s) => s.toggleLoop);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const selection    = useDawStore((s) => s.selection);
  const [busy, setBusy] = useState<string | null>(null);

  const invoke = useCallback(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const api = window.electronAPI;
    if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
    return api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
  }, []);

  const handleImportAudio = useCallback(async () => {
    const paths = await invoke('file:open-dialog-multi') as string[] | null;
    if (!paths?.length) return;
    setBusy('오디오 불러오는 중…');
    try {
      const result = await importAudioFiles(useDawStore.getState().session, paths, 0);
      loadSessionKeepingHistory(result.session);
      if (result.failed.length) notify(`${result.failed.length}개 파일을 디코딩하지 못했습니다`, 'warning');
      else notify(`${result.trackIds.length}개 트랙을 추가했습니다`, 'success');
    } finally { setBusy(null); }
  }, [invoke, notify]);

  // Import keeps the undo stack: it is an edit, not a new session.
  const loadSessionKeepingHistory = useCallback((next: typeof session) => {
    useDawStore.getState().apply(() => next);
  }, []);

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
      const response = await fetch(toFileUrl(first));
      const bytes = new Uint8Array(await response.arrayBuffer());
      const imported = importMidiFile(bytes);
      if (imported.parts.length === 0) { notify('노트가 있는 트랙이 없습니다', 'warning'); return; }

      let firstOpen: { trackId: string; clipId: string } | null = null;
      apply((s) => {
        let next = { ...s, tempoBpm: imported.tempoBpm, timeSignature: imported.timeSignature };
        for (const importedPart of imported.parts) {
          const track = createTrack(importedPart.name || 'MIDI', 'instrument');
          const part = createMidiPart(importedPart.name || 'MIDI', {
            startSec: 0,
            durationSec: Math.max(1, importedPart.durationSec),
            notes: importedPart.notes,
            controllers: importedPart.controllers,
            midiConfig: {
              bendRangeSemitones: importedPart.bendRangeSemitones,
              mpe: importedPart.mpe,
            },
          });
          next = updateClips(addTrack(next, track), track.id, () => [part]);
          if (!firstOpen) firstOpen = { trackId: track.id, clipId: part.id };
        }
        return next;
      });
      if (firstOpen) {
        useMidiEditorStore.getState().openPart(firstOpen);
        setWindow('midi');
      }
      const mpeCount = imported.parts.filter((p) => p.mpe).length;
      notify(
        `${imported.parts.length}개 MIDI 트랙 · ${imported.tempoBpm.toFixed(0)} BPM`
        + (mpeCount > 0 ? ` · MPE ${mpeCount}개 (노트별 표현 유지)` : ''),
        'success',
      );
    } catch (err) {
      notify(`MIDI 가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [invoke, apply, notify, setWindow]);

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
          {(['edit', 'mix', 'midi', 'chain', 'session', 'spectral', 'reference'] as const).map((w) => (
            <button key={w} onClick={() => setWindow(w)}
              className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                windowMode === w ? 'bg-indigo-600/30 text-indigo-300' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
            >{
              w === 'edit' ? 'EDIT'
              : w === 'mix' ? 'MIX'
              : w === 'midi' ? 'KEY'
              : w === 'chain' ? 'CHAIN'
              : w === 'session' ? 'SESSION'
              : w === 'spectral' ? 'SPECTRAL'
              : 'REFERENCE'
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
        <button onClick={toggleLoop} title="루프 (Numpad /)"
          className={`h-7 px-2 rounded border text-[11px] ${loopEnabled
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}>LOOP</button>

        <span className="ml-2 text-[12px] font-mono text-zinc-200 tabular-nums">{fmt(playheadSec)}</span>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleImportAudio}>오디오 추가</ToolbarButton>
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

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton onClick={handleSaveSession}>세션 저장</ToolbarButton>
        <ToolbarButton onClick={handleOpenSession}>세션 열기</ToolbarButton>
        <ToolbarButton onClick={handleImportSession}>세션 가져오기</ToolbarButton>

        <div className="flex-1" />
        {busy && <span className="text-[11px] text-amber-400">{busy}</span>}
      </div>

      <SmartControlPanel />

      {windowMode === 'edit' ? <EditWindow />
        : windowMode === 'mix' ? <MixWindow />
        : windowMode === 'midi' ? <KeyEditor />
        : windowMode === 'chain' ? <DeviceChainView />
        : windowMode === 'session' ? <SessionViewGrid />
        : windowMode === 'spectral' ? <SpectralEditor />
        : <ReferencePanel />}
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400
                 text-[11px] hover:text-zinc-200 hover:border-zinc-600 transition-colors"
    >{children}</button>
  );
}
