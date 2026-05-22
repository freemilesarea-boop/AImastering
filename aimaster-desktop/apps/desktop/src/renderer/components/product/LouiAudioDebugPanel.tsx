// LouiAudioDebugPanel — always-visible audio status + in-app event log +
// forced DSP test buttons.  Surfaces the real state of the audio pipeline
// (so "it silently does nothing" can be diagnosed on-screen, not just in
// the console) and lets a tester force extreme DSP configs to confirm the
// parameter → graph → sound path end-to-end.

import React from 'react';
import { surface, text, typography, space, radius, meter as meterTokens } from '../../theme/loui-theme.js';
import {
  getAudioLog, subscribeAudioLog, sharedContextState, resumeSharedContext,
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
  const rtTone = props.realtimeStatus === 'active' ? meterTokens.safe.foreground
    : props.realtimeStatus === 'failed' ? meterTokens.danger.foreground
    : props.realtimeStatus === 'passthrough' || props.realtimeStatus === 'bypassed' ? meterTokens.warn.foreground
    : text.muted;

  const toggleBypass = () => {
    const next = !bypassed;
    setBypassed(next);
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
        <StatusCell label="Realtime" value={props.realtimeStatus.toUpperCase()} tone={rtTone} />
        <StatusCell label="Analyzer" value={analyzerLabel} tone={analyzerLabel === 'FAILED' ? meterTokens.danger.foreground : analyzerLabel === 'OFF' ? text.muted : meterTokens.safe.foreground} />
        <StatusCell label="Context" value={ctxState} tone={ctxState === 'running' ? meterTokens.safe.foreground : ctxState === 'suspended' ? meterTokens.warn.foreground : text.muted} />
        <StatusCell label="DSP blk" value={String(props.dspBlocks)} />
        <StatusCell label="Native" value={String(native.frameCount)} />
        <StatusCell label="Avg ms" value={props.avgProcessMs.toFixed(2)} />
        <StatusCell label="Xruns" value={String(props.xruns)} tone={props.xruns > 0 ? meterTokens.warn.foreground : text.primary} />
      </div>
      {(props.lastError || native.error) && (
        <div style={{ fontFamily: typography.family.mono, fontSize: 11, color: meterTokens.danger.foreground }}>
          last error: {props.lastError || native.error}
        </div>
      )}

      {/* Forced DSP tests — prove parameter → graph → sound */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <TestButton label="EQ +24dB Air" onClick={() => eq.setParam('airDb', 24)} />
        <TestButton label="EQ -24dB Air" onClick={() => eq.setParam('airDb', -24)} />
        <TestButton label="Output -24dB" onClick={() => eq.setParam('outputGainDb', -24)} />
        <TestButton label="Mono (width 0%)" onClick={() => imager.setParam('widthPct', 0)} />
        <TestButton label="Wide 200%" onClick={() => imager.setParam('widthPct', 200)} />
        <TestButton label={bypassed ? 'Bypass: ON' : 'Bypass: OFF'} active={bypassed} onClick={toggleBypass} />
        <TestButton label="Resume Ctx" onClick={() => void resumeSharedContext()} />
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
