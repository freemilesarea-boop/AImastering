// SessionViewGrid — clips in a grid, fired live, then printed to the timeline.
//
// Rows are tracks and columns are scenes, matching how the idea is usually
// sketched.  A cell with a clip can be launched; the launch waits for the
// next musical boundary and the cell shows QUEUED until it does.
//
// The bottom bar is the part that matters most: an ordered plan of scenes,
// and one button that turns the jam into real clips on the arrangement — at
// which point every other editor in this app can work on it.

import React, { useEffect, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { trackClips } from '../../../daw/model/session-ops.js';
import {
  addScene, advance, barSeconds, clearSlot, convertToArrangement, defaultPlan,
  describePlan, isPlaying, isQueued, queueScene, queueSlot, queueStop,
  removeScene, setSlotClip, slotAt, stopAll, EMPTY_LAUNCH,
  type ArrangeStep, type LaunchState,
} from '../../../daw/model/session-view.js';
import { dawRuntime } from '../../../daw/engine/daw-runtime.js';
import { premium } from '../../../theme/premium.js';

const CELL_WIDTH = 132;
const ROW_HEIGHT = 44;
const NAME_WIDTH = 150;

export default function SessionViewGrid() {
  const session = useDawStore((s) => s.session);
  const apply   = useDawStore((s) => s.apply);
  const notify  = useAppStore((s) => s.notify);
  const [launch, setLaunch] = useState<LaunchState>(EMPTY_LAUNCH);
  const [plan, setPlan] = useState<ArrangeStep[]>([]);

  const grid = session.sessionGrid;
  const barSec = barSeconds(session);
  const tracks = useMemo(
    () => session.tracks.filter((t) => t.kind === 'audio' || t.kind === 'instrument'),
    [session.tracks],
  );

  // Apply queued launches as the Session clock crosses their boundary.
  useEffect(() => {
    dawRuntime.startSessionClock(barSec);
    const timer = setInterval(() => {
      setLaunch((state) => {
        if (state.queued.length === 0) return state;
        const result = advance(state, grid, dawRuntime.sessionBar());
        for (const slot of result.started) {
          if (slot.clip) dawRuntime.startSlot(session, slot.trackId, slot.clip, slot.loop);
        }
        for (const trackId of result.stopped) dawRuntime.stopSlot(trackId);
        return result.state;
      });
    }, 40);
    return () => clearInterval(timer);
  }, [grid, session, barSec]);

  useEffect(() => () => { dawRuntime.stopAllSlots(); }, []);

  const writeGrid = (next: typeof grid): void => {
    apply((s) => ({ ...s, sessionGrid: next }));
  };

  const fire = (slotId: string): void => {
    dawRuntime.ensure(session.sampleRate);
    dawRuntime.startSessionClock(barSec);
    setLaunch((state) => queueSlot(state, grid, slotId, dawRuntime.sessionBar()));
  };

  const currentPlan = plan.length > 0 ? plan : defaultPlan(session, grid);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: premium.surface.abyss }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Session View
        </span>
        <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.faint }}>
          {session.tempoBpm} BPM · {session.timeSignature[0]}/{session.timeSignature[1]}
        </span>
        <div className="flex-1" />
        <Action onClick={() => writeGrid(addScene(grid))}>+ 씬</Action>
        <Action onClick={() => {
          setLaunch((state) => stopAll(state, dawRuntime.sessionBar()));
          dawRuntime.stopAllSlots();
          setLaunch(EMPTY_LAUNCH);
        }}>■ 전체 정지</Action>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <div style={{ minWidth: NAME_WIDTH + grid.scenes.length * CELL_WIDTH }}>
          {/* Scene header */}
          <div className="flex sticky top-0 z-10" style={{ background: premium.surface.panel }}>
            <div style={{ width: NAME_WIDTH }} className="shrink-0" />
            {grid.scenes.map((scene, index) => (
              <div key={scene.id} style={{ width: CELL_WIDTH }}
                   className="shrink-0 px-1.5 py-1.5 flex items-center gap-1">
                <button
                  onClick={() => {
                    dawRuntime.ensure(session.sampleRate);
                    dawRuntime.startSessionClock(barSec);
                    setLaunch((state) => queueScene(state, grid, index, dawRuntime.sessionBar()));
                  }}
                  title="씬 전체 실행"
                  className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    border: `1px solid ${launch.lastScene === index ? premium.accent.base : premium.surface.hairlineStrong}`,
                    color: launch.lastScene === index ? premium.accent.base : premium.text.muted,
                    fontSize: 9,
                  }}
                >▶</button>
                <span className="truncate" style={{
                  fontFamily: premium.type.sans, fontSize: 11,
                  color: premium.text.secondary, letterSpacing: '0.06em',
                }}>{scene.name}</span>
                <button
                  onClick={() => writeGrid(removeScene(grid, index))}
                  title="씬 삭제"
                  style={{ color: premium.text.faint, fontSize: 11, background: 'none', border: 'none' }}
                >✕</button>
              </div>
            ))}
          </div>

          {/* Rows */}
          {tracks.map((track) => (
            <div key={track.id} className="flex"
                 style={{ borderTop: `1px solid ${premium.surface.hairline}` }}>
              <div style={{ width: NAME_WIDTH, height: ROW_HEIGHT }}
                   className="shrink-0 px-2 flex items-center gap-1.5">
                <span className="w-1.5 h-4 rounded-sm shrink-0" style={{ background: track.color }} />
                <span className="truncate flex-1" style={{
                  fontFamily: premium.type.sans, fontSize: 11, color: premium.text.secondary,
                }}>{track.name}</span>
                <button
                  onClick={() => {
                    setLaunch((state) => queueStop(state, track.id, dawRuntime.sessionBar()));
                    dawRuntime.stopSlot(track.id);
                  }}
                  title="이 트랙 정지"
                  className="w-4 h-4 rounded-sm shrink-0"
                  style={{
                    border: `1px solid ${premium.surface.hairlineStrong}`,
                    color: premium.text.faint, fontSize: 8, lineHeight: 1,
                  }}
                >■</button>
              </div>

              {grid.scenes.map((scene, index) => {
                const slot = slotAt(grid, track.id, index);
                const playing = slot ? isPlaying(launch, slot) : false;
                const queued = slot ? isQueued(launch, slot) : false;
                const timeline = trackClips(track);
                return (
                  <div key={scene.id} style={{ width: CELL_WIDTH, height: ROW_HEIGHT }}
                       className="shrink-0 p-1">
                    {slot?.clip ? (
                      <button
                        onClick={() => fire(slot.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          writeGrid(clearSlot(grid, track.id, index));
                        }}
                        title={`${slot.clip.name} — 클릭하면 다음 마디에 실행, 우클릭 삭제`}
                        className="w-full h-full rounded px-1.5 flex items-center gap-1"
                        style={{
                          background: playing ? 'rgba(198,167,104,0.22)'
                            : queued ? 'rgba(110,155,214,0.18)'
                            : `${track.color}22`,
                          border: `1px solid ${playing ? premium.accent.base
                            : queued ? premium.accent.cool
                            : premium.surface.hairlineStrong}`,
                        }}
                      >
                        <span style={{
                          fontSize: 8,
                          color: playing ? premium.accent.base : premium.text.muted,
                        }}>{playing ? '▶' : queued ? '◷' : '●'}</span>
                        <span className="truncate" style={{
                          fontFamily: premium.type.sans, fontSize: 10, color: premium.text.secondary,
                        }}>{slot.clip.name}</span>
                      </button>
                    ) : (
                      <select
                        value=""
                        onChange={(e) => {
                          const clip = timeline.find((c) => c.id === e.target.value);
                          if (clip) writeGrid(setSlotClip(grid, track.id, index, { ...clip, startSec: 0 }));
                        }}
                        title="타임라인 클립을 이 슬롯에 넣기"
                        className="w-full h-full rounded px-1"
                        style={{
                          background: 'transparent',
                          border: `1px dashed ${premium.surface.hairline}`,
                          color: premium.text.faint,
                          fontFamily: premium.type.sans, fontSize: 9,
                        }}
                      >
                        <option value="">비어 있음</option>
                        {timeline.map((clip) => (
                          <option key={clip.id} value={clip.id}>{clip.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {tracks.length === 0 && (
            <p className="px-4 py-6" style={{
              fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted,
            }}>오디오 또는 인스트루먼트 트랙을 먼저 만드세요.</p>
          )}
        </div>
      </div>

      {/* Convert to Arrangement */}
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap"
           style={{ borderTop: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{
          fontFamily: premium.type.display, fontSize: 14, fontStyle: 'italic',
          color: premium.accent.light,
        }}>Arrangement 로 변환</span>

        <div className="flex items-center gap-1.5 flex-wrap">
          {currentPlan.map((step, i) => (
            <label key={`${step.sceneIndex}-${i}`} className="flex items-center gap-1"
                   style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
              <span>{grid.scenes[step.sceneIndex]?.name ?? '?'}</span>
              <input
                type="number" min={1} max={64} value={step.bars}
                onChange={(e) => {
                  const bars = Math.max(1, parseInt(e.target.value, 10) || 1);
                  const next = currentPlan.map((s, j) => (j === i ? { ...s, bars } : s));
                  setPlan(next);
                }}
                style={{
                  width: 42, height: 22, borderRadius: 5,
                  background: premium.surface.well,
                  border: `1px solid ${premium.surface.hairlineStrong}`,
                  color: premium.text.secondary, fontFamily: premium.type.mono,
                  fontSize: 10, textAlign: 'center',
                }}
              />
              <span style={{ color: premium.text.faint }}>마디</span>
            </label>
          ))}
        </div>

        <div className="flex-1" />
        <span className="truncate" style={{
          fontFamily: premium.type.mono, fontSize: 9, color: premium.text.faint, maxWidth: 280,
        }}>{describePlan(grid, currentPlan)}</span>

        <Action onClick={() => {
          if (currentPlan.length === 0) { notify('먼저 씬을 만드세요', 'warning'); return; }
          apply((s) => convertToArrangement(s, s.sessionGrid, currentPlan, { fill: true }));
          useDawStore.getState().setWindow('edit');
          notify(`${describePlan(grid, currentPlan)} → 타임라인에 배치했습니다`, 'success');
        }}>타임라인에 펼치기</Action>
        <Action onClick={() => {
          apply((s) => convertToArrangement(s, s.sessionGrid, currentPlan, { fill: true, replace: true }));
          useDawStore.getState().setWindow('edit');
          notify('타임라인을 새 배열로 교체했습니다', 'success');
        }}>교체</Action>
      </div>
    </div>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 10px', borderRadius: 8,
        border: `1px solid ${premium.surface.hairlineStrong}`,
        background: 'transparent', color: premium.text.secondary,
        fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.08em',
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}
