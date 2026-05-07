/**
 * LoudnessMeterPanel — real-time BS.1770-4 LUFS + True-Peak readout.
 *
 * Shows three loudness windows (Momentary 400 ms / Short-term 3 s /
 * Integrated whole-program) plus dBTP True-Peak.  Updates every 100 ms
 * via the LoudnessStream wrapper around the AudioWorklet.
 *
 * Use either:
 *   <LoudnessMeterPanel mediaElement={audioRef.current} active={isPlaying} />
 *   <LoudnessMeterPanel mediaStream={stream}            active={true}    />
 *
 * The component handles its own AudioContext lifecycle — when `active`
 * goes false (or it unmounts) it tears the graph down cleanly.
 */
import React, { useEffect, useRef, useState } from 'react';
import { LoudnessStream, LiveLoudnessMetrics } from '../audio/loudnessStream.js';
import { reportFailure } from '../utils/reportFailure.js';

interface Props {
  mediaElement?: HTMLMediaElement | null;
  mediaStream?:  MediaStream | null;
  active:        boolean;
  className?:    string;
  // Optional integrated-loudness target (e.g., -14 for streaming).  If set,
  // the integrated readout is colour-coded against ±1 LU of the target.
  targetLufs?:   number;
}

const LUFS_RANGE = { min: -50, max: 0 };          // bar range
const TP_RANGE   = { min: -30, max: 3 };

function fmtLufs(v: number): string {
  if (!isFinite(v)) return '— LUFS';
  return `${v.toFixed(1)} LUFS`;
}
function fmtDbtp(v: number): string {
  if (!isFinite(v)) return '— dBTP';
  return `${v.toFixed(1)} dBTP`;
}
function pct(v: number, lo: number, hi: number): number {
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

function Bar({
  label, value, lo, hi, format, color,
}: {
  label: string;
  value: number;
  lo: number;
  hi: number;
  format: (v: number) => string;
  color: string;
}) {
  const w = pct(value, lo, hi);
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-14 shrink-0 text-zinc-400 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden border border-zinc-700/40">
        <div
          className={`h-full transition-[width] duration-100 ${color}`}
          style={{ width: `${w}%` }}
        />
      </div>
      <span className="w-20 text-right tabular-nums text-zinc-200">
        {format(value)}
      </span>
    </div>
  );
}

export function LoudnessMeterPanel(props: Props) {
  const { mediaElement, mediaStream, active, className, targetLufs } = props;
  const streamRef = useRef<LoudnessStream | null>(null);
  const [m, setM] = useState<LiveLoudnessMetrics>({
    momentaryLufs:  -Infinity,
    shortTermLufs:  -Infinity,
    integratedLufs: -Infinity,
    truePeakDbtp:   -Infinity,
    perChannelTpDb: [],
    durationSec:    0,
    blocksAnalyzed: 0,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!mediaElement && !mediaStream) return;

    let cancelled = false;
    const s = new LoudnessStream();
    streamRef.current = s;
    s.onMetrics = (live) => { if (!cancelled) setM(live); };

    (async () => {
      try {
        if (mediaElement)     await s.attachMediaElement(mediaElement);
        else if (mediaStream) await s.attachMediaStream(mediaStream);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setError(msg);
        // Worklet load / AudioContext / addModule failures land here.
        // Surface to the support-bundle ring with a tight category so a
        // diagnostic export tells us the meter — not the mastering
        // pipeline — was the failure point.
        reportFailure({
          category: 'worklet',
          message:  `LoudnessMeterPanel attach failed: ${msg}`,
          data:     { hasMediaElement: !!mediaElement, hasMediaStream: !!mediaStream },
        });
      }
    })();

    return () => {
      cancelled = true;
      void s.close();
      streamRef.current = null;
    };
  }, [active, mediaElement, mediaStream]);

  // Colour for the M/S/I bars.  Green if reasonable, amber if hot, red if clipping.
  const lufsColor = (v: number): string => {
    if (!isFinite(v))   return 'bg-zinc-700';
    if (v > -1)         return 'bg-red-500';
    if (v > -6)         return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const tpColor = (v: number): string => {
    if (!isFinite(v))   return 'bg-zinc-700';
    if (v >  -1)        return 'bg-red-500';
    if (v >  -3)        return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  // Integrated colour vs target tolerance.
  const intColor = (() => {
    if (typeof targetLufs !== 'number' || !isFinite(m.integratedLufs)) return lufsColor(m.integratedLufs);
    const d = Math.abs(m.integratedLufs - targetLufs);
    if (d <= 0.5) return 'bg-emerald-500';
    if (d <= 1.0) return 'bg-amber-500';
    return 'bg-red-500';
  })();

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 ${className ?? ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Loudness · BS.1770-4
        </h3>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {m.durationSec > 0 ? `${m.durationSec.toFixed(1)} s · ${m.blocksAnalyzed} blk` : 'idle'}
        </span>
      </div>

      <div className="space-y-2">
        <Bar label="M"
             value={m.momentaryLufs}
             lo={LUFS_RANGE.min} hi={LUFS_RANGE.max}
             format={fmtLufs}
             color={lufsColor(m.momentaryLufs)} />
        <Bar label="S"
             value={m.shortTermLufs}
             lo={LUFS_RANGE.min} hi={LUFS_RANGE.max}
             format={fmtLufs}
             color={lufsColor(m.shortTermLufs)} />
        <Bar label="I"
             value={m.integratedLufs}
             lo={LUFS_RANGE.min} hi={LUFS_RANGE.max}
             format={fmtLufs}
             color={intColor} />
        <Bar label="TP"
             value={m.truePeakDbtp}
             lo={TP_RANGE.min} hi={TP_RANGE.max}
             format={fmtDbtp}
             color={tpColor(m.truePeakDbtp)} />
      </div>

      {/* Per-channel TP — only render when there's data and >1 ch */}
      {m.perChannelTpDb.length > 1 && (
        <div className="mt-3 border-t border-zinc-800 pt-2 text-[10px] text-zinc-400">
          <span className="mr-2 uppercase tracking-wider">Per-ch TP</span>
          {m.perChannelTpDb.map((v, i) => (
            <span key={i} className="mr-3 tabular-nums">
              ch{i}: {isFinite(v) ? `${v.toFixed(1)}` : '—'} dBTP
            </span>
          ))}
        </div>
      )}

      {typeof targetLufs === 'number' && isFinite(m.integratedLufs) && (
        <div className="mt-2 text-[10px] text-zinc-500">
          target {targetLufs.toFixed(1)} LUFS · Δ {(m.integratedLufs - targetLufs).toFixed(2)} LU
        </div>
      )}

      {error && (
        <div className="mt-2 rounded border border-red-700/50 bg-red-900/30 px-2 py-1 text-[10px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

export default LoudnessMeterPanel;
