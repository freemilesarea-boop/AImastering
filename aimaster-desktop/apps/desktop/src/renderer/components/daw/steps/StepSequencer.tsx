// StepSequencer — the channel rack.
//
// A drum part is a yes/no decision per step per instrument, and a grid of
// buttons answers that about forty times faster than dragging rectangles does.
// So the grid is the whole interface, and everything that makes a grid
// musical is one click away from a step rather than buried in a dialog:
//
//   click            toggle
//   right-click drag velocity
//   alt-click        ratchet (a roll inside one step)
//   shift-click      probability
//
// The bottom half is the pattern library.  A pattern placed on the timeline is
// a LINK: fix a note here and it is fixed in every placement.

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import {
  GM_DRUM_MAP, addChannel, clearChannel, createPattern as createStepPattern, euclidFill,
  describePattern as describeSteps, patternBeats, removeChannel, resizePattern,
  rotateChannel, setStep, stepsToNotes, toggleStep, type StepPattern,
} from '../../../daw/model/step-sequencer.js';
import {
  addPattern, createPattern, describePattern, findPattern, patternClip,
  patternUsage, removePattern, unlinkClip,
} from '../../../daw/model/patterns.js';
import {
  addTrack, createMidiPart, createTrack, updateClips,
} from '../../../daw/model/session-ops.js';
import { premium } from '../../../theme/premium.js';
import type { DawSession } from '../../../daw/model/types.js';
import { beatsToSecAt, partClock } from '../../../daw/model/note-time.js';
import { tempoMapOf } from '../../../daw/model/tempo-map.js';

const CELL = 26;

