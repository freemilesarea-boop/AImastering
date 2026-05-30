/**
 * ABComparePanel — A/B comparison UI.
 *
 *   • Big toggle button (A | B)
 *   • Play / Pause
 *   • "MATCHED LEVEL" indicator showing the BS.1770-4 matched LUFS plus
 *     the per-side trim that was applied
 *   • Position scrubber (read-only)
 *   • Spacebar shortcut: toggle A/B (when the panel is mounted)
 *   • P shortcut: play / pause
 *
 * Pass two AudioBufferLike (or real AudioBuffer) instances and the
 * component will load them, level-match, and let the user audition.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ABPlayer, ABState, ABSide } from '../audio/abPlayer.js';
import type { AudioBufferLike } from '../audio/loudnessCore.js';

interface Props {
  bufferA?: AudioBufferLike | AudioBuffer | null;
  bufferB?: AudioBufferLike | AudioBuffer | null;
  /** Optional labels (defaults: "A", "B"). */
  labelA?:  string;
  labelB?:  string;
  className?: string;
  /** When true, listen for spacebar at the document level.  Default true. */
  spacebarToggle?: boolean;
}

const EMPTY_STATE: ABState = {
  loaded:      false,
  playing:     false,
  active:      'A',
  positionSec: 0,
  durationSec: 0,
  lufsA:       -Infinity,
  lufsB:       -Infinity,
  matchedLufs: -Infinity,
  trimAdb:     0,
  trimBdb:     0,
};

function fmtSec(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}
function fmtLufs(v: number): string {
  return isFinite(v) ? `${v.toFixed(1)} LUFS` : '— LUFS';
}
function fmtTrim(v: number): string {
  if (!isFinite(v) || v === 0) return '0.0 dB';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

export function ABComparePanel(props: Props) {
  const { bufferA, bufferB, labelA = 'A', labelB = 'B', className, spacebarToggle = true } = props;
  const playerRef = useRef<ABPlayer | null>(null);
  const [state, setState] = useState<ABState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Lazy-init the player.
  const getPlayer = (): ABPlayer => {
    if (!playerRef.current) {
      const p = new ABPlayer();
      p.onChange = setState;
      playerRef.current = p;
    }
    return playerRef.current;
  };

  // Load buffers whenever they change.
  useEffect(() => {
    let cancelled = false;
    if (!bufferA || !bufferB) {
      setState(EMPTY_STATE);
      return undefined;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const p = getPlayer();
        await p.setReference(bufferA, bufferB);
        if (!cancelled) setLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [bufferA, bufferB]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  // Position-tick updates while playing — drives the scrubber.
  useEffect(() => {
    if (!state.playing) return undefined;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (p) setState(p.getState());
    }, 100);
    return () => window.clearInterval(id);
  }, [state.playing]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!spacebarToggle) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // Don't hijack typing in inputs / textareas / contenteditables.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        playerRef.current?.toggleAB();
      } else if (e.code === 'KeyP') {
        e.preventDefault();
        const p = playerRef.current;
        if (!p) return;
        if (p.getState().playing) p.pause(); else void p.play();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [spacebarToggle]);

  const onTogglePlay = async (): Promise<void> => {
    const p = getPlayer();
    if (state.playing) p.pause(); else await p.play();
  };
  const onSwitch = (side: ABSide): void => {
    playerRef.current?.setActive(side);
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const aActive = state.active === 'A';
  const bActive = state.active === 'B';
  const matched = isFinite(state.matchedLufs);
  const progressPct = state.durationSec > 0
    ? Math.max(0, Math.min(100, (state.positionSec / state.durationSec) * 100))
    : 0;

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 ${className ?? ''}`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          A / B Compare
        </h3>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500">
          {matched && (
            <span className="rounded border border-emerald-700/40 bg-emerald-900/30 px-2 py-0.5 text-emerald-300">
              MATCHED LEVEL · {fmtLufs(state.matchedLufs)}
            </span>
          )}
          <span className="hidden md:inline">space → switch · p → play</span>
        </div>
      </div>

      {/* Big A / B toggle */}
      <div className="mb-4 grid grid-cols-2 gap-2 select-none">
        <button
          onClick={() => onSwitch('A')}
          disabled={!state.loaded}
          className={`relative h-24 rounded-lg border-2 text-2xl font-bold tracking-widest transition-all
            ${aActive
              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.25)]'
              : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400'}
            ${!state.loaded && 'cursor-not-allowed opacity-40'}`}
        >
          {labelA}
          {aActive && (
            <span className="absolute bottom-1.5 left-0 right-0 text-[9px] font-normal tracking-wider text-emerald-400/80">
              ◉ ACTIVE
            </span>
          )}
          <span className="absolute top-1.5 right-2 text-[9px] font-normal text-zinc-500 tabular-nums">
            {fmtTrim(state.trimAdb)}
          </span>
        </button>

        <button
          onClick={() => onSwitch('B')}
          disabled={!state.loaded}
          className={`relative h-24 rounded-lg border-2 text-2xl font-bold tracking-widest transition-all
            ${bActive
              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.25)]'
              : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400'}
            ${!state.loaded && 'cursor-not-allowed opacity-40'}`}
        >
          {labelB}
          {bActive && (
            <span className="absolute bottom-1.5 left-0 right-0 text-[9px] font-normal tracking-wider text-emerald-400/80">
              ◉ ACTIVE
            </span>
          )}
          <span className="absolute top-1.5 right-2 text-[9px] font-normal text-zinc-500 tabular-nums">
            {fmtTrim(state.trimBdb)}
          </span>
        </button>
      </div>

      {/* Transport row */}
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() => void onTogglePlay()}
          disabled={!state.loaded}
          className={`flex h-9 w-20 items-center justify-center rounded-md border border-zinc-700
                      bg-zinc-800/60 text-xs font-medium uppercase tracking-wider text-zinc-200
                      hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {state.playing ? '■ Pause' : '▶ Play'}
        </button>

        {/* Position scrubber (read-only — click to seek) */}
        <div
          className="relative h-2 flex-1 cursor-pointer rounded-full bg-zinc-800"
          onClick={(e) => {
            if (!state.loaded || !state.durationSec) return;
            const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const ratio = (e.clientX - r.left) / r.width;
            void playerRef.current?.seek(state.durationSec * ratio);
          }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/70 transition-[width] duration-100"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <span className="w-24 text-right text-[10px] tabular-nums text-zinc-400">
          {fmtSec(state.positionSec)} / {fmtSec(state.durationSec)}
        </span>
      </div>

      {/* Per-side LUFS readout */}
      <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
        <div className="flex justify-between border-t border-zinc-800/70 pt-2">
          <span>{labelA} raw</span>
          <span className="tabular-nums">{fmtLufs(state.lufsA)}</span>
        </div>
        <div className="flex justify-between border-t border-zinc-800/70 pt-2">
          <span>{labelB} raw</span>
          <span className="tabular-nums">{fmtLufs(state.lufsB)}</span>
        </div>
      </div>

      {loading && (
        <div className="mt-3 text-[10px] text-zinc-500">측정 중… (BS.1770-4 integrated)</div>
      )}
      {error && (
        <div className="mt-3 rounded border border-red-700/50 bg-red-900/30 px-2 py-1 text-[10px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

export default ABComparePanel;
