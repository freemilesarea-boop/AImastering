// LouiAudioDebugPanel — always-visible audio status + in-app event log +
// forced DSP test buttons.  Surfaces the real state of the audio pipeline
// (so "it silently does nothing" can be diagnosed on-screen, not just in
// the console) and lets a tester force extreme DSP configs to confirm the
// parameter → graph → sound path end-to-end.

import React from 'react';
import { surface, text, typography, space, radius, meter as meterTokens } from '../../theme/loui-theme.js';
import {
  getAudioLog, subscribeAudioLog, sharedContextState, resumeSharedContext,
  currentRouteLabel, currentRouteKind, logAudioEvent, dumpGraph,
  type AudioGraphEvent,
} from '../../audio/shared-audio-graph.js';
import { useMediaElement } from '../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../hooks/useNativeAnalyzer.js';
import { useModuleParameters } from '../../audio/parameters/useModuleParameterState.js';

export interface LouiAudioDebugPanelProps {
  realtimeStatus: string;     // off/unavailable/waiting/starting/passthrough/active/bypassed/failed
  realtimeActive: boolean;
  avgProcessMs: number;
  xruns: number;
  /** DSP worklet processed-block count (proves the chain is being pulled). */
  dspBlocks: number;
  /** Coded reason the WASM realtime path is not active (worklet load phase). */
  fallbackReason?: string | null;
  /** Worklet load phase + last error message (precise FAILED diagnosis). */
  loadPhase?: string | null;
  loadError?: string | null;
  /** Re-run the WASM worklet attach. */
  onReattach?: () => void;
  lastError?: string | null;
}

