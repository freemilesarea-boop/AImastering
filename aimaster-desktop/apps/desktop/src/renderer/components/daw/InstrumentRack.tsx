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
import {
  describeKitPreset, kitGenreOf, kitParamOf, kitPresetParams,
} from '../../daw/engine/drum-presets.js';
import { GENRE_LABEL, GENRE_ORDER, type GenreId } from '../../daw/engine/plugin-presets-genre.js';
import {
  DRUM_PATTERNS, describePattern, findPattern, patternFill, patternNotes,
} from '../../daw/engine/drum-patterns.js';
import { exportMidiFile } from '../../daw/io/midi-file.js';
import {
  CATEGORY_LABEL, categoriesFor, patchParams, patchesFor,
} from '../../daw/engine/instrument-patches.js';
import { findInstrument } from '../../daw/engine/instruments.js';

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
  const [patternId, setPatternId] = useState(DRUM_PATTERNS[0]?.id ?? '');
  /** Which slot has its parameters open.  One at a time — 21 knobs is a page. */
  const [openSlot, setOpenSlot] = useState<string | null>(null);

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

  /**
   * Load a genre kit onto a slot.
   *
   * This is the first thing in the app that writes `instrumentParams` at all.
   * The field has been on the Track, carried through save, undo, templates
   * and the bounce, and read by three places in the engine, with nothing ever
   * setting it — so every instrument has been running on its defaults.
   */
  const setKit = useCallback((trackId: string, genre: GenreId | null) => {
    apply((s) => updateTrack(s, trackId, (t) => ({
      ...t,
      // Whole, not merged: a preset is a set of decisions, and half of one
      // laid over half of another is a kit nobody designed.
      instrumentParams: kitPresetParams(genre),
    })));
    notify(describeKitPreset(genre));
  }, [apply, notify]);

  /**
   * Load a factory patch onto a slot.
   *
   * Whole, not merged — the same rule the kit picker follows, and for the
   * same reason: a preset is a set of decisions, and half of one laid over
   * half of another is a sound nobody designed.
   */
  const setPatch = useCallback((trackId: string, instrumentId: string, patchId: string) => {
    apply((s) => updateTrack(s, trackId, (t) => ({
      ...t, instrumentParams: patchParams(instrumentId, patchId),
    })));
    const patch = patchesFor(instrumentId).find((p) => p.id === patchId);
    notify(patch ? `${patch.name} — ${patch.note}` : '패치를 불러왔습니다');
  }, [apply, notify]);

  /**
   * Move one parameter.
   *
   * Transient while the pointer is down and committed on release, so a drag
   * across a slider lands as ONE undo step rather than as sixty.  The engine
   * reads these at note-on, so the next note is what you hear the change on.
   */
  const dragParam = useCallback((trackId: string, instrumentId: string, id: string, value: number) => {
    useDawStore.getState().applyTransient((s) => updateTrack(s, trackId, (t) => ({
      ...t,
      // Filled out from the instrument's defaults on first touch: a track
      // that has never been edited stores nothing, and writing a lone key
      // into that would leave the rest implicit and the patch unreadable.
      instrumentParams: {
        ...patchParams(instrumentId, 'init'), ...t.instrumentParams, [id]: value,
      },
    })));
  }, []);

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

  /**
   * Drop a genre beat on the track as a new part.
   *
   * The chart goes through the step sequencer's own converter, so swing,
   * ratchets and velocity mean here exactly what they mean there — a second
   * converter would be a second definition of where a swung sixteenth falls.
   */
  const addPattern = useCallback((trackId: string, id: string) => {
    const pattern = findPattern(id);
    if (!pattern) { notify('그런 패턴이 없습니다', 'warning'); return; }
    const current = useDawStore.getState().session;
    const track = findTrack(current, trackId);
    if (!track) return;
    const beatsPerBar = current.timeSignature[0] || 4;
    const { repeats, beats } = patternFill(pattern, beatsPerBar);
    const start = newPartPlacement(current, track).startSec;
    const part = createMidiPart(`${pattern.name}`, {
      startSec: start,
      durationSec: beats * (60 / current.tempoBpm),
      notes: patternNotes(pattern, repeats),
    });
    apply((s) => updateClips(s, trackId, (clips) => [...clips, part]));
    notify(`${describePattern(pattern)} · ${beats / beatsPerBar}마디`, 'success');
  }, [apply, notify]);

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
                 className="px-2 py-1.5 rounded mb-1"
                 style={{ background: premium.surface.frame, border: `1px solid ${premium.surface.hairline}` }}>
            <div className="flex items-center gap-2">
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

            {/* Every melodic instrument gets a patch picker.  The kit does
                not: its presets are the eleven genre kits below, which are a
                patch per DRUM rather than one per instrument. */}
            {patchesFor(slot.instrumentId).length > 0 && (
              <div className="flex items-center gap-2 mt-1.5 pt-1.5"
                   style={{ borderTop: `1px solid ${premium.surface.hairline}` }}>
                <span style={{ fontSize: 9, color: premium.text.muted }}>패치</span>
                <select
                  // Empty value = 편집됨.  The picker is told what the numbers
                  // ARE rather than what was last clicked, so moving a knob
                  // shows it immediately and no stored state can disagree.
                  value={slot.patch?.id ?? ''}
                  onChange={(e) => setPatch(slot.trackId, slot.instrumentId, e.target.value)}
                  className="h-6 px-1.5 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-200"
                >
                  {slot.patch === null && <option value="">편집됨</option>}
                  {categoriesFor(slot.instrumentId).map((c) => (
                    <optgroup key={c} label={CATEGORY_LABEL[c]}>
                      {patchesFor(slot.instrumentId).filter((p) => p.category === c).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Small onClick={() => setOpenSlot(openSlot === slot.trackId ? null : slot.trackId)}>
                  {openSlot === slot.trackId ? '노브 닫기' : '노브'}
                </Small>
                <span className="flex-1 truncate" style={{ fontSize: 10, color: premium.text.muted }}>
                  {slot.patch?.note ?? '패치에서 값을 바꿨습니다 — 다시 고르면 되돌아갑니다'}
                </span>
              </div>
            )}

            {openSlot === slot.trackId && (
              <ParamKnobs
                instrumentId={slot.instrumentId}
                params={slot.params}
                onDrag={(id, v) => dragParam(slot.trackId, slot.instrumentId, id, v)}
                onCommit={() => useDawStore.getState().commitEdit()}
              />
            )}

            {/* Drums get a second line: what the kit SOUNDS like, and what it
                PLAYS.  Both are per-genre and they are different questions —
                a 힙합 kit playing a 팝 beat is a real and useful thing. */}
            {slot.instrumentId === 'drumkit' && (
              <div className="flex items-center gap-2 mt-1.5 pt-1.5"
                   style={{ borderTop: `1px solid ${premium.surface.hairline}` }}>
                <span style={{ fontSize: 9, color: premium.text.muted }}>킷</span>
                <select
                  value={kitParamOf(slot.kit)}
                  onChange={(e) => setKit(slot.trackId, kitGenreOf(Number(e.target.value)))}
                  title="장르별 킷 — 조각마다 튜닝·감쇠·레벨·팬이 다릅니다"
                  className="h-6 px-1.5 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-200"
                >
                  <option value={0}>기본 킷</option>
                  {GENRE_ORDER.map((g) => (
                    <option key={g} value={kitParamOf(g)}>{GENRE_LABEL[g]}</option>
                  ))}
                </select>
                <span style={{ fontSize: 9, color: premium.text.muted }}>패턴</span>
                <select
                  value={patternId}
                  onChange={(e) => setPatternId(e.target.value)}
                  title={findPattern(patternId)?.note ?? ''}
                  className="h-6 px-1.5 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-200"
                >
                  {GENRE_ORDER.map((g) => (
                    <optgroup key={g} label={GENRE_LABEL[g]}>
                      {DRUM_PATTERNS.filter((p) => p.genre === g).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Small onClick={() => addPattern(slot.trackId, patternId)}>+ 패턴</Small>
                <span className="flex-1 truncate" style={{ fontSize: 10, color: premium.text.muted }}>
                  {findPattern(patternId)?.note ?? ''}
                </span>
              </div>
            )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Every parameter of one instrument, as sliders.
 *
 * Until this existed, nothing in the app wrote `instrumentParams` except the
 * kit picker — so every instrument ran on its defaults and not one of its
 * knobs was reachable.  A patch is a starting point; without these it would
 * be the only point.
 *
 * The value shown is the instrument's default until the track stores
 * something, which is what the engine does too — so the slider reads what
 * will be played rather than what happens to be on the track.
 */
function ParamKnobs({ instrumentId, params, onDrag, onCommit }: {
  instrumentId: string;
  params: Readonly<Record<string, number>>;
  onDrag: (id: string, value: number) => void;
  onCommit: () => void;
}) {
  const instrument = findInstrument(instrumentId);
  if (!instrument) return null;
  return (
    <div className="grid gap-x-3 gap-y-1 mt-1.5 pt-1.5"
         style={{
           gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
           borderTop: `1px solid ${premium.surface.hairline}`,
         }}>
      {instrument.params.map((p) => {
        const value = params[p.id] ?? p.default;
        return (
          <label key={p.id} className="flex items-center gap-1.5" title={`${p.min} … ${p.max} ${p.unit}`}>
            <span className="w-[52px] shrink-0 truncate"
                  style={{ fontSize: 9, color: premium.text.muted }}>{p.name}</span>
            <input
              type="range"
              min={p.min} max={p.max}
              // A hundred steps across whatever the range happens to be, so a
              // 0…1 control and a 200…12000 Hz one both move usefully.
              step={(p.max - p.min) / 100}
              value={value}
              onChange={(e) => onDrag(p.id, Number(e.target.value))}
              // The drag is transient; THIS is what lands it in the undo
              // stack, once, however far the pointer travelled.
              onPointerUp={onCommit}
              onKeyUp={onCommit}
              className="flex-1 min-w-0 h-1 accent-zinc-400"
            />
            <span className="w-[44px] shrink-0 text-right tabular-nums"
                  style={{ fontSize: 9, color: premium.text.primary }}>
              {value >= 1000 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(3)}
            </span>
          </label>
        );
      })}
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
