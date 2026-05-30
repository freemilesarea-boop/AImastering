/**
 * PreviewPanel — fast-iteration audition UI.
 *
 *   <PreviewPanel
 *      buffer={inputBuffer}
 *      mode="BALANCED"           // or pass a custom process fn
 *      startTime={45}            // seconds from start of buffer
 *      onStartTimeChange={...}
 *   />
 *
 * Behaviour:
 *   • Slices a 5-second window starting at `startTime`.
 *   • Runs it through processMasteringWithMode(slice, mode).
 *   • Loops the processed slice via PreviewPlayer.
 *   • When `mode` or `startTime` changes, re-processes and HOT-SWAPS
 *     into the running loop with a 5 ms crossfade — no playback gap.
 *
 * Shows a scrub slider (start time within the source buffer), a
 * play/stop toggle, the loop duration, and the wall-clock processing
 * time of the most recent slice (dev metric, sub-second on any
 * modern machine).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  PreviewPlayer,
  PreviewPlayerState,
  startPreview,
  PreviewSegmentOptions,
} from '../audio/previewPlayer.js';
import {
  MasteringMode,
  processMasteringWithMode,
} from '../audio/masteringModes.js';
import type { AudioBufferLike } from '../audio/loudnessCore.js';

interface Props {
  buffer:        AudioBufferLike | null;
  mode?:         MasteringMode;
  /** Free-form processor.  If provided, takes precedence over `mode`. */
  process?:      (slice: AudioBufferLike) => AudioBufferLike;
  startTime:     number;
  onStartTimeChange?: (sec: number) => void;
  durationSec?:  number;
  className?:    string;
  autoPlay?:     boolean;        // default true
}

const EMPTY_STATE: PreviewPlayerState = {
  loaded: false, playing: false, loopDurationSec: 0, lastProcessMs: 0,
};

function fmtSec(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function PreviewPanel(props: Props) {
  const {
    buffer, mode = 'BALANCED', process, startTime,
    onStartTimeChange, durationSec = 5, className, autoPlay = true,
  } = props;

  const playerRef = useRef<PreviewPlayer | null>(null);
  const [state, setState] = useState<PreviewPlayerState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);

  const totalSec = buffer ? buffer.getChannelData(0).length / buffer.sampleRate : 0;

  const ensurePlayer = (): PreviewPlayer => {
    if (!playerRef.current) {
      const p = new PreviewPlayer();
      p.onChange = setState;
      playerRef.current = p;
    }
    return playerRef.current;
  };

  // Re-process whenever buffer / mode / process / startTime changes.
  useEffect(() => {
    if (!buffer) return undefined;
    if (!autoPlay && !playerRef.current?.getState().playing) return undefined;

    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const opts: PreviewSegmentOptions = { durationSec };
        if (process) {
          opts.process = process;
        } else {
          opts.process = (slice) => processMasteringWithMode(slice, mode).buffer;
        }
        await startPreview(ensurePlayer(), buffer, startTime, opts);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, mode, process, startTime, durationSec]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  const onTogglePlay = async (): Promise<void> => {
    if (!buffer) return;
    const p = ensurePlayer();
    if (state.playing) {
      p.stop();
    } else {
      const opts: PreviewSegmentOptions = { durationSec };
      if (process) opts.process = process;
      else         opts.process = (slice) => processMasteringWithMode(slice, mode).buffer;
      await startPreview(p, buffer, startTime, opts);
    }
  };

  const sliceEnd = Math.min(totalSec, startTime + durationSec);

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 ${className ?? ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Preview · {durationSec}s loop
        </h3>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {state.loaded
            ? `${state.loopDurationSec.toFixed(1)}s loop · ${state.lastProcessMs.toFixed(0)} ms render`
            : 'idle'}
        </span>
      </div>

      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() => void onTogglePlay()}
          disabled={!buffer}
          className="flex h-9 w-24 items-center justify-center rounded-md border border-zinc-700
                     bg-zinc-800/60 text-xs font-medium uppercase tracking-wider text-zinc-200
                     hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.playing ? '■ Stop' : '▶ Play'}
        </button>
        {state.playing && (
          <span className="rounded border border-emerald-700/40 bg-emerald-900/30 px-2 py-0.5 text-[10px] text-emerald-300">
            ⟲ LOOPING
          </span>
        )}
      </div>

      {/* Position slider — selects the start of the 5-second window */}
      <div className="mb-1 flex items-center gap-3">
        <span className="w-14 text-[10px] tabular-nums text-zinc-500">{fmtSec(startTime)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, totalSec - durationSec)}
          step={0.1}
          value={startTime}
          onChange={(e) => onStartTimeChange?.(parseFloat(e.target.value))}
          disabled={!buffer || !onStartTimeChange}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-800
                     accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span className="w-14 text-right text-[10px] tabular-nums text-zinc-500">{fmtSec(totalSec)}</span>
      </div>
      <p className="text-[10px] text-zinc-500">
        Window: {fmtSec(startTime)} → {fmtSec(sliceEnd)}
      </p>

      {error && (
        <div className="mt-3 rounded border border-red-700/50 bg-red-900/30 px-2 py-1 text-[10px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

export default PreviewPanel;
