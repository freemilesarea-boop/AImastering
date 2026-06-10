import { describe, it, expect } from 'vitest';
import { getStemSeparator, OnnxStemSeparator, STEM_ORDER } from './stem-separation.js';

describe('stem-separation (gating)', () => {
  it('STEM_ORDER matches the Demucs source order', () => {
    expect(STEM_ORDER).toEqual(['vocals', 'drums', 'bass', 'other']);
  });

  it('getStemSeparator returns null while the model manifest is unpinned', async () => {
    expect(await getStemSeparator('/tmp/userData')).toBeNull();
  });

  it('OnnxStemSeparator is not ready without a configured model', async () => {
    const sep = new OnnxStemSeparator('/tmp/userData');
    expect(sep.id).toBe('onnx-demucs-v4');
    expect(await sep.isReady()).toBe(false);
  });
});
