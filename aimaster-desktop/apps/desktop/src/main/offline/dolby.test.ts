import { describe, it, expect } from 'vitest';
import { dolbyExt, dolbyEncodeArgs, isDolbyEnabled, dolbyLabel, DOLBY_CODECS } from './dolby.js';

describe('dolby helpers', () => {
  it('extensions per codec', () => {
    expect(dolbyExt('ac3')).toBe('.ac3');
    expect(dolbyExt('eac3')).toBe('.eac3');
    expect(dolbyExt('truehd')).toBe('.thd');
    expect(dolbyExt('none')).toBe('');
  });

  it('encode args carry the right ffmpeg codec', () => {
    expect(dolbyEncodeArgs('ac3')).toContain('ac3');
    expect(dolbyEncodeArgs('eac3')).toContain('eac3');
    expect(dolbyEncodeArgs('truehd')).toContain('truehd');
    expect(dolbyEncodeArgs('truehd')).toEqual(expect.arrayContaining(['-strict', 'experimental'])); // experimental encoder
    expect(dolbyEncodeArgs('none')).toEqual([]);
  });

  it('isDolbyEnabled is false only for none/undefined', () => {
    expect(isDolbyEnabled('none')).toBe(false);
    expect(isDolbyEnabled(undefined)).toBe(false);
    expect(isDolbyEnabled('ac3')).toBe(true);
  });

  it('labels exist for every codec', () => {
    for (const c of DOLBY_CODECS) expect(dolbyLabel(c).length).toBeGreaterThan(0);
  });
});
