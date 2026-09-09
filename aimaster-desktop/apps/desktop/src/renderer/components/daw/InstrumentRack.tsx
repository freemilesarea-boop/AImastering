// InstrumentRack — F11.
//
// Cubase's F11 is the fastest path in that program from "I want a piano" to
// a bar you can write notes on, and it is fast for one reason: the instrument
// is chosen FIRST, and the track is made to match.  Here it went the other
// way round.  `+ 인스트루먼트` made a `polysynth` and named it `Synth N`, and
// the only way to reach the other four was a dropdown inside the Key Editor,
// which needs a part, which needs the track you already made.  Four working
// instruments sat behind that.
//
// So: pick, and it exists — named after what it is, with four empty bars and
// the editor open on them.
//
// The rack also carries the two things a slot needs and nothing else offered:
// the sampler's library button (a rack slot is where a plugin's own UI
// belongs) and MIDI export (`exportMidiFile` has been written and tested
// since the importer landed, with nothing in the app calling it).

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../stores/dawStore.js';
import { useAppStore } from '../../stores/appStore.js';
import { useMidiEditorStore } from '../../stores/midiEditorStore.js';
import { premium } from '../../theme/premium.js';
import { INSTRUMENTS } from '../../daw/engine/instruments.js';
import {
  describeLoad, loadedLibrary, openSampleLibrary,
} from '../../daw/engine/sample-library.js';
import { dawRuntime } from '../../daw/engine/daw-runtime.js';
import {
  createMidiPart, createTrack, findTrack, trackClips, updateClips, updateTrack,
} from '../../daw/model/session-ops.js';
import {
  addInstrumentSlot, describeSlot, midiFileName, needsDrumMap, newPartPlacement,
  nextInstrumentName, rackSlots, trackNotesInBeats,
} from '../../daw/model/instrument-rack.js';
import { assignDrumMap, drumMapFor } from '../../daw/model/drum-map-session.js';
import { GM_DRUM_MAP } from '../../daw/model/drum-map.js';
import { exportMidiFile } from '../../daw/io/midi-file.js';

