// MixWindow — the console.
//
// One strip per channel, in console order: inserts → sends → I/O →
// automation mode → group/VCA → pan → solo/mute → fader + meter.  Editing
// anything here writes to the same session the Edit window shows, and the
// mixer engine re-syncs on every change, so a fader move is audible on the
// next block.

import React, { useEffect, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import {
  createBus, createInsert, createSend, removeInsert, removeSend, setInsert, setOutput, setSend,
  updateTrack, findTrack,
} from '../../../daw/model/session-ops.js';
import {
  effectiveFaderDb, setPan, setVolumeDb, toggleMute, toggleSolo, vcaChainDb,
} from '../../../daw/model/mixer-math.js';
import { describePath, computeDelayCompensation, wouldFeedback } from '../../../daw/model/routing.js';
import { PLUGINS, defaultParams, pluginLatencySamples } from '../../../daw/engine/plugins.js';
import { dawRuntime } from '../../../daw/engine/daw-runtime.js';
import type { AutomationMode, DawSession, Track } from '../../../daw/model/types.js';
import { stackDepth, isSummingStack } from '../../../daw/model/stacks.js';
import { activeMacros } from '../../../daw/model/macros.js';
import { premium } from '../../../theme/premium.js';

const VISIBLE_INSERTS = 5;      // A–E, like the top half of a Pro Tools strip
const VISIBLE_SENDS   = 5;

const AUTOMATION_MODES: AutomationMode[] = ['off', 'read', 'touch', 'latch', 'write', 'trim'];

export default function MixWindow() {
  const session = useDawStore((s) => s.session);
  const apply   = useDawStore((s) => s.apply);
  const notify  = useAppStore((s) => s.notify);
  const [levels, setLevels] = useState<Map<string, number>>(new Map());

  // Meter poll — cheap enough at 20 Hz and only while the window is open.
  useEffect(() => {
    const timer = setInterval(() => setLevels(dawRuntime.meterLevels()), 50);
    return () => clearInterval(timer);
  }, []);

  const compensation = computeDelayCompensation(session);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0e0e15] text-zinc-200">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800 bg-[#15151d]">
        <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Mix</span>
        <span className="text-[10px] font-mono text-zinc-600">
          ADC {session.delayCompensation ? 'ON' : 'OFF'} · {compensation.maxSamples} smp
        </span>
        <button
          onClick={() => apply((s) => ({ ...s, delayCompensation: !s.delayCompensation }))}
          className="px-2 py-0.5 rounded text-[10px] border border-zinc-700 bg-zinc-900 text-zinc-400"
        >지연 보정 {session.delayCompensation ? '끄기' : '켜기'}</button>
        <button
          onClick={() => apply((s) => {
            const bus = createBus(`Bus ${s.buses.length + 1}`);
            return { ...s, buses: [...s.buses, bus] };
          })}
          className="px-2 py-0.5 rounded text-[10px] border border-zinc-700 bg-zinc-900 text-zinc-400"
        >+ 버스</button>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-zinc-600">{session.tracks.length} ch</span>
      </div>

      <div className="flex-1 flex overflow-x-auto">
        {session.tracks.map((track) => (
          <ChannelStrip
            key={track.id}
            session={session}
            track={track}
            depth={stackDepth(session, track.id)}
            level={levels.get(track.id) ?? 0}
            compensationSamples={compensation.perTrack.get(track.id) ?? 0}
            onApply={apply}
            onNotify={notify}
            onSmart={() => useDawStore.getState().openSmartControls(track.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelStrip({
  session, track, depth, level, compensationSamples, onApply, onNotify, onSmart,
}: {
  session: DawSession;
  track: Track;
  depth: number;
  level: number;
  compensationSamples: number;
  onApply: (fn: (s: DawSession) => DawSession) => void;
  onNotify: (m: string, t?: 'info' | 'success' | 'warning' | 'error') => void;
  onSmart: () => void;
}) {
  const isMaster = track.kind === 'master';
  const isVca    = track.kind === 'vca';
  const isFolder = track.kind === 'folder';
  const macros   = activeMacros(track.macros);
  const faderDb  = effectiveFaderDb(session, track);
  const vcaDb    = vcaChainDb(session, track);
  const latency  = track.inserts.reduce(
    (sum, i) => sum + (i.bypass ? 0 : pluginLatencySamples(i.pluginId, i.params, session.sampleRate)), 0);

  const stripColor = isMaster ? 'border-red-900/60'
    : isVca ? 'border-amber-900/60'
    : isFolder ? 'border-[rgba(198,167,104,0.4)]'
    : 'border-zinc-800';

  return (
    <div
      className={`w-[124px] shrink-0 border-r ${stripColor} flex flex-col`}
      style={{
        background: isFolder ? 'rgba(198,167,104,0.06)' : '#12121a',
        // Nested stacks are stepped so the hierarchy reads at a glance.
        boxShadow: depth > 0 ? `inset ${depth * 3}px 0 0 rgba(198,167,104,0.25)` : undefined,
      }}
    >
      {/* Smart Controls — the macro layer, always one click away */}
      <button
        onClick={onSmart}
        title="스마트 컨트롤 열기"
        className="mx-1.5 mt-1.5 h-6 rounded flex items-center justify-center gap-1"
        style={{
          border: `1px solid ${macros.length > 0 ? premium.accent.deep : 'rgba(255,255,255,0.10)'}`,
          background: macros.length > 0 ? 'rgba(198,167,104,0.12)' : 'transparent',
          color: macros.length > 0 ? premium.accent.light : premium.text.muted,
          fontFamily: premium.type.sans,
          fontSize: 9,
          letterSpacing: '0.14em',
        }}
      >
        SMART
        {macros.length > 0 && (
          <span style={{ fontFamily: premium.type.mono, opacity: 0.8 }}>{macros.length}</span>
        )}
      </button>
      {macros.length > 0 && (
        <div className="px-1.5 pt-1 flex flex-wrap gap-0.5">
          {macros.slice(0, 4).map(({ macro, value }) => (
            <span
              key={macro.id}
              title={`${macro.name} ${Math.round(value * 100)}%`}
              style={{
                fontFamily: premium.type.mono,
                fontSize: 8,
                padding: '0 3px',
                borderRadius: 3,
                color: premium.accent.light,
                background: 'rgba(198,167,104,0.14)',
              }}
            >{macro.name.slice(0, 3)}{Math.round(value * 100)}</span>
          ))}
        </div>
      )}
      {/* Inserts */}
      <Section label="INSERTS A-E">
        {Array.from({ length: VISIBLE_INSERTS }, (_, slot) => {
          const insert = track.inserts.find((i) => i.slot === slot);
          return (
            <div key={slot} className="flex items-center gap-0.5">
              <select
                value={insert?.pluginId ?? ''}
                onChange={(e) => {
                  const id = e.target.value;
                  onApply((s) => (id
                    ? setInsert(s, track.id, createInsert(slot, id, pluginName(id), {
                        params: defaultParams(id),
                        latencySamples: pluginLatencySamples(id, defaultParams(id), s.sampleRate),
                      }))
                    : removeInsert(s, track.id, slot)));
                }}
                className={`flex-1 min-w-0 h-5 rounded text-[9px] px-1 border bg-zinc-900 ${
                  insert ? (insert.bypass ? 'border-amber-600/50 text-amber-400' : 'border-zinc-600 text-zinc-200')
                         : 'border-zinc-800 text-zinc-600'}`}
              >
                <option value="">—</option>
                {PLUGINS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {insert && (
                <button
                  title="바이패스"
                  onClick={() => onApply((s) => setInsert(s, track.id, { ...insert, bypass: !insert.bypass }))}
                  className={`w-4 h-5 rounded text-[8px] border ${insert.bypass
                    ? 'bg-amber-600/30 border-amber-500/50 text-amber-300'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
                >B</button>
              )}
            </div>
          );
        })}
        {latency > 0 && (
          <p className="text-[8px] font-mono text-amber-500/80">지연 {latency} smp</p>
        )}
      </Section>

      {/* Sends */}
      <Section label="SENDS A-E">
        {Array.from({ length: VISIBLE_SENDS }, (_, slot) => {
          const send = track.sends.find((s) => s.slot === slot);
          return (
            <div key={slot} className="space-y-0.5">
              <div className="flex items-center gap-0.5">
                <select
                  value={send?.target ?? ''}
                  onChange={(e) => {
                    const busId = e.target.value;
                    onApply((s) => (busId
                      ? setSend(s, track.id, createSend(slot, busId, { levelDb: -12 }))
                      : removeSend(s, track.id, slot)));
                  }}
                  className={`flex-1 min-w-0 h-5 rounded text-[9px] px-1 border bg-zinc-900 ${
                    send ? 'border-zinc-600 text-emerald-300' : 'border-zinc-800 text-zinc-600'}`}
                >
                  <option value="">—</option>
                  {session.buses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {send && (
                  <button
                    title={send.preFader ? '프리 페이더' : '포스트 페이더'}
                    onClick={() => onApply((s) => setSend(s, track.id, { ...send, preFader: !send.preFader }))}
                    className={`w-6 h-5 rounded text-[8px] border ${send.preFader
                      ? 'bg-sky-600/30 border-sky-500/50 text-sky-300'
                      : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
                  >{send.preFader ? 'PRE' : 'PST'}</button>
                )}
              </div>
              {send && (
                <input
                  type="range" min={-60} max={12} step={0.5} value={send.levelDb}
                  onChange={(e) => onApply((s) =>
                    setSend(s, track.id, { ...send, levelDb: parseFloat(e.target.value) }))}
                  className="w-full h-1 accent-emerald-500"
                />
              )}
            </div>
          );
        })}
      </Section>

      {/* I/O */}
      <Section label="I/O">
        {!isMaster && !isVca && (
          <select
            value={track.output.kind === 'bus' ? track.output.busId : 'master'}
            onChange={(e) => {
              const value = e.target.value;
              if (value !== 'master' && wouldFeedback(session, track.id, value)) {
                onNotify('피드백 루프가 생겨 라우팅을 취소했습니다', 'error');
                return;
              }
              onApply((s) => setOutput(s, track.id,
                value === 'master' ? { kind: 'master' } : { kind: 'bus', busId: value }));
            }}
            className="w-full h-5 rounded text-[9px] px-1 bg-zinc-900 border border-zinc-700 text-zinc-300"
          >
            <option value="master">Master</option>
            {session.buses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {track.kind === 'aux' && (
          <select
            value={track.input ?? ''}
            onChange={(e) => onApply((s) => updateTrack(s, track.id, (t) => ({
              ...t, input: e.target.value || null,
            })))}
            className="w-full h-5 rounded text-[9px] px-1 bg-zinc-900 border border-zinc-700 text-sky-300"
          >
            <option value="">입력 —</option>
            {session.buses.map((b) => <option key={b.id} value={b.id}>← {b.name}</option>)}
          </select>
        )}
        <p className="text-[8px] font-mono text-zinc-700 truncate" title={describePath(session, track.id)}>
          {describePath(session, track.id)}
        </p>
        {compensationSamples > 0 && (
          <p className="text-[8px] font-mono text-sky-500/80">ADC +{compensationSamples}</p>
        )}
      </Section>

      {/* Automation + group/VCA */}
      <div className="px-1.5 py-1 border-b border-zinc-900 space-y-1">
        <select
          value={track.automation[0]?.mode ?? 'read'}
          onChange={(e) => onApply((s) => updateTrack(s, track.id, (t) => ({
            ...t,
            automation: t.automation.map((l) => ({ ...l, mode: e.target.value as AutomationMode })),
          })))}
          className="w-full h-5 rounded text-[9px] px-1 bg-zinc-900 border border-zinc-700 text-zinc-400"
        >
          {AUTOMATION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <span className="text-[8px] font-mono text-zinc-600 truncate flex-1">
            {session.groups.filter((g) => g.memberIds.includes(track.id)).map((g) => g.symbol).join('') || '—'}
          </span>
          {!isVca && (
            <select
              value={track.vcaId ?? ''}
              onChange={(e) => onApply((s) => updateTrack(s, track.id, (t) => ({
                ...t, vcaId: e.target.value || null,
              })))}
              className="w-[52px] h-5 rounded text-[8px] px-0.5 bg-zinc-900 border border-zinc-700 text-amber-300"
            >
              <option value="">VCA —</option>
              {session.tracks.filter((t) => t.kind === 'vca').map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Pan */}
      {!isVca && (
        <div className="px-1.5 py-1 border-b border-zinc-900">
          <input
            type="range" min={-1} max={1} step={0.01} value={track.pan}
            onChange={(e) => onApply((s) => setPan(s, track.id, parseFloat(e.target.value)))}
            className="w-full h-1 accent-zinc-400"
          />
          <p className="text-[8px] font-mono text-zinc-600 text-center">
            {track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`}
          </p>
        </div>
      )}

      {/* Fader + meter */}
      <div className="flex-1 flex gap-1 px-1.5 py-2 min-h-[150px]">
        <input
          type="range" min={-60} max={12} step={0.1} value={track.volumeDb}
          onChange={(e) => onApply((s) => setVolumeDb(s, track.id, parseFloat(e.target.value)))}
          className="daw-fader accent-zinc-300"
          style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 20, height: '100%' }}
        />
        <Meter level={level} />
        <div className="flex flex-col justify-end gap-1">
          <button
            onClick={() => onApply((s) => toggleSolo(s, track.id))}
            className={`w-5 h-5 rounded text-[9px] border ${track.solo
              ? 'bg-yellow-500/30 border-yellow-500/60 text-yellow-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
          >S</button>
          <button
            onClick={() => onApply((s) => toggleMute(s, track.id))}
            className={`w-5 h-5 rounded text-[9px] border ${track.mute
              ? 'bg-red-600/30 border-red-500/60 text-red-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
          >M</button>
        </div>
      </div>

      {/* Name plate */}
      <div className="px-1.5 py-1 border-t border-zinc-800" style={{ background: `${track.color}22` }}>
        <p
          className="text-[10px] truncate"
          style={{
            color: isFolder ? premium.accent.light : 'rgb(228,228,231)',
            letterSpacing: isFolder ? '0.08em' : undefined,
            fontWeight: isFolder ? 600 : 400,
          }}
          title={isSummingStack(track) ? `${track.name} (합산 스택)` : track.name}
        >{isFolder ? track.name.toUpperCase() : track.name}</p>
        <p className="text-[9px] font-mono text-zinc-500">
          {track.volumeDb >= 0 ? '+' : ''}{track.volumeDb.toFixed(1)}
          {Math.abs(vcaDb) > 0.01 && (
            <span className="text-amber-400"> ({faderDb >= 0 ? '+' : ''}{faderDb.toFixed(1)})</span>
          )}
        </p>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-1.5 py-1 border-b border-zinc-900 space-y-0.5">
      <p className="text-[8px] tracking-[0.12em] text-zinc-600">{label}</p>
      {children}
    </div>
  );
}

/** Post-fader RMS meter with a slow-falling peak hold. */
function Meter({ level }: { level: number }) {
  const holdRef = useRef(0);
  const db = level > 1e-6 ? 20 * Math.log10(level) : -90;
  const pct = Math.max(0, Math.min(1, (db + 60) / 66));
  holdRef.current = Math.max(pct, holdRef.current - 0.01);
  const color = db > -1 ? 'bg-red-500' : db > -8 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="relative w-2 rounded-sm bg-zinc-900 border border-zinc-800 overflow-hidden">
      <div className={`absolute bottom-0 left-0 right-0 ${color}`} style={{ height: `${pct * 100}%` }} />
      <div className="absolute left-0 right-0 h-px bg-zinc-300/70" style={{ bottom: `${holdRef.current * 100}%` }} />
    </div>
  );
}

function pluginName(id: string): string {
  return PLUGINS.find((p) => p.id === id)?.name ?? id;
}

/** Exported for the strip tests. */
export function stripSummary(session: DawSession, trackId: string): string {
  const track = findTrack(session, trackId);
  if (!track) return '';
  return `${track.name} ${effectiveFaderDb(session, track).toFixed(1)}dB`;
}
