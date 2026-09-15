// DrumMapEditor — the kit itself, not the part.
//
// Everything here edits the MAP, which is shared: a change lands on every
// track pointing at it and on every part those tracks play.  That is the
// point of storing maps once, and it is also the thing to be careful about,
// so the panel says how many tracks are listening.

import React from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import {
  clearSlotField, describeSlot, moveSlot, rowsFor, setSlot,
  type DrumMap, type DrumSlot,
} from '../../../daw/model/drum-map.js';
import {
  setSessionDrumMap, tracksUsingDrumMap,
} from '../../../daw/model/drum-map-session.js';
import { remapPitch } from '../../../daw/model/drum-map.js';
import { clipNotes, writeClipNotes } from '../../../daw/model/patterns.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { premium } from '../../../theme/premium.js';

/** The grids an instrument can be pinned to, as note values. */
const GRIDS: { label: string; beats: number | undefined }[] = [
  { label: '—',    beats: undefined },
  { label: '1/4',  beats: 1 },
  { label: '1/8',  beats: 0.5 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/16', beats: 0.25 },
  { label: '1/16T', beats: 1 / 6 },
  { label: '1/32', beats: 0.125 },
];

export default function DrumMapEditor(
  { map, trackId, clipId, onClose }: {
    map: DrumMap; trackId: string; clipId: string; onClose: () => void;
  },
) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const users = tracksUsingDrumMap(session, map.id).length;

  const track = findTrack(session, trackId);
  const part = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  const notes = part ? clipNotes(session, part) : [];
  const hitCount = (pitch: number): number => notes.filter((n) => n.pitch === pitch).length;
  // The kit's own rows PLUS any pitch the part uses that the kit does not
  // name — the same rows the editor draws.  Listing only the named ones would
  // make a note the part actually plays unreachable from the panel that
  // exists to name things.
  const rows = rowsFor(map, notes);
  const named = new Set(map.slots.map((sl) => sl.pitch));

  const edit = (pitch: number, patch: Partial<DrumSlot>): void => {
    apply((s) => setSessionDrumMap(s, setSlot(map, pitch, patch)));
  };
  /** An emptied field is REMOVED, not set to undefined — see `clearSlotField`. */
  const clear = (
    pitch: number, field: 'outPitch' | 'quantizeBeat' | 'chokeGroup' | 'muted',
  ): void => {
    apply((s) => setSessionDrumMap(s, clearSlotField(map, pitch, field)));
  };
  const move = (pitch: number, delta: number): void => {
    apply((s) => setSessionDrumMap(s, moveSlot(map, pitch, delta)));
  };
  /**
   * Move every hit of an instrument to another row.
   *
   * This one edits the PART, not the map — it is the "I played the kick on
   * the wrong pad" fix.  Changing the map's out-pitch instead would play the
   * right sound while the editor still showed the wrong row.
   */
  const moveHits = (from: number, to: number): void => {
    if (!part) return;
    apply((s) => writeClipNotes(s, trackId, clipId, remapPitch(clipNotes(s, part), from, to)));
  };

  return (
    <div className="absolute right-2 top-9 z-20 w-[420px] rounded border shadow-2xl"
         style={{
           background: premium.surface.panel, borderColor: premium.surface.hairline,
           fontFamily: premium.type.sans,
         }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b"
           style={{ borderColor: premium.surface.hairline }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>{map.name}</span>
        <span className="text-[9px]" style={{ color: premium.text.faint }}>
          이 킷을 쓰는 트랙 {users}개 — 여기서 바꾸면 전부 바뀝니다
        </span>
        <div className="flex-1" />
        <button onClick={onClose}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기
        </button>
      </div>

      <div className="max-h-[380px] overflow-y-auto">
        <table className="w-full text-[10px]" style={{ color: premium.text.secondary }}>
          <thead>
            <tr style={{ color: premium.text.faint }}>
              <th className="text-left font-normal pl-2 py-1">악기</th>
              <th className="font-normal" title="이 파트에 있는 히트 수">히트</th>
              <th className="font-normal" title="실제로 연주되는 노트 번호 (O-note)">출력</th>
              <th className="font-normal" title="이 악기만의 퀀타이즈 그리드">그리드</th>
              <th className="font-normal" title="같은 번호끼리 서로를 끊습니다 (하이햇)">초크</th>
              <th className="font-normal">음소거</th>
              <th className="font-normal">순서</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((slot) => {
              const hits = hitCount(slot.pitch);
              const inKit = named.has(slot.pitch);
              return (
                <tr key={slot.pitch} className="border-t"
                    style={{
                      borderColor: 'rgba(255,255,255,0.04)',
                      background: inKit ? undefined : 'rgba(235,180,90,0.07)',
                    }}
                    title={inKit ? undefined
                      : '이 파트에는 있지만 킷에는 없는 노트입니다 — 이름을 넣으면 킷에 추가됩니다'}>
                  <td className="pl-2 py-0.5">
                    <div className="flex items-center gap-1">
                      <input
                        value={slot.pitch}
                        type="number" min={0} max={127}
                        onChange={(e) => moveHits(slot.pitch, Number(e.target.value))}
                        title={`${describeSlot(slot)} — 번호를 바꾸면 이 파트의 히트가 그 줄로 옮겨갑니다`}
                        style={numStyle}
                      />
                      <input
                        value={slot.name}
                        onChange={(e) => edit(slot.pitch, { name: e.target.value })}
                        style={{ ...numStyle, width: 104, textAlign: 'left' }}
                      />
                    </div>
                  </td>
                  <td className="text-center" style={{ color: hits ? premium.text.secondary : premium.text.faint }}>
                    {hits || '—'}
                  </td>
                  <td className="text-center">
                    <input
                      type="number" min={0} max={127}
                      value={slot.outPitch ?? ''}
                      placeholder={`${slot.pitch}`}
                      onChange={(e) => (e.target.value === ''
                        ? clear(slot.pitch, 'outPitch')
                        : edit(slot.pitch, { outPitch: Number(e.target.value) }))}
                      title="비워 두면 쓰여 있는 번호 그대로 연주합니다"
                      style={numStyle}
                    />
                  </td>
                  <td className="text-center">
                    <select
                      value={GRIDS.find((g) => g.beats === slot.quantizeBeat)?.label ?? '—'}
                      onChange={(e) => {
                        const beats = GRIDS.find((g) => g.label === e.target.value)?.beats;
                        if (beats === undefined) clear(slot.pitch, 'quantizeBeat');
                        else edit(slot.pitch, { quantizeBeat: beats });
                      }}
                      style={{ ...numStyle, width: 58 }}
                    >
                      {GRIDS.map((g) => <option key={g.label} value={g.label}>{g.label}</option>)}
                    </select>
                  </td>
                  <td className="text-center">
                    <input
                      type="number" min={0} max={9}
                      value={slot.chokeGroup ?? ''}
                      placeholder="—"
                      onChange={(e) => (e.target.value === ''
                        ? clear(slot.pitch, 'chokeGroup')
                        : edit(slot.pitch, { chokeGroup: Number(e.target.value) }))}
                      title="같은 번호를 가진 악기끼리 서로를 끊습니다 — 오픈/클로즈드 하이햇"
                      style={{ ...numStyle, width: 34 }}
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={slot.muted ?? false}
                      onChange={(e) => (e.target.checked
                        ? edit(slot.pitch, { muted: true })
                        : clear(slot.pitch, 'muted'))}
                      title="재생에서만 빠집니다 — 파트의 노트는 그대로 남습니다"
                    />
                  </td>
                  <td className="text-center whitespace-nowrap">
                    {/* A row that is not in the kit has no place in its order
                        yet, so the arrows would silently do nothing. */}
                    {inKit ? (
                      <>
                        <button onClick={() => move(slot.pitch, -1)} style={moveStyle} title="위로">▲</button>
                        <button onClick={() => move(slot.pitch, 1)} style={moveStyle} title="아래로">▼</button>
                      </>
                    ) : <span className="text-[8px]" style={{ color: premium.text.faint }}>킷 밖</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const numStyle: React.CSSProperties = {
  width: 46, height: 18, borderRadius: 3, textAlign: 'center',
  background: premium.surface.well, color: premium.text.primary,
  border: `1px solid ${premium.surface.hairline}`,
  fontFamily: premium.type.mono, fontSize: 9.5, padding: '0 2px',
};

const moveStyle: React.CSSProperties = {
  width: 16, height: 16, borderRadius: 2, marginLeft: 1,
  background: premium.surface.well, color: premium.text.faint,
  border: `1px solid ${premium.surface.hairline}`, fontSize: 7,
};
