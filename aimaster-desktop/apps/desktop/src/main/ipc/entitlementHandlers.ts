// Entitlement bridge IPC (Phase C).
//
// Receives the renderer's derived, NON-SENSITIVE entitlement gate snapshot
// and caches it in the main process for the export gate.  Only { paid, plan,
// status } is accepted; any extra fields are ignored so no JWT/email/token
// can be smuggled in.  Registered unconditionally (harmless when unused —
// default cached state is paid:false).
import type { IpcMain } from 'electron';
import { setEntitlement } from '../services/entitlementBridge.js';
import { log } from '../utils/logger.js';

export function registerEntitlementHandlers(ipc: IpcMain): void {
  ipc.handle('entitlement:set', (_e, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    setEntitlement({
      paid: p['paid'] === true,
      plan: typeof p['plan'] === 'string' ? (p['plan'] as string) : 'free',
      status: typeof p['status'] === 'string' ? (p['status'] as string) : 'free',
    });
    // Non-sensitive: paid flag only (no email/JWT/token).
    log.info('[entitlement] gate snapshot set — paid=' + (p['paid'] === true));
    return { ok: true };
  });
}
