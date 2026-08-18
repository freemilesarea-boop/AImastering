/**
 * MixerStrip — one vertical channel of the console.
 *
 * The strip a console has always had, in the order it has always had it:
 * name, instrument, inserts, pan, mute/solo, then the fader with its meter
 * beside it and the level under it. Engineers read a console by position;
 * moving the fader somewhere clever would make it slower to use, not
 * faster.
 *
 * The fader is a rotated range input rather than a custom drag surface. It
 * keeps the keyboard (arrows, page-up), the accessibility name and the
 * pointer capture that a hand-rolled one has to reimplement badly — and it
 * is the same control the horizontal mixer used, so the two cannot drift.
 */

import React from 'react';

export interface MixerStripProps {
  name: string;
  /** Instrument label under the name. */
  role: string;
  color: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** False when mute or another channel's solo silences this one. */
  audible: boolean;
  selected: boolean;
  /** Modules engaged on this channel, newest first. */
  inserts: string[];
  /** 0..1 of the meter's range, or null when nothing is playing. */
  level: number | null;
  onSelect: () => void;
  onGain: (db: number) => void;
  onPan: (v: number) => void;
  onMute: () => void;
  onSolo: () => void;
  onOpenInserts: () => void;
}

const MIN_DB = -60;
const MAX_DB = 12;

/**
 * Where a dB value sits on the fader, 0..1.
 *
 * Not linear in dB: a console fader gives most of its travel to the region
 * around unity, where mixing decisions are made, and compresses the bottom,
 * where the difference between -40 and -50 does not matter. This is the
 * standard shape — a power curve — rather than a table of stops.
 */
export function faderPosition(db: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, Number.isFinite(db) ? db : 0));
  const norm = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
  return Math.pow(norm, 0.55);
}

export function faderDb(position: number): number {
  const p = Math.max(0, Math.min(1, position));
  return MIN_DB + Math.pow(p, 1 / 0.55) * (MAX_DB - MIN_DB);
}

function meterColor(level: number): string {
  if (level > 0.92) return '#f87171';
  if (level > 0.78) return '#fbbf24';
  return '#34d399';
}

export default function MixerStrip(props: MixerStripProps): React.ReactElement {
  const {
    name, role, color, gainDb, pan, mute, solo, audible, selected,
    inserts, level, onSelect, onGain, onPan, onMute, onSolo, onOpenInserts,
  } = props;

  const pos = faderPosition(gainDb);

  return (
    <div
      onClick={onSelect}
      className={`w-[88px] shrink-0 h-full flex flex-col border-r border-black/40 cursor-pointer
                  ${selected ? 'bg-zinc-800/60' : 'bg-zinc-900/40 hover:bg-zinc-900/70'}`}
    >
      {/* Colour tab — how a console tells channels apart at a glance. */}
      <div className="h-1 shrink-0" style={{ background: audible ? color : '#3f3f46' }} />

      <div className="px-2 pt-1.5 pb-1 border-b border-black/30">
        <div className="text-[10px] text-zinc-200 truncate leading-tight" title={name}>{name}</div>
        <div className="text-[9px] text-zinc-500 truncate leading-tight">{role}</div>
      </div>

      {/* Inserts — the rack, as a console shows it. */}
      <button
        onClick={(e) => { e.stopPropagation(); onOpenInserts(); }}
        className="mx-1.5 mt-1.5 mb-1 px-1.5 py-1 rounded-sm border border-zinc-700/70 text-left
                   hover:border-zinc-500 transition-colors"
        title="이 채널의 모듈을 스튜디오에서 편집합니다"
      >
        <div className="text-[8px] uppercase tracking-wider text-zinc-600 mb-0.5">Inserts</div>
        {inserts.length === 0 ? (
          <div className="text-[9px] text-zinc-700">—</div>
        ) : (
          inserts.slice(0, 3).map((ins) => (
            <div key={ins} className="text-[9px] text-zinc-400 truncate leading-tight">{ins}</div>
          ))
        )}
        {inserts.length > 3 && (
          <div className="text-[9px] text-zinc-600">+{inserts.length - 3}</div>
        )}
      </button>

      {/* Pan */}
      <div className="px-1.5 pb-1">
        <input
          type="range" min={-1} max={1} step={0.02}
          value={pan}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onPan(Number(e.target.value))}
          className="w-full accent-zinc-500 h-1"
          aria-label={`${name} 팬`}
        />
        <div className="text-[9px] font-mono text-zinc-600 text-center tabular-nums">
          {pan === 0 ? 'C' : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`}
        </div>
      </div>

      {/* Mute / solo */}
      <div className="flex gap-1 px-1.5 pb-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onMute(); }}
          className={`flex-1 text-[9px] py-0.5 rounded-sm border transition-colors ${
            mute ? 'bg-red-500/25 border-red-500/60 text-red-300'
                 : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'}`}
        >M</button>
        <button
          onClick={(e) => { e.stopPropagation(); onSolo(); }}
          className={`flex-1 text-[9px] py-0.5 rounded-sm border transition-colors ${
            solo ? 'bg-amber-400/25 border-amber-400/60 text-amber-300'
                 : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'}`}
        >S</button>
      </div>

      {/* Fader + meter */}
      <div className="flex-1 flex items-stretch gap-1.5 px-2 pb-1 min-h-0">
        <div className="flex-1 relative flex items-center justify-center">
          {/* The track the cap rides in. */}
          <div className="absolute inset-y-1 w-[3px] rounded-full bg-black/60" />
          <input
            type="range" min={0} max={1} step={0.001}
            value={pos}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onGain(Math.round(faderDb(Number(e.target.value)) * 10) / 10)}
            aria-label={`${name} 페이더`}
            className="daw-fader"
          />
          {/* Unity mark: the one position on a fader that has a name. */}
          <div
            className="absolute left-0 right-0 h-px bg-zinc-600/70 pointer-events-none"
            style={{ bottom: `${faderPosition(0) * 100}%` }}
          />
        </div>

        <div className="w-2 rounded-sm bg-black/60 relative overflow-hidden">
          {level !== null && (
            <div
              className="absolute bottom-0 left-0 right-0 transition-[height] duration-75"
              style={{ height: `${Math.max(0, Math.min(1, level)) * 100}%`, background: meterColor(level) }}
            />
          )}
        </div>
      </div>

      <div className="px-1.5 pb-1.5 text-center">
        <span className="text-[10px] font-mono text-zinc-400 tabular-nums">
          {gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)}
        </span>
      </div>
    </div>
  );
}
