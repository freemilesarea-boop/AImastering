// useIsMobile — true when the viewport is mobile-width (< 640px).
//
// Drives the "Mobile = Guided Flow only" policy: at mobile width the Pro
// controls (TweakPage, ResultPage TweakPanel + advanced sections, batch
// mode) are hidden and the user only sees Import → Choose → Mastering →
// Result → Export.  Desktop width keeps every existing feature.
//
// Override for testing without resizing: `window.__LOUI_FORCE_MOBILE__ = true`
// in DevTools (then trigger a resize or re-render).
import { useEffect, useState } from 'react';

declare global {
  interface Window {
    __LOUI_FORCE_MOBILE__?: boolean;
  }
}

// `< 640px` → max-width 639.98px (exclusive of 640).
const MOBILE_QUERY = '(max-width: 639.98px)';

function computeIsMobile(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_FORCE_MOBILE__ === 'boolean') {
    return window.__LOUI_FORCE_MOBILE__;
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => computeIsMobile());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(computeIsMobile());
    // matchMedia 'change' covers width crossings; resize also catches the
    // manual __LOUI_FORCE_MOBILE__ toggle path during testing.
    mql.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      mql.removeEventListener?.('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, []);

  return isMobile;
}
