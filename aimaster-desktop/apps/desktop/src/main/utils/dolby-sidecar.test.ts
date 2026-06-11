import { describe, it, expect } from 'vitest';
import { copyDolbySidecars, DOLBY_SIDECAR_EXTS, type SidecarFs } from './dolby-sidecar.js';

function fakeFs(present: Set<string>): { fs: SidecarFs; copies: Array<[string, string]> } {
  const copies: Array<[string, string]> = [];
  return {
    copies,
    fs: { exists: (p) => present.has(p), copy: (s, d) => { copies.push([s, d]); } },
  };
}

describe('copyDolbySidecars', () => {
  it('copies an existing sidecar next to the destination WAV', () => {
    const { fs, copies } = fakeFs(new Set(['/tmp/abc.eac3']));
    const out = copyDolbySidecars('/tmp/abc.wav', '/out/Master.wav', fs);
    expect(copies).toEqual([['/tmp/abc.eac3', '/out/Master.eac3']]);
    expect(out).toEqual(['/out/Master.eac3']);
  });

  it('copies multiple sidecars when present', () => {
    const { fs, copies } = fakeFs(new Set(['/tmp/x.ac3', '/tmp/x.thd']));
    copyDolbySidecars('/tmp/x.wav', '/out/y.wav', fs);
    expect(copies.map((c) => c[1]).sort()).toEqual(['/out/y.ac3', '/out/y.thd']);
  });

  it('no-op when no sidecar exists', () => {
    const { fs, copies } = fakeFs(new Set());
    expect(copyDolbySidecars('/tmp/a.wav', '/out/b.wav', fs)).toEqual([]);
    expect(copies).toEqual([]);
  });

  it('derives the destination base regardless of the dest extension', () => {
    const { fs, copies } = fakeFs(new Set(['/tmp/m.ac3']));
    copyDolbySidecars('/tmp/m.wav', '/out/Final Mix.wav', fs);
    expect(copies[0]![1]).toBe('/out/Final Mix.ac3');
  });

  it('swallows a copy failure (best-effort)', () => {
    const fs: SidecarFs = { exists: () => true, copy: () => { throw new Error('disk full'); } };
    expect(() => copyDolbySidecars('/tmp/a.wav', '/out/b.wav', fs)).not.toThrow();
  });

  it('covers all three Dolby extensions', () => {
    expect([...DOLBY_SIDECAR_EXTS]).toEqual(['ac3', 'eac3', 'thd']);
  });
});
