// safe-boot-flags — emergency feature flags for diagnosing renderer crashes
// on ProductPage mount.
//
// All flags DEFAULT to "safe" (= the suspect feature is DISABLED) so the
// product page is guaranteed to render the smallest viable shell.  Once the
// page is alive, toggle flags one by one via the DevTools console to find
// the culprit:
//
//   window.__SAFE_BOOT__.enableNativeAnalyzers()
//   window.__SAFE_BOOT__.enableSecondaryAnalyzer()
//   window.__SAFE_BOOT__.enableFreeEqSync()
//   window.__SAFE_BOOT__.enableWasmAnalyzer()
//   window.__SAFE_BOOT__.enableRealtimeMasteringGraph()
//   window.__SAFE_BOOT__.reset()   // disable everything again
//
// Persists across reloads via sessionStorage so toggles survive the
// reload.  Cleared on full app quit.

type FlagName =
  | 'nativeAnalyzers'        // useNativeAnalyzer + every Native* meter + LouiGoniometer
  | 'secondaryAnalyzer'      // useSecondaryAnalyzer hook call itself
  | 'freeEqSync'             // setGraphFreeEqBands useEffect
  | 'wasmAnalyzer'           // WasmAnalyzerProvider
  | 'realtimeMasteringGraph' // useRealtimeMasteringGraph
  | 'loudnessHistory'        // LouiLoudnessHistory canvas
  | 'bandMeter'              // NativeBandMeter
  | 'waveformPeaks';         // useWaveformPeaks (decodes audio file in renderer)

const STORAGE_KEY = '__loui_safe_boot__';
const DEFAULT_ENABLED: Record<FlagName, boolean> = {
  nativeAnalyzers:        false, // OFF by default during diagnosis
  secondaryAnalyzer:      false,
  freeEqSync:             false,
  wasmAnalyzer:           false,
  realtimeMasteringGraph: false,
  loudnessHistory:        false,
  bandMeter:              false,
  waveformPeaks:          false,
};

function readFlags(): Record<FlagName, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ENABLED };
    const parsed = JSON.parse(raw) as Partial<Record<FlagName, boolean>>;
    return { ...DEFAULT_ENABLED, ...parsed };
  } catch {
    return { ...DEFAULT_ENABLED };
  }
}

let current = readFlags();

function persist(): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* ignore */ }
}

export function isEnabled(flag: FlagName): boolean { return current[flag] === true; }

export function setFlag(flag: FlagName, value: boolean): void {
  current[flag] = value;
  persist();
  // eslint-disable-next-line no-console
  console.log(`[SAFE_BOOT] ${flag} = ${value}.  Reload (Cmd+R) to apply.`);
}

export function resetAll(): void {
  current = { ...DEFAULT_ENABLED };
  persist();
  // eslint-disable-next-line no-console
  console.log('[SAFE_BOOT] reset — all suspect features DISABLED.  Reload to apply.');
}

// Expose helpers on window so the user can toggle via DevTools console.
if (typeof window !== 'undefined') {
  (window as unknown as { __SAFE_BOOT__: unknown }).__SAFE_BOOT__ = {
    get state() { return { ...current }; },
    enable(flag: FlagName) { setFlag(flag, true); },
    disable(flag: FlagName) { setFlag(flag, false); },
    enableNativeAnalyzers() { setFlag('nativeAnalyzers', true); },
    enableSecondaryAnalyzer() { setFlag('secondaryAnalyzer', true); },
    enableFreeEqSync() { setFlag('freeEqSync', true); },
    enableWasmAnalyzer() { setFlag('wasmAnalyzer', true); },
    enableRealtimeMasteringGraph() { setFlag('realtimeMasteringGraph', true); },
    enableLoudnessHistory() { setFlag('loudnessHistory', true); },
    enableBandMeter() { setFlag('bandMeter', true); },
    enableWaveformPeaks() { setFlag('waveformPeaks', true); },
    reset() { resetAll(); },
  };
  // eslint-disable-next-line no-console
  console.log('[SAFE_BOOT] flags:', current, '— toggle via window.__SAFE_BOOT__.<helper>()');
}
