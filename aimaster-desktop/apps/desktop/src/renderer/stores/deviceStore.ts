// Device store (Phase D2) — account device registration/list/revoke.
//
// Registers the current device (machine id from main) against the account's
// <=2 active-device limit and tracks `deviceAllowed`, which the gate push
// folds into the entitlement contribution.  NOT a license gate: a license
// user is never blocked by device failures (the main gate is
// license || (entitlementPaid && deviceAllowed)).  Safe no-ops when Supabase
// isn't configured / not signed in.
import { create } from 'zustand';
import { getSupabase } from '../lib/supabaseClient.js';

export interface DeviceRow {
  device_id: string;
  device_name: string | null;
  platform: string | null;
  last_seen_at: string;
  created_at: string;
}

interface DeviceStore {
  deviceAllowed: boolean;
  currentDeviceId: string | null;
  devices: DeviceRow[];
  lastCode: string | null;
  registerCurrent: () => Promise<{ allowed: boolean; code?: string }>;
  list: () => Promise<void>;
  revoke: (deviceId: string) => Promise<{ ok: boolean }>;
  clear: () => void;
}

async function currentDeviceInfo(): Promise<{ deviceId: string; deviceName: string; platform: string } | null> {
  try {
    const info = (await window.electronAPI?.invoke('device:get-id')) as
      { deviceId?: string; deviceName?: string; platform?: string } | undefined;
    if (!info?.deviceId) return null;
    return { deviceId: info.deviceId, deviceName: info.deviceName ?? '', platform: info.platform ?? '' };
  } catch { return null; }
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  deviceAllowed: false,
  currentDeviceId: null,
  devices: [],
  lastCode: null,

  registerCurrent: async () => {
    const info = await currentDeviceInfo();
    if (!info) { set({ deviceAllowed: false, lastCode: 'no_device' }); return { allowed: false, code: 'no_device' }; }
    set({ currentDeviceId: info.deviceId });

    const sb = getSupabase();
    if (!sb) { set({ deviceAllowed: false, lastCode: 'unconfigured' }); return { allowed: false, code: 'unconfigured' }; }
    try {
      const { data, error } = await sb.functions.invoke('aimaster-register-device', {
        body: { device_id: info.deviceId, device_name: info.deviceName, platform: info.platform },
      });
      if (error) { set({ deviceAllowed: false, lastCode: 'server_error' }); return { allowed: false, code: 'server_error' }; }
      const r = (data ?? {}) as { ok?: boolean; allowed?: boolean; code?: string };
      const allowed = r.ok === true && r.allowed === true;
      set({ deviceAllowed: allowed, lastCode: r.code ?? null });
      void useDeviceStore.getState().list();
      return r.code ? { allowed, code: r.code } : { allowed };
    } catch {
      set({ deviceAllowed: false, lastCode: 'server_error' });
      return { allowed: false, code: 'server_error' };
    }
  },

  list: async () => {
    const sb = getSupabase();
    if (!sb) return;
    try {
      const { data, error } = await sb.functions.invoke('aimaster-list-devices');
      if (error) return;
      const r = (data ?? {}) as { ok?: boolean; devices?: DeviceRow[] };
      if (r.ok) set({ devices: r.devices ?? [] });
    } catch { /* ignore */ }
  },

  revoke: async (deviceId: string) => {
    const sb = getSupabase();
    if (!sb) return { ok: false };
    try {
      const { data, error } = await sb.functions.invoke('aimaster-revoke-device', { body: { device_id: deviceId } });
      if (error) return { ok: false };
      const r = (data ?? {}) as { ok?: boolean };
      if (r.ok) {
        // Re-register the current device to claim the freed slot, then refresh.
        await useDeviceStore.getState().registerCurrent();
      }
      return { ok: r.ok === true };
    } catch { return { ok: false }; }
  },

  clear: () => set({ deviceAllowed: false, currentDeviceId: null, devices: [], lastCode: null }),
}));
