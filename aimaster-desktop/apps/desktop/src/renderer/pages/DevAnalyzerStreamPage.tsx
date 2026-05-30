// DevAnalyzerStreamPage — developer-only proof page for the analyzer
// streaming pipeline.
//
// What it does
//   - Mounts LoudnessMeterPanelV2 + SpectrumAnalyzerPanel side-by-side.
//   - Drives them via `resolveAnalyzerFactory()` which picks WASM (when
//     `VITE_LOUI_WASM_ANALYZER=true`) or synthetic (default).
//   - Shows which factory is active so testers can confirm at a glance.
//
// What it is NOT
//   - Not in the production nav.  Routed under `dev` only.
//   - Not wired into any existing page or mastering pipeline.
//   - Not an Ozone-style finalised UI.  Visuals are deliberately spartan.
//
// Why this exists
//   The factory + worklet + V2 components need an end-to-end smoke test
//   that doesn't disturb the rest of the app.  This page is that test.

import { useMemo, useState, useEffect, useRef } from 'react';
import { LoudnessMeterPanelV2 } from '../components/LoudnessMeterPanelV2.js';
import { SpectrumAnalyzerPanel } from '../components/SpectrumAnalyzerPanel.js';
import {
  analyzerFactoryLabel,
  isWasmAnalyzerEnabled,
  resolveAnalyzerFactory,
} from '../audio/analyzer-factory-resolver.js';
import type { AnalyzerSessionFactory } from '@aimaster/shared-types/streaming';

export function DevAnalyzerStreamPage() {
  // Factory is decided ONCE per mount.  Toggling the flag at runtime
  // requires a remount (we re-evaluate when the flag changes).
  const [wasmEnabled, setWasmEnabled] = useState(isWasmAnalyzerEnabled);
  const factory = useMemo<AnalyzerSessionFactory>(
    () => resolveAnalyzerFactory(),
    [wasmEnabled], // re-resolve when flag toggles
  );
  const label = wasmEnabled ? 'WASM (loui-dsp)' : 'Synthetic (dev only)';

  // Allow toggle from the page itself for quick A/B without rebuilding.
  // This sets the runtime override and forces re-resolution.
  const toggleFlag = () => {
    if (typeof window === 'undefined') return;
    const next = !wasmEnabled;
    window.__LOUI_WASM_ANALYZER__ = next;
    setWasmEnabled(next);
  };

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-medium text-zinc-100">Analyzer stream · dev</h1>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-zinc-500">factory:</span>
          <span className="font-mono text-zinc-300">{label}</span>
          <button
            type="button"
            onClick={toggleFlag}
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700"
          >
            toggle
          </button>
        </div>
      </header>

      <p className="max-w-2xl text-xs text-zinc-500">
        Toggling between WASM and synthetic factories lets you A/B the
        analyzer path without rebuilding.  The synthetic factory drives the
        existing TS LoudnessAnalyzer against an internal oscillator mix;
        the WASM factory uses the Rust dsp-core via an AudioWorklet tap
        and expects an external audio source (none attached on this page —
        it will show empty meters in WASM mode unless you{' '}
        <code className="font-mono text-zinc-400">attach()</code> a source).
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <LoudnessMeterPanelV2 factory={factory} tickRate="30Hz" />
        <SpectrumAnalyzerPanel factory={factory} />
      </div>

      <BridgeDiagnostics />
    </div>
  );
}

/** Tiny diagnostic block — lifecycle / event counts to spot leaks. */
function BridgeDiagnostics() {
  const mountRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const elapsed = ((now - mountRef.current) / 1000).toFixed(1);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500 font-mono tabular-nums">
      <div>page elapsed:           {elapsed} s</div>
      <div>VITE_LOUI_WASM_ANALYZER: {String(import.meta.env?.VITE_LOUI_WASM_ANALYZER ?? '(unset)')}</div>
      <div>runtime override:        {String(typeof window !== 'undefined' && window.__LOUI_WASM_ANALYZER__ === true)}</div>
      <div>resolved label:          {analyzerFactoryLabel()}</div>
    </div>
  );
}
