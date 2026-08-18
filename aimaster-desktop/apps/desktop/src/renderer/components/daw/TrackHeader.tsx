/**
 * TrackHeader — the left column of the arrange window.
 *
 * One row per track, aligned to its lane, carrying only what has to be
 * reachable without opening anything: the name, what the track is, mute and
 * solo, and a trim. Everything else lives on the console strip below or in
 * the inspector — a header that tried to be a channel strip would push the
 * arrange window off the screen, which is the opposite of what it is for.
 */

import React from 'react';

export interface TrackHeaderProps {
  name: string;
  role: string;
  /** The instrument's accent — the spine, and the selected row's edge. */
  color: string;
  /** A wash of the same colour, so a selected row reads as that instrument. */
  tint?: string;
  /** Label ink that stays readable on `tint`. */
  ink?: string;
  gainDb: number;
  mute: boolean;
  solo: boolean;
  audible: boolean;
  selected: boolean;
  height: number;
  /** 'ready' | 'analyzing' | 'error' — shown as the status dot. */
  status: string;
  /** Set when the classifier disagreed with itself, or the stem is empty. */
  warning?: string | undefined;
  onSelect: () => void;
  onGain: (db: number) => void;
  onMute: () => void;
  onSolo: () => void;
  onRemove: () => void;
}

export default function TrackHeader(props: TrackHeaderProps): React.ReactElement {
  const {
    name, role, color, tint, ink, gainDb, mute, solo, audible, selected, height,
    status, warning, onSelect, onGain, onMute, onSolo, onRemove,
  } = props;

  const dot =
    status === 'error' ? 'bg-red-600'
      : status === 'analyzing' ? 'bg-amber-500 animate-pulse'
      : status === 'pending' ? 'bg-slate-400'
      : warning ? 'bg-amber-500'
      : 'bg-emerald-600';

  return (
    <div
      onClick={onSelect}
      style={{
        height,
        // The selected row wears its instrument's colour rather than a
        // generic grey: on a console of twenty channels, "which one am I
        // editing" and "what is it" are the same question.
        ...(selected && tint ? { background: tint } : {}),
      }}
      className={`shrink-0 flex border-b border-slate-200 cursor-pointer select-none
                  ${selected ? '' : 'bg-white hover:bg-slate-50'}`}
    >
      {/* Colour spine, matching the clip in the lane. A muted track keeps a
          grey one: the instrument has not changed, but it is not being
          heard, and the lane says so the same way. */}
      <div
        className="shrink-0"
        style={{ width: selected ? 4 : 3, background: audible ? color : '#cbd5e1' }}
      />

      <div className="flex-1 min-w-0 px-2 py-1.5 flex flex-col justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} title={warning ?? status} />
          <span
            className="text-[11px] truncate"
            style={{ color: selected && ink ? ink : undefined }}
            title={name}
          >{name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="ml-auto text-slate-500 hover:text-red-600 text-[11px] leading-none shrink-0"
            title="트랙 제거"
          >✕</button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onMute(); }}
            className={`w-5 text-[9px] rounded-sm border leading-4 transition-colors ${
              mute ? 'bg-red-100 border-red-400 text-red-700'
                   : 'border-slate-300 text-slate-600 hover:text-slate-700'}`}
          >M</button>
          <button
            onClick={(e) => { e.stopPropagation(); onSolo(); }}
            className={`w-5 text-[9px] rounded-sm border leading-4 transition-colors ${
              solo ? 'bg-amber-100 border-amber-500 text-amber-800'
                   : 'border-slate-300 text-slate-600 hover:text-slate-700'}`}
          >S</button>

          <input
            type="range" min={-30} max={12} step={0.5}
            value={gainDb}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onGain(Number(e.target.value))}
            className="daw-mini flex-1 min-w-0"
            aria-label={`${name} 트림`}
          />
          <span className="text-[9px] font-mono text-slate-600 tabular-nums w-8 text-right">
            {gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)}
          </span>
        </div>

        {/* The instrument, in the instrument's own colour — the row's
            colour and its name say the same thing, so a glance at either
            works. */}
        <div className="text-[9px] truncate" style={{ color: ink ?? undefined }}>{role}</div>
      </div>
    </div>
  );
}
