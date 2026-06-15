// Entitlement / device bridge IPC (Phase C/D2).
//
// `entitlement:set` — receives the renderer's NON-SENSITIVE gate snapshot
//   { paid, deviceAllowed, plan, status } and caches it for the export gate.
// `device:get-id` — returns the stable machine id + name + platform so the
//   renderer can register the current device (reuses node-machine-id, the
//   same id source the license system uses).
// No JWT/email/token is ever accepted or returned here.
import type { IpcMain } from 'electron';
import os from 'node:os';
import { setEntitlement } from '../services/entitlementBridge.js';
import { getMachineId } from '@aimaster/license-core';
import { log } from '../utils/logger.js';

function platformLabel(): string {
  switch (process.platform) {
    case 'darwin': return 'mac';
    case 'win32':  return 'win';
    case 'linux':  return 'linux';
    default:       return process.platform;
  }
}

export function registerEntitlementHandlers(ipc: IpcMain): void {
  ipc.handle('entitlement:set', (_e, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    setEntitlement({
      paid: p['paid'] === true,
      deviceAllowed: p['deviceAllowed'] === true,
      plan: typeof p['plan'] === 'string' ? p['plan'] : 'free',
      status: typeof p['status'] === 'string' ? p['status'] : 'free',
    });
    // Non-sensitive: paid + deviceAllowed booleans only.
    log.info(`[entitlement] gate set — paid=${p['paid'] === true} deviceAllowed=${p['deviceAllowed'] === true}`);
    return { ok: true };
  });

  ipc.handle('device:get-id', () => {
    let deviceId = '';
    try { deviceId = getMachineId(); } catch { deviceId = ''; }
    return {
      deviceId,
      deviceName: os.hostname?.() ?? '',
      platform: platformLabel(),
    };
  });
}
