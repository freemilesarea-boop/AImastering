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
  color: string;
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
    name, role, color, gainDb, mute, solo, audible, selected, height,
    status, warning, onSelect, onGain, onMute, onSolo, onRemove,
  } = props;

  const dot =
    status === 'error' ? 'bg-red-500'
      : status === 'analyzing' ? 'bg-amber-400 animate-pulse'
      : status === 'pending' ? 'bg-zinc-600'
      : warning ? 'bg-amber-400'
      : 'bg-emerald-500';

  return (
    <div
      onClick={onSelect}
      style={{ height }}
      className={`shrink-0 flex border-b border-black/50 cursor-pointer select-none
                  ${selected ? 'bg-zinc-800/70' : 'bg-zinc-900/60 hover:bg-zinc-900'}`}
    >
      {/* Colour spine, matching the clip in the lane. */}
      <div className="w-1 shrink-0" style={{ background: audible ? color : '#3f3f46' }} />

      <div className="flex-1 min-w-0 px-2 py-1.5 flex flex-col justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} title={warning ?? status} />
          <span className="text-[11px] text-zinc-200 truncate" title={name}>{name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="ml-auto text-zinc-700 hover:text-red-400 text-[11px] leading-none shrink-0"
            title="트랙 제거"
          >✕</button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onMute(); }}
            className={`w-5 text-[9px] rounded-sm border leading-4 transition-colors ${
              mute ? 'bg-red-500/25 border-red-500/60 text-red-300'
                   : 'border-zinc-700 text-zinc-600 hover:text-zinc-300'}`}
          >M</button>
          <button
            onClick={(e) => { e.stopPropagation(); onSolo(); }}
            className={`w-5 text-[9px] rounded-sm border leading-4 transition-colors ${
              solo ? 'bg-amber-400/25 border-amber-400/60 text-amber-300'
                   : 'border-zinc-700 text-zinc-600 hover:text-zinc-300'}`}
          >S</button>

          <input
            type="range" min={-30} max={12} step={0.5}
            value={gainDb}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onGain(Number(e.target.value))}
            className="daw-mini flex-1 min-w-0"
            aria-label={`${name} 트림`}
          />
          <span className="text-[9px] font-mono text-zinc-600 tabular-nums w-8 text-right">
            {gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)}
          </span>
        </div>

        <div className="text-[9px] text-zinc-600 truncate">{role}</div>
      </div>
    </div>
  );
}
