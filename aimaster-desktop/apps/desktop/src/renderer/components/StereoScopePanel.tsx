// StereoScopePanel — live stereo correlation + width visualiser.
//
// Reads `StereoScopeFrame` from an analyzer session and renders:
//   • A correlation needle (horizontal, -1..+1, with safety zones)
//   • A width-index bar
//   • A categorical label: Mono Safe / Stereo Balanced / Wide / Phase Risk
//
// The category labels are designed for non-engineers — they translate
// the numeric correlation/MS values into actionable guidance.

import { useMemo } from 'react';
import { useAnalyzerStream } from '../hooks/useAnalyzerStream.js';
import { useAnalyzerSubscriptions } from '../hooks/useAnalyzerSubscriptions.js';
import { SyntheticAnalyzerSessionFactory } from '../audio/analyzer-session-synthetic.js';
import type {
  AnalyzerSession,
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  StereoAggregateFrame,
  StereoScopeFrame,
} from '@aimaster/shared-types/streaming';

export interface StereoScopePanelProps {
  /** Externally-managed session.  Takes precedence over factory. */
  session?: AnalyzerSession | null;
  factory?: AnalyzerSessionFactory;
  sessionOptions?: AnalyzerSessionOptions;
}

type Verdict = {
  label: 'Mono Safe' | 'Stereo Balanced' | 'Wide' | 'Very Wide' | 'Phase Risk';
  description: string;
  /** Tailwind colour class for the label chip. */
  classes: string;
};

/**
 * Categorise a stereo frame for non-engineer consumers.
 *
 * Heuristics:
 *   • correlation < -0.2 → "Phase Risk" (the L-R sum partially cancels)
 *   • correlation > 0.95  → "Mono Safe"
 *   • widthIndex > 1.6    → "Very Wide" (risk on mono fold-down)
 *   • widthIndex > 1.0    → "Wide"
 *   • otherwise           → "Stereo Balanced"
 */
function classify(frame: StereoAggregateFrame): Verdict {
  if (frame.correlation < -0.2) {
    return {
      label: 'Phase Risk',
      description: 'L/R partially cancel. Check phase / monitor in mono.',
      classes: 'bg-red-900/40 text-red-300 border-red-700/50',
    };
  }
  if (frame.correlation > 0.95) {
    return {
      label: 'Mono Safe',
      description: 'L and R are highly correlated — collapses cleanly to mono.',
      classes: 'bg-emerald-900/30 text-emerald-300 border-emerald-700/40',
    };
  }
  if (frame.widthIndex > 1.6) {
    return {
      label: 'Very Wide',
      description: 'Wide stereo image. Some side content may attenuate on mono playback.',
      classes: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
    };
  }
  if (frame.widthIndex > 1.0) {
    return {
      label: 'Wide',
      description: 'Stereo wider than baseline.  No fold-down issues expected.',
      classes: 'bg-sky-900/30 text-sky-300 border-sky-700/40',
    };
  }
  return {
    label: 'Stereo Balanced',
    description: 'Healthy stereo image with safe mono compatibility.',
    classes: 'bg-zinc-700 text-zinc-300 border-zinc-700',
  };
}

const DEFAULT_FACTORY = new SyntheticAnalyzerSessionFactory();
const DEFAULT_OPTIONS: AnalyzerSessionOptions = { sampleRate: 48_000, channels: 2 };

const STUB_FACTORY: AnalyzerSessionFactory = {
  create() {
    return {
      options: { sampleRate: 48_000, channels: 2 },
      isRunning: false,
      async start() {},
      async stop() {},
      onTickSnapshot() { return () => {}; },
      onFullSnapshot() { return () => {}; },
      onFftFrame() { return () => {}; },
      onStereoFrame() { return () => {}; },
      async requestSnapshot() {
        return {
          schema: 'loui.streaming.meter-snapshot.v1' as const,
          sampleRate: 48_000, channels: 2, samplesProcessed: 0,
          integratedLufs: Number.NEGATIVE_INFINITY,
          shortTermLufs: Number.NEGATIVE_INFINITY,
          momentaryLufs: Number.NEGATIVE_INFINITY,
          loudnessRange: 0,
          truePeakDbtp: Number.NEGATIVE_INFINITY,
          samplePeakDb: Number.NEGATIVE_INFINITY,
          rmsDb: Number.NEGATIVE_INFINITY,
          correlation: 1,
          msRatioDb: Number.POSITIVE_INFINITY,
          gatedBlocks: 0,
        };
      },
      async reset() {},
    };
  },
};

