// Vitest global setup — runs once before the test files.
//
// jsdom does not implement a few WebAudio / canvas APIs that renderer modules
// may touch on import.  We stub only what is needed so component tests can
// mount without a real audio device.  Pure-logic tests don't rely on these.

import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees + reset DOM between tests.
afterEach(() => {
  cleanup();
});

// Minimal AudioContext stub (jsdom has none).  Renderer audio modules guard
// their use, but importing some of them constructs nodes lazily; keep a safe
// no-op so a stray construction never throws in tests.
if (typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'undefined') {
  class FakeParam { value = 0; setValueAtTime(): void {} }
  class FakeNode {
    gain = new FakeParam();
    frequency = new FakeParam();
    Q = new FakeParam();
    type = '';
    connect(): void {}
    disconnect(): void {}
  }
  class FakeAudioContext {
    sampleRate = 48000;
    state = 'running';
    destination = new FakeNode();
    createGain(): FakeNode { return new FakeNode(); }
    createBiquadFilter(): FakeNode { return new FakeNode(); }
    createAnalyser(): FakeNode { return new FakeNode(); }
    createChannelSplitter(): FakeNode { return new FakeNode(); }
    createChannelMerger(): FakeNode { return new FakeNode(); }
    createDynamicsCompressor(): FakeNode { return new FakeNode(); }
    createMediaElementSource(): FakeNode { return new FakeNode(); }
    resume(): Promise<void> { return Promise.resolve(); }
  }
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext as unknown;
}

// Silence noisy console.warn fallbacks during expected-failure routing tests.
vi.spyOn(console, 'warn').mockImplementation(() => {});