export default function StepSequencer() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addPitch, setAddPitch] = useState(GM_DRUM_MAP[4]?.pitch ?? 46);

  const grids = session.stepPatterns ?? [];
  const grid = useMemo(
    () => grids.find((g) => g.id === activeId) ?? grids[0] ?? null,
    [grids, activeId]);

  const writeGrid = useCallback((fn: (g: StepPattern) => StepPattern) => {
    if (!grid) return;
    apply((s) => ({
      ...s,
      stepPatterns: (s.stepPatterns ?? []).map((g) => (g.id === grid.id ? fn(g) : g)),
    }));
  }, [apply, grid]);

  const newGrid = (): void => {
    const created = createStepPattern(`Beat ${grids.length + 1}`);
    apply((s) => ({ ...s, stepPatterns: [...(s.stepPatterns ?? []), created] }));
    setActiveId(created.id);
  };

  /** The grid becomes a pattern in the library — one copy, many placements. */
  const commitToLibrary = (): void => {
    if (!grid) return;
    const notes = stepsToNotes(grid, { ignoreProbability: false });
    if (notes.length === 0) { notify('스텝을 먼저 찍으세요', 'warning'); return; }
    // The grid is in beats; the pattern's box is in seconds, measured at the
    // playhead where it will actually be placed.
    const clock = partClock(tempoMapOf(session), 0);
    const pattern = createPattern(
      grid.name, notes, beatsToSecAt(clock, patternBeats(grid)),
      session.tempoBpm, (session.patterns ?? []).length);
    apply((s) => addPattern(s, pattern));
    notify(`${pattern.name} 패턴으로 저장 — 배치하면 링크됩니다`, 'success');
  };

  /** Place a pattern at the play head, on a drum track (made if needed). */
  const place = (patternId: string): void => {
    const pattern = findPattern(session, patternId);
    if (!pattern) return;
    apply((s) => {
      let next = s;
      let track = next.tracks.find((t) => t.kind === 'instrument' && t.name === 'Drums');
      if (!track) {
        track = createTrack('Drums', 'instrument');
        next = addTrack(next, track);
      }
      const base = createMidiPart(pattern.name, {});
      const placement = { ...base, ...patternClip(pattern, playheadSec, next.tempoBpm) };
      const id = track.id;
      return updateClips(next, id, (clips) => [...clips, placement]);
    });
    notify(`${pattern.name} 배치 (${playheadSec.toFixed(2)}s)`, 'success');
  };

  if (!grid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4"
           style={{ background: premium.surface.abyss }}>
        <p style={{ fontFamily: premium.type.display, fontSize: 22, color: premium.accent.light }}>
          Channel Rack
        </p>
        <p style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>
          스텝 그리드로 드럼을 찍고, 패턴으로 저장해 타임라인에 배치합니다.
        </p>
        <button onClick={newGrid} style={primaryButton}>그리드 만들기</button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: premium.surface.abyss }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 flex-wrap"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Channel Rack
        </span>
        <select value={grid.id} onChange={(e) => setActiveId(e.target.value)} style={selectStyle}>
          {grids.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button onClick={newGrid} style={button}>+ 그리드</button>

        <span className="w-px h-5 mx-1" style={{ background: premium.surface.hairline }} />

        <label style={labelStyle}>
          STEPS
          <select value={grid.stepCount}
                  onChange={(e) => writeGrid((g) => resizePattern(g, Number(e.target.value)))}
                  style={selectStyle}>
            {[8, 16, 32, 64].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          SWING
          <input type="range" min={0} max={0.75} step={0.05} value={grid.swing}
                 onChange={(e) => writeGrid((g) => ({ ...g, swing: Number(e.target.value) }))}
                 style={{ width: 80, accentColor: premium.accent.base }} />
          <span style={{ fontFamily: premium.type.mono, fontSize: 10, width: 28 }}>
            {(grid.swing * 100).toFixed(0)}%
          </span>
        </label>

        <div className="flex-1" />
        <button onClick={commitToLibrary} style={primaryButton}>패턴으로 저장</button>
      </div>

      {/* Grid */}
      <div className="p-4 overflow-auto">
        <div className="flex items-center gap-1 mb-1" style={{ marginLeft: 168 }}>
          {Array.from({ length: grid.stepCount }, (_, i) => (
            <span key={i} style={{
              width: CELL, textAlign: 'center', fontFamily: premium.type.mono, fontSize: 8,
              color: i % 4 === 0 ? premium.accent.base : premium.text.faint,
            }}>{i % 4 === 0 ? i / 4 + 1 : '·'}</span>
          ))}
        </div>

        {grid.channels.map((channel) => (
          <div key={channel.id} className="flex items-center gap-1 mb-1">
            <div className="flex items-center gap-1 shrink-0" style={{ width: 164 }}>
              <button
                onClick={() => writeGrid((g) => ({
                  ...g,
                  channels: g.channels.map((c) => (c.id === channel.id ? { ...c, muted: !c.muted } : c)),
                }))}
                title="뮤트"
                style={{
                  ...miniButton,
                  color: channel.muted ? premium.accent.danger : premium.text.muted,
                }}>{channel.muted ? '✕' : '●'}</button>
              <span className="truncate" style={{
                flex: 1, fontFamily: premium.type.sans, fontSize: 11,
                color: channel.muted ? premium.text.faint : premium.text.secondary,
              }} title={`MIDI ${channel.pitch}`}>{channel.name}</span>
              <button onClick={() => writeGrid((g) => rotateChannel(g, channel.id, -1))}
                      title="왼쪽으로 회전" style={miniButton}>‹</button>
              <button onClick={() => writeGrid((g) => rotateChannel(g, channel.id, 1))}
                      title="오른쪽으로 회전" style={miniButton}>›</button>
              <button onClick={() => {
                const hits = Number(prompt('유클리드 히트 수', '4') ?? '');
                if (Number.isFinite(hits)) writeGrid((g) => euclidFill(g, channel.id, hits));
              }} title="유클리드 채우기 — 히트를 고르게 분배" style={miniButton}>E</button>
              <button onClick={() => writeGrid((g) => clearChannel(g, channel.id))}
                      title="비우기" style={miniButton}>⌫</button>
              <button onClick={() => writeGrid((g) => removeChannel(g, channel.id))}
                      title="채널 삭제" style={miniButton}>−</button>
            </div>

            {channel.steps.map((step, i) => {
              const beat = i % 4 === 0;
              return (
                <button
                  key={i}
                  onClick={(e) => {
                    if (e.altKey) {
                      writeGrid((g) => setStep(g, channel.id, i, {
                        on: true, ratchet: (step.ratchet % 4) + 1,
                      }));
                    } else if (e.shiftKey) {
                      writeGrid((g) => setStep(g, channel.id, i, {
                        on: true, probability: step.probability > 0.9 ? 0.5 : 1,
                      }));
                    } else {
                      writeGrid((g) => toggleStep(g, channel.id, i));
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const next = step.velocity > 0.8 ? 0.5 : step.velocity > 0.45 ? 0.25 : 1;
                    writeGrid((g) => setStep(g, channel.id, i, { on: true, velocity: next }));
                  }}
                  title={`${i + 1} · vel ${(step.velocity * 127).toFixed(0)}`
                    + `${step.ratchet > 1 ? ` · ratchet ×${step.ratchet}` : ''}`
                    + `${step.probability < 1 ? ` · ${(step.probability * 100).toFixed(0)}%` : ''}`}
                  style={{
                    width: CELL, height: CELL, borderRadius: 3, position: 'relative',
                    background: step.on
                      ? `rgba(198,167,104,${0.35 + step.velocity * 0.6})`
                      : beat ? premium.surface.overlay : premium.surface.well,
                    border: `1px solid ${step.on ? premium.accent.deep : premium.surface.hairline}`,
                    color: premium.text.onAccent, fontSize: 8, lineHeight: 1,
                  }}
                >
                  {step.on && step.ratchet > 1 && (
                    <span style={{ position: 'absolute', top: 1, right: 2 }}>{step.ratchet}</span>
                  )}
                  {step.on && step.probability < 1 && (
                    <span style={{ position: 'absolute', bottom: 1, left: 2 }}>?</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        <div className="flex items-center gap-2 mt-2">
          <select value={addPitch} onChange={(e) => setAddPitch(Number(e.target.value))} style={selectStyle}>
            {GM_DRUM_MAP.map((d) => <option key={d.pitch} value={d.pitch}>{d.name}</option>)}
          </select>
          <button onClick={() => {
            const entry = GM_DRUM_MAP.find((d) => d.pitch === addPitch);
            writeGrid((g) => addChannel(g, entry?.name ?? `Note ${addPitch}`, addPitch));
          }} style={button}>+ 채널</button>
          <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.faint }}>
            {describeSteps(grid)}
          </span>
        </div>

        <p style={{ ...hint, marginTop: 8 }}>
          클릭 = on/off · 우클릭 = 벨로시티 · Alt+클릭 = 래칫(한 스텝 안의 롤) · Shift+클릭 = 확률
        </p>
      </div>

      <PatternLibrary session={session} onPlace={place} />
    </div>
  );
}

function PatternLibrary(
  { session, onPlace }: { session: DawSession; onPlace: (id: string) => void },
) {
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const patterns = session.patterns ?? [];

  return (
    <div className="px-4 pb-6">
      <div style={{
        fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light,
        borderBottom: `1px solid ${premium.surface.engrave}`, paddingBottom: 4, marginBottom: 6,
      }}>Patterns</div>

      {patterns.length === 0 && (
        <p style={hint}>
          아직 패턴이 없습니다. 그리드를 찍고 <b>패턴으로 저장</b>을 누르세요.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {patterns.map((pattern) => {
          const uses = patternUsage(session, pattern.id);
          return (
            <div key={pattern.id} style={{
              width: 250, padding: '8px 10px', borderRadius: 5,
              background: premium.surface.frame, backgroundImage: premium.gradient.frame,
              border: `1px solid ${premium.surface.hairline}`,
              borderLeft: `3px solid ${pattern.color}`,
            }}>
              <div style={{
                fontFamily: premium.type.sans, fontSize: 12, color: premium.text.primary,
              }}>{pattern.name}</div>
              <div style={{
                fontFamily: premium.type.mono, fontSize: 10, color: premium.text.muted, margin: '2px 0 6px',
              }}>{describePattern(session, pattern)}</div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => onPlace(pattern.id)} style={miniAction}>배치</button>
                <button
                  onClick={() => {
                    if (uses.length === 0) { notify('배치된 곳이 없습니다', 'warning'); return; }
                    const last = uses[uses.length - 1]!;
                    apply((s) => unlinkClip(s, last.trackId, last.clipId));
                    notify('마지막 배치를 링크 해제했습니다 — 이제 따로 편집됩니다');
                  }}
                  title="마지막 배치를 독립 복사본으로"
                  style={miniAction}>링크 해제</button>
                <button
                  onClick={() => {
                    apply((s) => removePattern(s, pattern.id));
                    notify('패턴 삭제 — 배치된 클립은 노트를 그대로 유지합니다');
                  }}
                  title="삭제 — 배치된 클립은 노트를 잃지 않습니다"
                  style={miniAction}>삭제</button>
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ ...hint, marginTop: 8 }}>
        배치는 <b>링크</b>입니다. 어느 하나를 고치면 전부 고쳐집니다. 하나만 달라져야 하면
        링크를 해제하세요.
      </p>
    </div>
  );
}

const hint: React.CSSProperties = {
  fontFamily: premium.type.sans, fontSize: 10.5, lineHeight: 1.5, color: premium.text.muted,
};
const selectStyle: React.CSSProperties = {
  height: 24, borderRadius: 3, fontSize: 10, marginLeft: 4,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`,
};
const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
  fontFamily: premium.type.sans, fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint,
};
const button: React.CSSProperties = {
  height: 24, padding: '0 10px', borderRadius: 3,
  fontFamily: premium.type.sans, fontSize: 10.5, color: premium.text.secondary,
  background: premium.surface.well, border: `1px solid ${premium.surface.hairline}`,
};
const primaryButton: React.CSSProperties = {
  ...button, color: premium.text.onAccent,
  background: premium.accent.base, border: `1px solid ${premium.accent.deep}`,
};
const miniButton: React.CSSProperties = {
  width: 16, height: 18, borderRadius: 2, fontSize: 9,
  background: 'transparent', color: premium.text.muted, border: 'none',
};
const miniAction: React.CSSProperties = {
  height: 20, padding: '0 8px', borderRadius: 3,
  fontFamily: premium.type.sans, fontSize: 10, color: premium.text.secondary,
  background: premium.surface.well, border: `1px solid ${premium.surface.hairline}`,
};