function isAggregate(frame: StereoScopeFrame | null): frame is StereoAggregateFrame {
  return frame != null && 'correlation' in frame;
}

export function StereoScopePanel(props: StereoScopePanelProps = {}) {
  const externalSession = props.session;
  const useExternal = externalSession !== undefined;
  const factory = props.factory ?? DEFAULT_FACTORY;
  const sessionOptions = props.sessionOptions ?? DEFAULT_OPTIONS;

  const ownedStream = useAnalyzerStream({
    factory: useExternal ? STUB_FACTORY : factory,
    sessionOptions,
    enableStereo: !useExternal,
  });
  const externalSubs = useAnalyzerSubscriptions(externalSession ?? null, {
    enableStereo: useExternal,
  });
  const stereo: StereoScopeFrame | null = useExternal
    ? externalSubs.stereo
    : ownedStream.stereo;

  const verdict = useMemo(() => {
    if (!isAggregate(stereo)) return null;
    return classify(stereo);
  }, [stereo]);

  // Correlation needle position: -1 .. +1 → 0..1 along the scope width.
  const corr = isAggregate(stereo) ? stereo.correlation : 1;
  const corrFill = (corr + 1) / 2;

  // Width bar: 0..4 → 0..1, with 1.0 as the "balanced" baseline marker.
  const widthIdx = isAggregate(stereo) ? stereo.widthIndex : 1;
  const widthFill = Math.max(0, Math.min(1, widthIdx / 4));
  const baselineFill = 1 / 4;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-800/50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-medium text-zinc-200">Stereo · scope</div>
        {verdict ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider ${verdict.classes}`}
            title={verdict.description}
          >
            {verdict.label}
          </span>
        ) : (
          <span className="text-xs text-zinc-300 font-mono">awaiting frames…</span>
        )}
      </div>

      {/* Correlation bar -1..+1 */}
      <div className="mb-3">
        <div className="mb-0.5 flex justify-between text-[11px] text-zinc-300">
          <span>-1 (anti-phase)</span>
          <span>0</span>
          <span>+1 (mono)</span>
        </div>
        <div className="relative h-3 overflow-hidden rounded-sm bg-zinc-700">
          {/* Phase-risk red band on the left half */}
          <div className="absolute inset-y-0 left-0 w-[40%] bg-red-900/30" />
          {/* Centre tick (zero correlation) */}
          <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600" />
          {/* Correlation needle */}
          <div
            className="absolute inset-y-0 w-1 bg-zinc-100 transition-[left] duration-100 ease-linear"
            style={{ left: `calc(${corrFill * 100}% - 2px)` }}
          />
        </div>
        <div className="mt-0.5 text-right text-xs font-mono tabular-nums text-zinc-300">
          {Number.isFinite(corr) ? corr.toFixed(3) : 'n/a'}
        </div>
      </div>

      {/* Width index bar */}
      <div className="mb-1">
        <div className="mb-0.5 flex justify-between text-[11px] text-zinc-300">
          <span>narrow</span>
          <span className="-translate-x-1/2" style={{ marginLeft: `${baselineFill * 100}%` }}>
            balanced
          </span>
          <span>wide</span>
        </div>
        <div className="relative h-3 overflow-hidden rounded-sm bg-zinc-700">
          {/* Baseline tick at widthIndex=1 (= 25 % since max = 4) */}
          <div
            className="absolute inset-y-0 w-px bg-zinc-600"
            style={{ left: `${baselineFill * 100}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-100 ease-linear"
            style={{ width: `${widthFill * 100}%`, background: '#a78bfa' }}
          />
        </div>
        <div className="mt-0.5 text-right text-xs font-mono tabular-nums text-zinc-300">
          width = {Number.isFinite(widthIdx) ? widthIdx.toFixed(2) : 'n/a'}
        </div>
      </div>

      {/* M/S ratio for engineers — small footer line */}
      {isAggregate(stereo) && (
        <div className="border-t border-zinc-800 pt-2 text-[11px] font-mono tabular-nums text-zinc-300">
          M/S ratio: {Number.isFinite(stereo.msRatioDb) ? `${stereo.msRatioDb.toFixed(2)} dB` : '+∞ (mono)'}
        </div>
      )}
    </div>
  );
}
