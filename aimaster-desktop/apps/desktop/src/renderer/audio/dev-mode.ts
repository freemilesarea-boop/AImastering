// dev-mode — gates developer-only UI (audio debug panel, graph dump, raw
// metrics) so normal users never see it.  ON automatically in a dev build
// (vite), or opt-in via localStorage['loui.devMode']='true' /
// window.__LOUI_DEV__ in a packaged build for QA.

export function isDevMode(): boolean {
  try {
    if (typeof window !== 'undefined' && (window as { __LOUI_DEV__?: boolean }).__LOUI_DEV__ === true) return true;
  } catch { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('loui.devMode') === 'true') return true;
  } catch { /* ignore */ }
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch { /* ignore */ }
  return false;
}

/** Toggle the persisted QA dev-mode flag (packaged builds). */
export function setDevMode(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('loui.devMode', on ? 'true' : 'false');
  } catch { /* ignore */ }
  try { (window as { __LOUI_DEV__?: boolean }).__LOUI_DEV__ = on; } catch { /* ignore */ }
}
