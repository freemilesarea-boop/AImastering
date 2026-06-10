import { describe, it, expect } from 'vitest';
import { buildAdmXml, buildChnaPayload, wrapAdmBwf } from './adm.js';
import { LAYOUT_CHANNELS } from './surround.js';

// Minimal valid RIFF/WAVE buffer (header + tiny fmt + data) for wrapping tests.
function fakeWav(): Buffer {
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4);
  const data = Buffer.alloc(8 + 12);
  data.write('data', 0, 'ascii'); data.writeUInt32LE(12, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('buildAdmXml', () => {
  it('is well-formed and bed-typed for 5.1', () => {
    const xml = buildAdmXml('5.1');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('typeDefinition="DirectSpeakers"');
    expect(xml).toContain('audioProgrammeID="APR_1001"');
    // one channelFormat per channel
    const count = (xml.match(/<audioChannelFormat /g) ?? []).length;
    expect(count).toBe(LAYOUT_CHANNELS['5.1'].length);
    // balanced tags (rough well-formedness)
    expect((xml.match(/<audioObject /g) ?? []).length).toBe(1);
    expect(xml).toContain('</ebuCoreMain>');
  });
  it('marks LFE with a low-pass frequency', () => {
    expect(buildAdmXml('5.1')).toContain('<frequency typeDefinition="lowPass">');
  });
  it('7.1 declares 8 channels + track UIDs', () => {
    const xml = buildAdmXml('7.1');
    expect((xml.match(/<audioChannelFormat /g) ?? []).length).toBe(8);
    expect((xml.match(/<audioTrackUID /g) ?? []).length).toBe(8);
  });
});

describe('buildChnaPayload', () => {
  it('has the right size + track/UID counts + 1-based indices', () => {
    const n = LAYOUT_CHANNELS['5.1'].length;
    const buf = buildChnaPayload('5.1');
    expect(buf.length).toBe(4 + n * 40);
    expect(buf.readUInt16LE(0)).toBe(n); // numTracks
    expect(buf.readUInt16LE(2)).toBe(n); // numUIDs
    expect(buf.readUInt16LE(4)).toBe(1); // first track index (1-based)
    expect(buf.toString('ascii', 6, 18)).toBe('ATU_00001001'); // first UID
  });
});

describe('wrapAdmBwf', () => {
  it('appends chna + axml and fixes the RIFF size', () => {
    const wav = fakeWav();
    const out = wrapAdmBwf(wav, '5.1');
    expect(out.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.toString('ascii', 8, 12)).toBe('WAVE');
    expect(out.includes(Buffer.from('chna', 'ascii'))).toBe(true);
    expect(out.includes(Buffer.from('axml', 'ascii'))).toBe(true);
    expect(out.readUInt32LE(4)).toBe(out.length - 8); // RIFF size updated
    expect(out.length).toBeGreaterThan(wav.length);
  });
  it('throws on a non-RIFF buffer', () => {
    expect(() => wrapAdmBwf(Buffer.from('not a wav'), '5.1')).toThrow();
  });
});
