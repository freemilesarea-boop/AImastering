import type { IpcMain } from 'electron';
import { app } from 'electron';

// Stem-separation availability (precise rebalance tier).  Lets the renderer gate
// the precise UI on whether a real model is pinned AND the ONNX runtime loads —
// so the tier auto-enables when the maintainer pins a model, with no code edit.

export function registerStemHandlers(ipc: IpcMain): void {
  ipc.handle('stem:precise-available', async () => {
    try {
      const { getStemPreciseAvailability } = await import('../offline/stem-separation.js');
      return await getStemPreciseAvailability(app.getPath('userData'));
    } catch {
      return { modelConfigured: false, runtimeAvailable: false, available: false };
    }
  });
}
