// The third-party plugins installed on this machine.
//
// Scanned once on demand and kept, because walking several folders and reading
// a file per bundle is not something to repeat every time a menu opens.
//
// Finding them is not the same as being able to run them.  This store is
// deliberately honest about that difference: `hostable` says whether the app
// can actually put a plugin in a channel, and today the answer is no for every
// one of them — see `daw/engine/external-host.ts` for exactly what is missing
// and why.

import { create } from 'zustand';

export type PluginFormat = 'vst3' | 'au' | 'vst2' | 'clap';

export interface ScannedPlugin {
  id: string;
  name: string;
  vendor: string;
  format: PluginFormat;
  path: string;
  uid: string;
  kind: 'effect' | 'instrument' | 'unknown';
}

export interface ScanResult {
  plugins: ScannedPlugin[];
  searched: string[];
  skipped: Array<{ path: string; reason: string }>;
}

interface ExternalPluginStore {
  plugins: ScannedPlugin[];
  searched: string[];
  skipped: Array<{ path: string; reason: string }>;
  status: 'idle' | 'scanning' | 'ready' | 'unavailable';
  error: string | null;
  /** When the scan last completed, for the manager's header. */
  scannedAt: number | null;

  scan: (force?: boolean) => Promise<void>;
}

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export const useExternalPluginStore = create<ExternalPluginStore>((set, get) => ({
  plugins: [],
  searched: [],
  skipped: [],
  status: 'idle',
  error: null,
  scannedAt: null,

  scan: async (force = false) => {
    if (get().status === 'scanning') return;
    const api = (globalThis as unknown as { electronAPI?: Bridge }).electronAPI;
    if (!api) { set({ status: 'unavailable', error: '데스크톱 앱에서만 스캔할 수 있습니다' }); return; }

    set({ status: 'scanning', error: null });
    try {
      const result = await api.invoke('plugins:scan', force) as ScanResult;
      set({
        plugins: result.plugins,
        searched: result.searched,
        skipped: result.skipped,
        status: 'ready',
        error: null,
        scannedAt: Date.now(),
      });
    } catch (err) {
      set({ status: 'unavailable', error: (err as Error).message });
    }
  },
}));

/** Group by vendor, because that is how an engineer remembers their plugins. */
export function byVendor(plugins: readonly ScannedPlugin[]): Array<{
  vendor: string; plugins: ScannedPlugin[];
}> {
  const groups = new Map<string, ScannedPlugin[]>();
  for (const plugin of plugins) {
    const key = plugin.vendor.trim() || '제조사 미상';
    groups.set(key, [...(groups.get(key) ?? []), plugin]);
  }
  return [...groups.entries()]
    .map(([vendor, list]) => ({ vendor, plugins: list }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

/** Counts per format, for the manager's summary line. */
export function formatCounts(plugins: readonly ScannedPlugin[]): Record<PluginFormat, number> {
  const counts: Record<PluginFormat, number> = { vst3: 0, au: 0, vst2: 0, clap: 0 };
  for (const plugin of plugins) counts[plugin.format] += 1;
  return counts;
}