function useAudioLog(): readonly AudioGraphEvent[] {
  const [, force] = React.useState(0);
  React.useEffect(() => subscribeAudioLog(() => force((n) => n + 1)), []);
  return getAudioLog();
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 70 }}>
      <span style={{ fontFamily: typography.family.mono, fontSize: 9, color: text.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontFamily: typography.family.mono, fontSize: 12, color: tone ?? text.primary, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function TestButton({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: typography.family.mono, fontSize: 11, padding: '5px 9px',
        background: active ? meterTokens.warn.background : surface.well,
        color: active ? meterTokens.warn.foreground : text.secondary,
        border: `1px solid ${active ? meterTokens.warn.foreground : surface.border}`,
        borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

const EVENT_TONE: Partial<Record<AudioGraphEvent['kind'], string>> = {
  'worklet-error': '#f87171', 'error': '#f87171', 'context-resume-failed': '#f87171',
  'fallback-activated': '#fbbf24',
  'dsp-chain-connected': '#34d399', 'native-analyzer-connected': '#34d399',
  'wasm-analyzer-connected': '#34d399', 'context-resumed': '#34d399',
};

export function LouiAudioDebugPanel(props: LouiAudioDebugPanelProps) {
  const media = useMediaElement();
  const native = useNativeAnalyzer(media);
  const eq = useModuleParameters('eq');
  const imager = useModuleParameters('imager');
  const dyn = useModuleParameters('dynamics');
  const lim = useModuleParameters('limiter');
  const log = useAudioLog();
  const [bypassed, setBypassed] = React.useState(false);

  const analyzerLabel = props.dspBlocks > 0 ? 'WASM'
    : native.status === 'connected' ? 'NATIVE'
    : native.status === 'error' ? 'FAILED' : 'OFF';
  const ctxState = sharedContextState();

  // Truthful composite processing status from the ACTUAL audio route +
  // whether audio is flowing — never claim FAILED while native DSP processes.
  const route = currentRouteKind(media);
  const flowing = native.lastFrameAt != null && (performance.now() - native.lastFrameAt) < 800;
  const processStatus =
    route === 'wasm' && props.dspBlocks > 0 ? 'WASM ACTIVE'
    : route === 'fallback' && flowing ? 'FALLBACK ACTIVE'
    : route === 'fallback' ? 'FALLBACK (idle)'
    : route === 'direct' ? 'DIRECT ONLY'
    : 'FAILED';
  const psTone = processStatus.startsWith('WASM') ? meterTokens.safe.foreground
    : processStatus.startsWith('FALLBACK ACTIVE') ? meterTokens.safe.foreground
    : processStatus.startsWith('FALLBACK') ? meterTokens.warn.foreground
    : processStatus === 'DIRECT ONLY' ? meterTokens.warn.foreground
    : meterTokens.danger.foreground;

  // Forced test: apply a param, then log the rendered RMS before/after so the
  // user SEES the change land in the actual audio (not just the knob value).
  const applyAndProve = (module: string, key: string, value: number, set: (v: number) => void) => {
    const before = native.meters.rmsDb;
    const beforePeak = Math.max(native.meters.peakLDb, native.meters.peakRDb);
    logAudioEvent('param-updated', `${module}.${key} = ${value} | route=${route} rmsBefore=${before.toFixed(1)}dB`);
    set(value);
    window.setTimeout(() => {
      const after = native.meters.rmsDb;
      const afterPeak = Math.max(native.meters.peakLDb, native.meters.peakRDb);
      logAudioEvent('config-posted', `${module}.${key}=${value} applied | rms ${before.toFixed(1)}→${after.toFixed(1)}dB peak ${beforePeak.toFixed(1)}→${afterPeak.toFixed(1)}dB`);
    }, 450);
  };

  const toggleBypass = () => {
    const next = !bypassed;
    setBypassed(next);
    logAudioEvent('param-updated', `bypass(all) = ${next} | route=${route}`);
    eq.setBypass(next); dyn.setBypass(next); imager.setBypass(next); lim.setBypass(next);
  };

  const recent = log.slice(-30);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      background: surface.panel, border: `1px solid ${surface.border}`, borderRadius: radius.panel,
      padding: space['3'],
    }}>
      {/* Status row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['3'] }}>
        <StatusCell label="Processing" value={processStatus} tone={psTone} />
        <StatusCell label="Realtime(WASM)" value={props.realtimeStatus.toUpperCase()} tone={props.realtimeStatus === 'active' ? meterTokens.safe.foreground : props.realtimeStatus === 'failed' ? meterTokens.danger.foreground : text.muted} />
        <StatusCell label="Analyzer" value={analyzerLabel} tone={analyzerLabel === 'FAILED' ? meterTokens.danger.foreground : analyzerLabel === 'OFF' ? text.muted : meterTokens.safe.foreground} />
        <StatusCell label="Context" value={ctxState} tone={ctxState === 'running' ? meterTokens.safe.foreground : ctxState === 'suspended' ? meterTokens.warn.foreground : text.muted} />
        <StatusCell label="DSP blk" value={String(props.dspBlocks)} />
        <StatusCell label="Native" value={String(native.frameCount)} />
        <StatusCell label="Avg ms" value={props.avgProcessMs.toFixed(2)} />
        <StatusCell label="Xruns" value={String(props.xruns)} tone={props.xruns > 0 ? meterTokens.warn.foreground : text.primary} />
      </div>
      <div style={{ fontFamily: typography.family.mono, fontSize: 10, color: text.tertiary }}>
        route: {currentRouteLabel(media)}
      </div>
      {(props.lastError || native.error || props.fallbackReason || props.loadError) && (
        <div style={{ fontFamily: typography.family.mono, fontSize: 11, color: meterTokens.danger.foreground, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {props.fallbackReason && <span>realtime reason: {props.fallbackReason}{props.loadPhase ? ` (phase: ${props.loadPhase})` : ''}</span>}
          {props.loadError && <span>worklet load error: {props.loadError}</span>}
          {(props.lastError || native.error) && <span>last error: {props.lastError || native.error}</span>}
        </div>
      )}

      {/* Forced DSP tests — prove parameter → graph → sound */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <TestButton label="EQ +24dB Air" onClick={() => applyAndProve('eq', 'airDb', 24, (v) => eq.setParam('airDb', v))} />
        <TestButton label="EQ -24dB Air" onClick={() => applyAndProve('eq', 'airDb', -24, (v) => eq.setParam('airDb', v))} />
        <TestButton label="Output -24dB" onClick={() => applyAndProve('eq', 'outputGainDb', -24, (v) => eq.setParam('outputGainDb', v))} />
        <TestButton label="Mono (width 0%)" onClick={() => applyAndProve('imager', 'widthPct', 0, (v) => imager.setParam('widthPct', v))} />
        <TestButton label="Wide 200%" onClick={() => applyAndProve('imager', 'widthPct', 200, (v) => imager.setParam('widthPct', v))} />
        <TestButton label={bypassed ? 'Bypass: ON' : 'Bypass: OFF'} active={bypassed} onClick={toggleBypass} />
        <TestButton label="Resume Ctx" onClick={() => void resumeSharedContext()} />
        <TestButton label="Dump Graph" onClick={() => dumpGraph(media)} />
        {props.onReattach && <TestButton label="Reinit Worklet" onClick={props.onReattach} />}
      </div>

      {/* In-app event log (last 30) */}
      <div style={{
        maxHeight: 150, overflowY: 'auto', background: surface.well, borderRadius: 6,
        padding: '6px 8px', fontFamily: typography.family.mono, fontSize: 10, lineHeight: '15px',
      }}>
        {recent.length === 0 ? (
          <span style={{ color: text.muted }}>no events yet</span>
        ) : recent.map((e) => (
          <div key={e.id} style={{ color: EVENT_TONE[e.kind] ?? text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: text.muted }}>{new Date(e.t).toLocaleTimeString()} </span>
            {e.kind}{e.msg ? ` · ${e.msg}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