export default function InstrumentRack({ onClose }: { onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const setWindow = useDawStore((s) => s.setWindow);
  const notify = useAppStore((s) => s.notify);

  const invoke = useCallback(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const api = window.electronAPI;
    if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
    return api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
  }, []);

  const [pick, setPick] = useState(INSTRUMENTS[0]?.id ?? 'polysynth');
  // The loaded library lives in a module rather than a store, so the button
  // that names it needs a local reason to re-render after a load.
  const [libName, setLibName] = useState<string | null>(loadedLibrary()?.set.name ?? null);

  const slots = useMemo(() => rackSlots(session), [session]);

  /** Add a slot: the instrument decides the name, and the part comes with it. */
  const addSlot = useCallback((instrumentId: string) => {
    const descriptor = INSTRUMENTS.find((i) => i.id === instrumentId);
    if (!descriptor) { notify('그런 악기가 없습니다', 'warning'); return; }
    const current = useDawStore.getState().session;
    const name = nextInstrumentName(current, descriptor.name);
    const track = createTrack(name, 'instrument', { instrumentId });
    const place = newPartPlacement(current, undefined);
    const part = createMidiPart(`${name} 1`, place);
    // Track, part and (for a kit) its map arrive as one value — see
    // `addInstrumentSlot`, which exists so a test can check the map is there
    // rather than grep for the call that adds it.
    apply((s) => addInstrumentSlot(s, track, part));
    useDawStore.getState().setFocusedTrack(track.id);
    useMidiEditorStore.getState().openPart({ trackId: track.id, clipId: part.id });
    setWindow('midi');
    onClose();
    notify(`${name} — 4마디 파트를 만들고 Key Editor 를 열었습니다`, 'success');
  }, [apply, notify, setWindow, onClose]);

  /** Change what a slot plays.  The notes do not move; only the voice does. */
  const setInstrument = useCallback((trackId: string, instrumentId: string) => {
    apply((s) => {
      const next = updateTrack(s, trackId, (t) => ({ ...t, instrumentId }));
      // Switching TO the kit gives the track a map if it has none.  Switching
      // AWAY leaves whatever map it had: the names are the user's work, and
      // throwing them out because they auditioned a synth would be rude.
      if (!needsDrumMap(instrumentId)) return next;
      return drumMapFor(next, findTrack(next, trackId))
        ? next : assignDrumMap(next, trackId, GM_DRUM_MAP);
    });
    const label = INSTRUMENTS.find((i) => i.id === instrumentId)?.name ?? instrumentId;
    notify(`악기를 ${label} 로 바꿨습니다`);
  }, [apply, notify]);

  /** Open a slot's part — or make one first, so the button is never dead. */
  const editSlot = useCallback((trackId: string) => {
    const current = useDawStore.getState().session;
    const track = findTrack(current, trackId);
    if (!track) return;
    const existing = trackClips(track).find((c) => c.kind === 'midi');
    if (existing) {
      useMidiEditorStore.getState().openPart({ trackId, clipId: existing.id });
    } else {
      const place = newPartPlacement(current, track);
      const part = createMidiPart(`${track.name} 1`, place);
      apply((s) => updateClips(s, trackId, (clips) => [...clips, part]));
      useMidiEditorStore.getState().openPart({ trackId, clipId: part.id });
    }
    useDawStore.getState().setFocusedTrack(trackId);
    setWindow('midi');
    onClose();
  }, [apply, setWindow, onClose]);

  /** Another four bars, after what is already there rather than on top. */
  const addPart = useCallback((trackId: string) => {
    const current = useDawStore.getState().session;
    const track = findTrack(current, trackId);
    if (!track) return;
    const place = newPartPlacement(current, track);
    const part = createMidiPart(`${track.name} ${trackClips(track).length + 1}`, place);
    apply((s) => updateClips(s, trackId, (clips) => [...clips, part]));
    notify(`파트를 ${place.startSec.toFixed(1)}초 지점에 추가했습니다`);
  }, [apply, notify]);

  /** Write the slot's notes out as a .mid. */
  const exportSlot = useCallback(async (trackId: string) => {
    const current = useDawStore.getState().session;
    const track = findTrack(current, trackId);
    if (!track) return;
    const notes = trackNotesInBeats(current, track);
    // A file with no notes is a file that will disappoint someone later.
    if (notes.length === 0) { notify('내보낼 노트가 없습니다', 'warning'); return; }
    try {
      const bytes = exportMidiFile(notes, current.tempoBpm);
      const saved = await invoke('daw:midi-save', {
        name: midiFileName(track.name), data: bytes,
      }) as string | null;
      if (!saved) return;   // cancelled
      notify(`${notes.length}노트를 ${saved} 에 저장했습니다`, 'success');
    } catch (err) {
      notify(`MIDI 저장 실패: ${(err as Error).message}`, 'error');
    }
  }, [invoke, notify]);

  const loadLibrary = useCallback(async () => {
    try {
      notify('샘플 라이브러리를 읽는 중…', 'info');
      const lib = await openSampleLibrary(dawRuntime.context);
      if (!lib) return;   // cancelled
      setLibName(lib.set.name);
      notify(describeLoad(lib), lib.missing.length ? 'warning' : 'success');
    } catch (err) {
      notify(`라이브러리 열기 실패: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center pt-16"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[720px] max-w-[94vw] max-h-[76vh] overflow-hidden flex flex-col rounded"
        style={{
          background: premium.surface.panel,
          border: `1px solid ${premium.surface.hairlineStrong}`,
          boxShadow: premium.shadow.panel,
        }}
      >
        <div className="flex items-center gap-3 px-4 py-2"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
          <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
            인스트루먼트
          </span>
          <span style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
            F11 — 악기를 고르면 트랙과 4마디 파트가 함께 생깁니다
          </span>
          <div className="flex-1" />
          <Small onClick={onClose}>닫기</Small>
        </div>

        {/* Add a slot. */}
        <div className="flex items-center gap-2 px-4 py-2.5"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.frame }}>
          <span style={{ fontSize: 10, color: premium.text.muted, letterSpacing: '0.1em' }}>새 슬롯</span>
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-7 px-2 rounded text-[11px] bg-zinc-900 border border-zinc-700 text-zinc-200"
          >
            {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button
            onClick={() => addSlot(pick)}
            className="h-7 px-3 rounded text-[11px] font-medium bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 hover:bg-indigo-600/50"
          >+ 추가</button>
          <div className="flex-1" />
          <button
            onClick={() => { void loadLibrary(); }}
            title="SFZ 샘플 라이브러리를 엽니다 (Salamander Grand Piano 등) — Sampler 슬롯이 씁니다"
            className="h-7 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-zinc-100"
          >{libName ? `♪ ${libName}` : '♪ 라이브러리'}</button>
        </div>

        <div className="overflow-y-auto flex-1 px-3 py-2">
          {slots.length === 0 && (
            <p className="px-1 py-6 text-center" style={{ fontSize: 11, color: premium.text.muted }}>
              슬롯이 비어 있습니다. 위에서 악기를 골라 추가하세요.
            </p>
          )}
          {slots.map((slot) => (
            <div key={slot.trackId}
                 className="flex items-center gap-2 px-2 py-1.5 rounded mb-1"
                 style={{ background: premium.surface.frame, border: `1px solid ${premium.surface.hairline}` }}>
              <span className="w-5 text-right tabular-nums"
                    style={{ fontSize: 10, color: premium.text.muted }}>{slot.index}</span>
              <span className="w-[130px] truncate" style={{ fontSize: 11, color: premium.text.primary }}
                    title={slot.trackName}>{slot.trackName}</span>
              <select
                value={slot.instrumentId}
                onChange={(e) => setInstrument(slot.trackId, e.target.value)}
                className="h-6 px-1.5 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-200"
              >
                {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                {/* A track can carry an id this build no longer has — a session
                    from a newer version, or a renamed instrument.  Showing it
                    keeps the select honest instead of silently reading as
                    whatever happens to be first in the list. */}
                {!INSTRUMENTS.some((i) => i.id === slot.instrumentId) && (
                  <option value={slot.instrumentId}>{slot.instrumentId} (없는 악기)</option>
                )}
              </select>
              <span className="flex-1 truncate" style={{ fontSize: 10, color: premium.text.muted }}>
                {describeSlot(slot)}
              </span>
              <Small onClick={() => editSlot(slot.trackId)}>편집</Small>
              <Small onClick={() => addPart(slot.trackId)}>+ 파트</Small>
              <Small onClick={() => { void exportSlot(slot.trackId); }}>MIDI</Small>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Small({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="h-6 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-zinc-100">
      {children}
    </button>
  );
}
