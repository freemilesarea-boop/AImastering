// ControlRoomPanel — the monitor section, as a desk has one.
//
// Laid out the way the controls are reached rather than the way they are
// stored: the big level and the three buttons you hit without looking (DIM,
// MONO, MUTE) first, speaker sets next, cues last.
//
// The line at the bottom is not decoration.  A monitor section people do not
// believe is a monitor section people reach past, for the master fader — and
// that is the exact bug the control room exists to prevent.

import React from 'react';
import { useControlRoomStore } from '../../../stores/controlRoomStore.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import {
  MAX_CUES, MAX_LEVEL_DB, MIN_LEVEL_DB, MONITOR_LABELS, NOT_IN_THE_MIX, describeCue,
  describeMonitor, monitorDb, type MonitorSource,
} from '../../../daw/model/control-room.js';
import { premium } from '../../../theme/premium.js';

const SOURCES: MonitorSource[] = ['main', 'alt', 'phones'];

export default function ControlRoomPanel() {
  const s = useControlRoomStore((v) => v.state);
  const cr = useControlRoomStore();
  const closePanel = useWorkspaceStore((v) => v.togglePanel);

  const db = monitorDb(s);

  return (
    <div className="fixed right-2 top-12 z-40 w-[300px] rounded border shadow-2xl"
         style={{
           background: premium.surface.panel, borderColor: premium.surface.hairline,
           fontFamily: premium.type.sans,
         }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b"
           style={{ borderColor: premium.surface.hairline }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>컨트롤 룸</span>
        <span className="text-[9px] truncate" style={{ color: premium.text.faint }}>
          {describeMonitor(s)}
        </span>
        <div className="flex-1" />
        <button onClick={() => closePanel('controlRoom')}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기 (F3)
        </button>
      </div>

      <div className="p-2 space-y-2">
        {/* ── Level ─────────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono tabular-nums"
                  style={{ fontSize: 22, color: s.muted ? premium.accent.danger : premium.text.primary }}>
              {s.muted ? '—' : db.toFixed(1)}
            </span>
            <span className="text-[9px]" style={{ color: premium.text.faint }}>dB</span>
            <div className="flex-1" />
            {s.referenceSpl !== null && (
              <span className="text-[9px]" style={{ color: premium.text.faint }}>
                기준 {s.referenceSpl} dB SPL
              </span>
            )}
          </div>
          <input
            type="range" min={MIN_LEVEL_DB} max={MAX_LEVEL_DB} step={0.5}
            value={s.levelDb}
            onChange={(e) => cr.setLevelDb(Number(e.target.value))}
            className="w-full"
            title="모니터 레벨 — 이 방에서 들리는 크기. 마스터 페이더가 아닙니다"
          />
        </div>

        {/* ── The three you hit without looking ─────────────────────────── */}
        <div className="flex gap-1">
          <Big on={s.dim} onClick={cr.dim} tone="amber"
               title={`DIM — ${s.dimDb} dB 만큼 내립니다. 말할 때 누르고, 놓으면 원래 자리로`}>
            DIM
          </Big>
          <Big on={s.mono} onClick={cr.mono} tone="sky"
               title="MONO — 좌우를 합칩니다. 스테레오 스피커가 완전히 감춰버리는 위상 문제를 잡는 방법">
            MONO
          </Big>
          <Big on={s.muted} onClick={cr.mute} tone="red"
               title="MUTE — 레벨은 그대로 두고 소리만 끕니다">
            MUTE
          </Big>
        </div>

        {/* ── Speaker sets ──────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <span style={labelStyle}>출력</span>
            <span className="text-[8.5px]" style={{ color: premium.text.faint }}>
              세트마다 트림이 따로 있어 전환해도 크기가 그대로입니다
            </span>
          </div>
          <div className="flex gap-1">
            {SOURCES.map((src) => (
              <button
                key={src}
                onClick={() => cr.source(src)}
                title={`${MONITOR_LABELS[src]} 로 전환`}
                className={`flex-1 h-6 rounded text-[9.5px] border ${s.source === src
                  ? 'bg-emerald-600/25 border-emerald-500/50 text-emerald-300'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
              >{MONITOR_LABELS[src]}</button>
            ))}
          </div>
          <label className="flex items-center gap-1 mt-1"
                 style={{ fontSize: 8.5, color: premium.text.faint }}>
            트림
            <input
              type="range" min={-24} max={12} step={0.5}
              value={s.trimDb[s.source] ?? 0}
              onChange={(e) => cr.trim(s.source, Number(e.target.value))}
              className="flex-1"
              title="이 스피커 세트의 보정값 — 페이더 아래에 걸려서, 세트를 바꿔도 방 크기가 유지됩니다"
            />
            <span className="font-mono tabular-nums"
                  style={{ width: 34, textAlign: 'right', color: premium.text.secondary }}>
              {(s.trimDb[s.source] ?? 0).toFixed(1)}
            </span>
          </label>
        </div>

        {/* ── Cues ──────────────────────────────────────────────────────── */}
        <div className="pt-1 border-t" style={{ borderColor: premium.surface.hairline }}>
          <div className="flex items-center gap-1 mb-1">
            <span style={labelStyle}>큐</span>
            <span className="text-[8.5px]" style={{ color: premium.text.faint }}>
              연주자 헤드폰 — 방 볼륨과 무관합니다
            </span>
            <div className="flex-1" />
            <button
              onClick={cr.addCue}
              disabled={s.cues.length >= MAX_CUES}
              title={s.cues.length >= MAX_CUES ? `큐는 ${MAX_CUES}개까지입니다` : '큐 추가'}
              style={{ ...miniStyle, opacity: s.cues.length >= MAX_CUES ? 0.35 : 1 }}
            >+ 큐</button>
          </div>
          {s.cues.map((cue) => (
            <div key={cue.id} className="flex items-center gap-1 mb-1"
                 title={describeCue(cue)}>
              <span className="text-[9px]" style={{ width: 34, color: premium.text.secondary }}>
                {cue.name}
              </span>
              <button
                onClick={() => cr.cue(cue.id, { muted: !cue.muted })}
                style={{
                  ...miniStyle,
                  color: cue.muted ? premium.accent.danger : premium.text.faint,
                }}
              >M</button>
              <input
                type="range" min={MIN_LEVEL_DB} max={MAX_LEVEL_DB} step={0.5}
                value={cue.levelDb}
                onChange={(e) => cr.cue(cue.id, { levelDb: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="text-[9px] font-mono tabular-nums"
                    style={{ width: 34, textAlign: 'right', color: premium.text.secondary }}>
                {cue.levelDb.toFixed(1)}
              </span>
              <button onClick={() => cr.removeCue(cue.id)} style={miniStyle} title="이 큐 제거">×</button>
            </div>
          ))}
        </div>

        <p className="text-[8.5px] leading-snug pt-1 border-t"
           style={{ color: premium.text.faint, borderColor: premium.surface.hairline }}>
          {NOT_IN_THE_MIX}
        </p>
      </div>
    </div>
  );
}

function Big(
  { on, onClick, children, title, tone }: {
    on: boolean; onClick: () => void; children: React.ReactNode;
    title?: string; tone: 'amber' | 'sky' | 'red';
  },
) {
  const colors = {
    amber: ['rgba(220,160,60,0.28)', 'rgba(220,160,60,0.6)', '#e8c88a'],
    sky: ['rgba(90,150,240,0.28)', 'rgba(90,150,240,0.6)', '#a8c8ff'],
    red: ['rgba(200,60,60,0.3)', 'rgba(220,80,80,0.65)', '#f0a0a0'],
  }[tone];
  return (
    <button onClick={onClick} title={title}
      className="flex-1 h-8 rounded border text-[10px] tracking-wider"
      style={{
        background: on ? colors[0] : premium.surface.well,
        borderColor: on ? colors[1] : premium.surface.hairline,
        color: on ? colors[2] : premium.text.muted,
      }}
    >{children}</button>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint,
};

const miniStyle: React.CSSProperties = {
  height: 16, minWidth: 16, padding: '0 5px', borderRadius: 2, fontSize: 8.5,
  background: premium.surface.well, color: premium.text.faint,
  border: `1px solid ${premium.surface.hairline}`,
};
