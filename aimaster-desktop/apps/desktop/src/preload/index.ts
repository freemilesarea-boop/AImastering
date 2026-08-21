import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const INVOKE_CHANNELS = [
  // Audio
  'audio:analyze', 'audio:master', 'audio:qc',
  // Renderer-initiated cancel of an in-flight Python engine call.
  // killBridge() terminates the engine subprocess; the next call respawns.
  'audio:cancel',
  // Preview re-render (M3-P-NEXT-5C) — reuses the existing master path
  // with an options override.  Product-layout flag gates the renderer
  // caller; the channel itself is always registered.
  'audio:re-render-preview',
  // Rust offline render (RUST-OFFLINE-RENDER-1) — same Rust MasteringChain
  // as the realtime preview, used by the "새 버전 만들기" path when the
  // rust-offline flag is ON (default).  Free parametric EQ bands flow
  // through here (Phase 3b).
  'audio:master-rust-experimental',
  // License IPC channels (v3.6 — re-enabled for commercial release).
  'license:status', 'license:can-process', 'license:get-remaining',
  'license:activate', 'license:deactivate', 'license:decrement-trial',
  'license:revalidate',
  // Entitlement bridge (Phase C) — renderer pushes a non-sensitive gate snapshot.
  'entitlement:set',
  // Device id for account device registration (Phase D2).
  'device:get-id',
  // Files
  'file:open-dialog', 'file:open-dialog-multi', 'file:save-dialog', 'file:save-wav',
  'file:batch-save-wav',
  // Save with transcode (M3-P-NEXT-5D-2-d) — separate from file:save-wav
  'file:save-audio',
  'file:get-info', 'file:open-in-finder', 'file:get-recent',
  // Settings
  'settings:get', 'settings:set', 'settings:choose-output-dir',
  // System
  'system:ffmpeg-status',
  // Worklet/WASM asset reader (packaged file:// + asar safe)
  'loui:read-worklet-asset',
  // Support bundle (v3.6 QA)
  'support:bundle', 'support:bundle-export', 'support:record-failure',
  // Session save / load (.louisession)
  'session:save', 'session:load',
  // User plugin presets (.louipreset)
  'daw:presets-export', 'daw:presets-import',
  // Control surface mappings (.louisurface)
  'daw:surface-export', 'daw:surface-import',
  // Whole insert chains (.louirack)
  'daw:racks-export', 'daw:racks-import',
  // DAW offline render output (Bounce / Freeze / Consolidate)
  'daw:write-temp-audio', 'daw:bounce-audio',
  // DAW source decoding — FFmpeg in main, never Chromium in the renderer
  'daw:pcm-source',
  // Installed third-party plugins (scan only — nothing is loaded)
  'plugins:scan', 'daw:host-apply',
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

// ── Worklet/WASM asset bridge (packaged file:// + asar safe) ──────────────
// Lets the renderer load AudioWorklet + WASM assets via the main process
// (Node fs reads inside app.asar), bypassing Chromium's file:// fetch
// restrictions in the packaged app.
contextBridge.exposeInMainWorld('louiAssets', {
  read: (name: string) => ipcRenderer.invoke('loui:read-worklet-asset', name),
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
