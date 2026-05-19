// LoudnessMeterPanelV2 — analyzer-stream-backed loudness meter.
//
// Replacement for `LoudnessMeterPanel` that consumes a generic
// `AnalyzerSession` (via `useAnalyzerStream`) instead of binding directly
// to `loudnessProcessor.worklet.js`.  Same on-screen layout / colors so
// existing styles port across; the data source is swappable.
//
// Sources:
//   - Today: `SyntheticAnalyzerSessionFactory` (dev only)
//   - M3:    `WasmAnalyzerSessionFactory` (production)
//   - Future N-API: `NapiAnalyzerSessionFactory` (file-render preview)
//
// Goal of this commit (M3 entry prep): prove the React + analyzer
// stream + UI render path works end to end.  Not yet wired into any page.

import { useMemo } from 'react';
import { useAnalyzerStream } from '../hooks/useAnalyzerStream.js';
import { SyntheticAnalyzerSessionFactory } from '../audio/analyzer-session-synthetic.js';
import type {
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
} from '@aimaster/shared-types/streaming';

export interface LoudnessMeterPanelV2Props {
  /**
   * Factory to source the analyzer from.  Default = synthetic (dev).
   * Production wiring passes the WASM/N-API factory.
   */
  factory?: AnalyzerSessionFactory;
  /** Analyzer session options.  Defaults to stereo 48 k. */
  sessionOptions?: AnalyzerSessionOptions;
  /** Subscription rate for tick snapshots (UI refresh). */
  tickRate?: '60Hz' | '30Hz' | '10Hz';
}

/** Helper: format a dB value to 1 decimal place, or '−∞' for silence. */
function fmtDb(v: number): string {
  if (!Number.isFinite(v)) return v < 0 ? '−∞' : 'n/a';
  return v.toFixed(1);
}

/** Helper: clamp + scale dB value to a 0..1 bar fill. */
function dbToBar(v: number, minDb: number, maxDb: number): number {
  if (!Number.isFinite(v)) return v < 0 ? 0 : 1;
  const t = (v - minDb) / (maxDb - minDb);
  return Math.max(0, Math.min(1, t));
}

/** Loudness-grade colour stops (matches LUFS streaming targets). */
function lufsColour(v: number): string {
  if (!Number.isFinite(v)) return '#3f3f46';
  if (v > -10) return '#ef4444';   // hot
  if (v > -14) return '#f59e0b';   // warm
  if (v > -23) return '#10b981';   // green band
  return '#3b82f6';                // cool
}

const DEFAULT_FACTORY = new SyntheticAnalyzerSessionFactory();
const DEFAULT_OPTIONS: AnalyzerSessionOptions = { sampleRate: 48_000, channels: 2 };

/** Live LUFS / TP / RMS meter driven by an AnalyzerSession stream. */
export function LoudnessMeterPanelV2(props: LoudnessMeterPanelV2Props = {}) {
  const factory = props.factory ?? DEFAULT_FACTORY;
  const sessionOptions = props.sessionOptions ?? DEFAULT_OPTIONS;
  const tickRate = props.tickRate ?? '30Hz';

  const { tick, isRunning } = useAnalyzerStream({
    factory,
    sessionOptions,
    tickRate,
  });

  const rows = useMemo(() => {
    if (!tick) return null;
    return [
      { key: 'momentary',  label: 'Momentary',  value: tick.momentaryLufs, unit: 'LUFS', minDb: -36, maxDb: 0 },
      { key: 'shortTerm',  label: 'Short-term', value: tick.shortTermLufs, unit: 'LUFS', minDb: -36, maxDb: 0 },
      { key: 'truePeak',   label: 'True peak',  value: tick.truePeakDbtp,  unit: 'dBTP', minDb: -24, maxDb: 0 },
      { key: 'samplePeak', label: 'Sample peak',value: tick.samplePeakDb,  unit: 'dBFS', minDb: -24, maxDb: 0 },
      { key: 'rms',        label: 'RMS',        value: tick.rmsDb,         unit: 'dBFS', minDb: -36, maxDb: 0 },
    ];
  }, [tick]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-sm font-medium text-zinc-200">Loudness · stream</div>
        <div className="text-xs text-zinc-500 font-mono tabular-nums">
          {isRunning ? `${tickRate} · ${(tick?.samplesProcessed ?? 0).toLocaleString()} sm` : 'starting…'}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5">
        {rows?.map((r) => {
          const fill = dbToBar(r.value, r.minDb, r.maxDb);
          const colour = r.key.includes('Peak') ? '#a78bfa' : lufsColour(r.value);
          return (
            <div key={r.key} className="flex items-center gap-3 text-xs">
              <div className="w-24 shrink-0 text-zinc-400">{r.label}</div>
              <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-zinc-800">
                <div
                  className="absolute inset-y-0 left-0 transition-[width] duration-100 ease-linear"
                  style={{ width: `${fill * 100}%`, background: colour }}
                />
              </div>
              <div className="w-20 shrink-0 text-right font-mono tabular-nums text-zinc-200">
                {fmtDb(r.value)} <span className="text-zinc-500">{r.unit}</span>
              </div>
            </div>
          );
        })}
      </div>

      {tick && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-zinc-800 pt-3 text-xs font-mono tabular-nums">
          <div className="flex justify-between">
            <span className="text-zinc-500">correlation</span>
            <span className="text-zinc-200">{tick.correlation.toFixed(3)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">M/S ratio</span>
            <span className="text-zinc-200">{fmtDb(tick.msRatioDb)} dB</span>
          </div>
        </div>
      )}
    </div>
  );
}
