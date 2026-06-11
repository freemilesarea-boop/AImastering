// dolby-sidecar — copy a Dolby codec sidecar (AC-3 / E-AC-3 / TrueHD) that sits
// next to a temp master WAV to the user's chosen save location.  The Rust render
// writes the sidecar as `<wav-without-.wav>.<ext>`; on save we mirror it next to
// the destination WAV.  Pure (fs injected) → headless-testable.

export const DOLBY_SIDECAR_EXTS = ['ac3', 'eac3', 'thd'] as const;

export interface SidecarFs {
  exists(path: string): boolean;
  copy(src: string, dest: string): void;
}

/**
 * Copy any Dolby sidecars sitting beside `srcWav` to beside `destWav`.
 * Returns the destination paths written.  Best-effort: a copy failure on one
 * sidecar is swallowed (the WAV save already succeeded).
 */
export function copyDolbySidecars(srcWav: string, destWav: string, fs: SidecarFs): string[] {
  const srcBase = srcWav.replace(/\.wav$/i, '');
  const destBase = destWav.replace(/\.[^./\\]+$/, '');
  const written: string[] = [];
  for (const ext of DOLBY_SIDECAR_EXTS) {
    const sib = `${srcBase}.${ext}`;
    if (!fs.exists(sib)) continue;
    const dest = `${destBase}.${ext}`;
    try { fs.copy(sib, dest); written.push(dest); } catch { /* best-effort */ }
  }
  return written;
}
