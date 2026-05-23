// worklet-asset-source — load AudioWorklet/WASM assets in a way that works
// in BOTH dev (Vite http://) and packaged (file:// inside app.asar).
//
// Packaged Electron loads the renderer from file:// inside app.asar, where
// Chromium's fetch() / audioWorklet.addModule() of relative file:// assets
// is unreliable or blocked.  When the `louiAssets` preload bridge is present
// (packaged + dev-with-electron), we read the bytes via the MAIN process
// (Node fs reads asar fine) and:
//   • compile wasm directly from the bytes (no fetch), and
//   • load JS modules from a blob: URL (addModule accepts blob URLs).
// Otherwise (browser/storybook/vite-only) we fall back to fetch(url).

interface AssetText { kind: 'text'; name: string; text: string; size: number }
interface AssetBytes { kind: 'bytes'; name: string; bytes: Uint8Array; size: number }
type AssetPayload = AssetText | AssetBytes;

declare global {
  interface Window {
    louiAssets?: { read: (name: string) => Promise<AssetPayload> };
  }
}

function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.louiAssets?.read;
}

/** Fetch wasm bytes (IPC first, then fetch).  Returns bytes + a diagnostic. */
export async function loadWasmBytes(
  assetName: string,
  fallbackUrl: string,
): Promise<{ bytes: ArrayBuffer; source: 'ipc' | 'fetch'; diag: string }> {
  if (hasBridge()) {
    try {
      const p = await window.louiAssets!.read(assetName);
      if (p.kind === 'bytes') {
        const u = p.bytes;
        const ab = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
        return { bytes: ab, source: 'ipc', diag: `ipc:${assetName} size=${ab.byteLength}` };
      }
    } catch (e) {
      // fall through to fetch with the IPC error noted
      const msg = e instanceof Error ? e.message : String(e);
      const f = await fetchBytes(fallbackUrl);
      return { ...f, diag: `ipc-failed(${msg}) → ${f.diag}` };
    }
  }
  return fetchBytes(fallbackUrl);
}

async function fetchBytes(url: string): Promise<{ bytes: ArrayBuffer; source: 'fetch'; diag: string }> {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  return {
    bytes: buf,
    source: 'fetch',
    diag: `fetch:${url} status=${resp.status} ok=${resp.ok} type=${resp.headers.get('content-type') ?? '?'} size=${buf.byteLength}`,
  };
}

/** Resolve a loadable module URL for an AudioWorklet JS asset.
 *  IPC → blob: URL (packaged-safe); otherwise the relative URL. */
export async function loadModuleUrl(
  assetName: string,
  fallbackUrl: string,
): Promise<{ url: string; source: 'ipc-blob' | 'fetch-url'; revoke?: () => void; diag: string }> {
  if (hasBridge()) {
    try {
      const p = await window.louiAssets!.read(assetName);
      if (p.kind === 'text') {
        const blob = new Blob([p.text], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        return { url, source: 'ipc-blob', revoke: () => URL.revokeObjectURL(url), diag: `ipc-blob:${assetName} size=${p.size}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { url: fallbackUrl, source: 'fetch-url', diag: `ipc-failed(${msg}) → url:${fallbackUrl}` };
    }
  }
  return { url: fallbackUrl, source: 'fetch-url', diag: `url:${fallbackUrl}` };
}
