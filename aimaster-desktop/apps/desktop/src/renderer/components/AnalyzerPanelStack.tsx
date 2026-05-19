// AnalyzerPanelStack — V1 fallback / V2 panel group.
//
// Drop-in replacement for the existing `<LoudnessMeterPanel>` slot in
// pages.  Behaviour:
//   • WASM analyzer flag OFF  → render the existing V1 LoudnessMeterPanel
//     (no other panels).  Existing UX unchanged.
//   • WASM analyzer flag ON   → mount a `WasmAnalyzerProvider` and render
//     LoudnessMeterPanelV2 + SpectrumAnalyzerPanel + StereoScopePanel
//     sharing one WASM session attached to the same media element.
//
// Feature flag rollback: unset `VITE_LOUI_WASM_ANALYZER` (or set
// `window.__LOUI_WASM_ANALYZER__ = false`) → instant fallback to V1.

import { LoudnessMeterPanel } from './LoudnessMeterPanel.js';
import { LoudnessMeterPanelV2 } from './LoudnessMeterPanelV2.js';
import { SpectrumAnalyzerPanel } from './SpectrumAnalyzerPanel.js';
import { StereoScopePanel } from './StereoScopePanel.js';
import {
  WasmAnalyzerProvider,
  useWasmAnalyzerSession,
} from '../audio/wasm-analyzer-context.js';
import { isWasmAnalyzerEnabled } from '../audio/analyzer-factory-resolver.js';

export interface AnalyzerPanelStackProps {
  /** Audio source the analyzer attaches to. */
  mediaElement?: HTMLMediaElement | null;
  /** Whether playback is active; gates session creation + meter rendering. */
  active: boolean;
  /** Optional integrated-LUFS target for colour-coding the V1 / V2 meters. */
  targetLufs?: number;
  /** Show the spectrum panel (V2 only). */
  showSpectrum?: boolean;
  /** Show the stereo scope panel (V2 only). */
  showStereo?: boolean;
}

/**
 * Renders the analyzer panel(s) for the current page.
 *
 * V1 mode (default): existing LoudnessMeterPanel only.  Spectrum/stereo
 * panels are absent because V1 has no equivalent — they're additive V2
 * features.
 */
export function AnalyzerPanelStack(props: AnalyzerPanelStackProps) {
  const v2 = isWasmAnalyzerEnabled();

  if (!v2) {
    // V1 — exact prior behaviour, no extra panels.
    return (
      <LoudnessMeterPanel
        mediaElement={props.mediaElement ?? null}
        active={props.active}
        {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})}
      />
    );
  }

  return (
    <WasmAnalyzerProvider
      mediaElement={props.mediaElement ?? null}
      active={props.active}
    >
      <V2PanelStack
        {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})}
        showSpectrum={props.showSpectrum ?? true}
        showStereo={props.showStereo ?? true}
      />
    </WasmAnalyzerProvider>
  );
}

/** Internal V2 panel group — consumes the shared WASM session. */
function V2PanelStack(props: {
  targetLufs?: number;
  showSpectrum: boolean;
  showStereo: boolean;
}) {
  const session = useWasmAnalyzerSession();
  // Pass `session` (which may be `null` while booting); the components
  // render their "awaiting frames…" state until the session is up.
  return (
    <div className="space-y-3">
      <LoudnessMeterPanelV2
        session={session}
        tickRate="30Hz"
        {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})}
      />
      {props.showSpectrum && (
        <SpectrumAnalyzerPanel session={session} showPeakHold />
      )}
      {props.showStereo && (
        <StereoScopePanel session={session} />
      )}
    </div>
  );
}
