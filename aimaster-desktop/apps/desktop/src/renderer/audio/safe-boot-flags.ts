// safe-boot-flags — an emergency switch for the one renderer feature that has
// ever crashed the page on mount.
//
// This started as eight flags for hunting a ProductPage crash: every Native*
// meter, the goniometer, the loudness history, the secondary analyzer, the
// free-EQ sync.  ProductPage and all of those components are gone, and with
// them the code that read seven of the eight flags — they were switches wired
// to nothing.  What is left is `wasmAnalyzer`, which `analyzer-factory-resolver`
// still consults to fall back to the JS analyzer.
//
// From the DevTools console:
//
//   window.__SAFE_BOOT__.disable('wasmAnalyzer')   // then reload
//   window.__SAFE_BOOT__.reset()
//
// Persists across reloads via sessionStorage so a toggle survives the reload
// it needs.  Cleared on full app quit.

type FlagName = 'wasmAnalyzer';   // WasmAnalyzerProvider / analyzer factory

// Bump the suffix when the DEFAULT_ENABLED shape changes, so a session that
// stored the previous shape gets the new defaults instead of stale keys.
const STORAGE_KEY = '__loui_safe_boot__v4';

// ON by default: the dlmalloc panic this was built to isolate was fixed at the
// source (init() singleton, stop() idempotency, provider single-stop,
// asarUnpack).  The flag stays so a future regression can be cornered by hand
// without a redeploy.
const DEFAULT_ENABLED: Record<FlagName, boolean> = {
  wasmAnalyzer: true,
};

function readFlags(): Record<FlagName, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_ENABLED)); } catch { /* ignore */ }
      return { ...DEFAULT_ENABLED };
    }
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
  console.log('[SAFE_BOOT] reset to defaults.  Reload to apply.');
}

// Exposed on window so the flag can be toggled from the DevTools console.
if (typeof window !== 'undefined') {
  (window as unknown as { __SAFE_BOOT__: unknown }).__SAFE_BOOT__ = {
    get state() { return { ...current }; },
    enable(flag: FlagName) { setFlag(flag, true); },
    disable(flag: FlagName) { setFlag(flag, false); },
    reset() { resetAll(); },
  };
  // eslint-disable-next-line no-console
  console.log('[SAFE_BOOT] flags:', current, '— toggle via window.__SAFE_BOOT__.<helper>()');
}
