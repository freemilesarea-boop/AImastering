import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const INVOKE_CHANNELS = [
  // Audio
  'audio:analyze', 'audio:master', 'audio:qc',
  // License
  'license:status', 'license:activate', 'license:deactivate',
  'license:can-process', 'license:decrement-trial', 'license:get-remaining',
  // Files
  'file:open-dialog', 'file:open-dialog-multi', 'file:save-dialog', 'file:save-wav',
  'file:batch-save-wav',
  'file:get-info', 'file:open-in-finder', 'file:get-recent',
  // Settings
  'settings:get', 'settings:set', 'settings:choose-output-dir',
  // System
  'system:ffmpeg-status',
  // Support bundle (v3.6 QA)
  'support:bundle', 'support:bundle-export', 'support:record-failure',
  // Updater (v3.4.3)
  'updater:check', 'updater:download', 'updater:quit-and-install',
  'updater:get-status',
] as const;

const LISTEN_CHANNELS = [
  'audio:progress',
  'updater:status',
] as const;

type InvokeChannel = typeof INVOKE_CHANNELS[number];
type ListenChannel = typeof LISTEN_CHANNELS[number];

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: InvokeChannel, ...args: unknown[]) => {
    if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Blocked IPC channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: ListenChannel, listener: (...args: unknown[]) => void) => {
    if (!(LISTEN_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Blocked listen channel: ${channel}`);
    }
    const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
  version:  process.env['npm_package_version'] ?? '1.0.0',
});

// ── Dedicated `window.updater` namespace (v3.4.3) ─────────────────────────────
// Keeps the auto-update API ergonomic for the renderer instead of forcing
// callers through the generic invoke() bridge.  All channels are still routed
// through the validated INVOKE_CHANNELS list above.
contextBridge.exposeInMainWorld('updater', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate:  () => ipcRenderer.invoke('updater:download'),
  quitAndInstall:  () => ipcRenderer.invoke('updater:quit-and-install'),
  getStatus:       () => ipcRenderer.invoke('updater:get-status'),
  onStatus: (listener: (status: unknown) => void) => {
    const wrapped = (_e: IpcRendererEvent, status: unknown) => listener(status);
    ipcRenderer.on('updater:status', wrapped);
    return () => ipcRenderer.removeListener('updater:status', wrapped);
  },
});
