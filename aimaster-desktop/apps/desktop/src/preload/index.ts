import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const INVOKE_CHANNELS = [
  'audio:analyze', 'audio:master', 'audio:qc',
  'license:status', 'license:activate', 'license:deactivate',
  'file:open-dialog', 'file:save-dialog', 'file:get-info',
  'file:open-in-finder', 'file:get-recent',
  'settings:get', 'settings:set', 'settings:choose-output-dir',
  'system:ffmpeg-status',
] as const;

const LISTEN_CHANNELS = [
  'audio:progress',
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
  version: process.env['npm_package_version'] ?? '1.0.0',
});
