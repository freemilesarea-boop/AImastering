// stem-mixer-graph — the mixer, as a Web Audio graph.
//
// One channel strip per stem:
//
//     AudioBufferSource ─▶ splitter ─┬─▶ gainL ─┐
//                                    └─▶ gainR ─┴─▶ merger ─▶ sum
//
// # Why a splitter and two gains instead of a StereoPannerNode
//
// `StereoPannerNode` implements an equal-power pan law. The offline render
// implements a BALANCE — a stereo channel attenuates the far side and leaves
// the near one alone — because that is what a mixer's stereo channel does
// and because these stems already carry a stereo image that an equal-power
// law would squeeze.
//
// Using the browser's panner here and balance in the export would mean the
// preview and the file disagree by up to 3 dB per side. In a mastering tool
// "it sounded different when I exported it" is the worst class of bug there
// is, so the preview computes its gains with the SAME function the renderer
// uses, and `stem-preview-selftest` renders both and compares them.
//
// # What this file is not
//
// It holds no transport, no buffers and no state. It builds a graph and
// hands back the handles for changing it, so the same construction can be
// driven by the live engine and by an OfflineAudioContext in a test.

/** The subset of the Web Audio API this file needs. */
export interface MixerContext {
  createGain(): GainNode;
  createChannelSplitter(numberOfOutputs?: number): ChannelSplitterNode;
  createChannelMerger(numberOfInputs?: number): ChannelMergerNode;
  readonly sampleRate: number;
  readonly currentTime: number;
}

export interface StripSettings {
  gainDb: number;
  /** Balance, -1 (hard left) .. +1 (hard right). */
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface MixerStrip {
  /** Where the stem's source connects. */
  input: AudioNode;
  /** Left and right leg gains — set together, never individually. */
  setGains(l: number, r: number, atTime: number, rampMs: number): void;
  disconnect(): void;
}

/**
 * Balance gains for a stereo channel.
 *
 * Deliberately duplicated from `main/offline/stem-render.ts` rather than
 * imported: the renderer and the main process do not share a module here,
 * and a preview that silently drifted from the export would be worse than
 * two copies that a test compares. `stem-preview-selftest` renders the same
 * settings through both and fails on any difference.
 */
export function balanceGains(pan: number): { l: number; r: number } {
  const p = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
  return { l: p <= 0 ? 1 : 1 - p, r: p >= 0 ? 1 : 1 + p };
}

export function dbToLin(db: number): number {
  return Math.pow(10, (Number.isFinite(db) ? db : 0) / 20);
}

/** Who is audible. Mirrors `audibleTracks` in the offline renderer. */
export function audibleFlags(strips: readonly StripSettings[]): boolean[] {
  const anySolo = strips.some((s) => s.solo && !s.mute);
  return strips.map((s) => (s.mute ? false : anySolo ? s.solo : true));
}

/**
 * The final left/right gains for every strip, including mute and solo.
 *
 * One function for the whole mixer rather than one per strip, because solo
 * is not a property of a channel — it is a property of the session, and a
 * per-strip calculation cannot see the other channels' solo buttons.
 */
export function stripGains(strips: readonly StripSettings[]): Array<{ l: number; r: number }> {
  const audible = audibleFlags(strips);
  return strips.map((s, i) => {
    if (!audible[i]) return { l: 0, r: 0 };
    const g = dbToLin(s.gainDb);
    const b = balanceGains(s.pan);
    return { l: g * b.l, r: g * b.r };
  });
}

/**
 * Build one channel strip and connect it to `destination`.
 *
 * The gains ramp rather than jump. A fader dragged across a `AudioParam`
 * that is set instantly produces a step in the waveform on every pointer
 * move, which is a click — and during a mix the user is dragging faders
 * constantly, so it would click constantly.
 */
export function createStrip(ctx: MixerContext, destination: AudioNode, channels: 1 | 2): MixerStrip {
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  // A mono source feeds output 0 only, so the right leg would be silent.
  // Reading channel 0 twice is what makes a mono stem play centred instead
  // of hard left — and folding a centred stem to mono is exactly what the
  // preview render does to save memory, so this is the common case.
  splitter.connect(gainL, 0);
  splitter.connect(gainR, channels === 1 ? 0 : 1);
  gainL.connect(merger, 0, 0);
  gainR.connect(merger, 0, 1);
  merger.connect(destination);

  return {
    input: splitter,
    setGains(l, r, atTime, rampMs) {
      const t = Math.max(atTime, ctx.currentTime);
      const end = t + Math.max(0, rampMs) / 1000;
      for (const [param, value] of [[gainL.gain, l], [gainR.gain, r]] as const) {
        // Anchor at the current value first: without it the ramp starts
        // from whatever the last scheduled event left, which after a drag
        // is not where the audio actually is.
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
        param.linearRampToValueAtTime(value, end);
      }
    },
    disconnect() {
      try { merger.disconnect(); } catch { /* already torn down */ }
      try { gainL.disconnect(); } catch { /* already torn down */ }
      try { gainR.disconnect(); } catch { /* already torn down */ }
      try { splitter.disconnect(); } catch { /* already torn down */ }
    },
  };
}

// ── Memory ───────────────────────────────────────────────────────────────────

/**
 * What holding a session for playback costs.
 *
 * This is the real constraint on realtime multitrack, and it is worth being
 * explicit about rather than discovering as a crash. An AudioBuffer is
 * float32 per channel and is not compressed: one 4-minute stereo stem at
 * 48 kHz is 92 MB, and a twelve-stem session is over a gigabyte before
 * anything else the app is holding.
 *
 * Mono folding in the preview render is what makes this affordable — a
 * centred kick, bass or lead vocal costs half — but a wide session is still
 * capable of exhausting the renderer, so the caller checks before decoding
 * rather than after.
 */
export function previewMemoryBytes(
  stems: ReadonlyArray<{ samples: number; channels: 1 | 2 }>,
): number {
  return stems.reduce((sum, s) => sum + s.samples * s.channels * 4, 0);
}

/**
 * Most memory a preview session may occupy.
 *
 * Chosen to leave the rest of the renderer room to work rather than to be
 * the largest number that happens not to crash: a session past this is
 * still fully renderable and exportable, it just cannot all be held in
 * memory at once, and the honest response is to say so and offer solo.
 */
export const PREVIEW_MEMORY_LIMIT_BYTES = 1_200_000_000;

export function previewFitsInMemory(
  stems: ReadonlyArray<{ samples: number; channels: 1 | 2 }>,
): { fits: boolean; bytes: number; limit: number } {
  const bytes = previewMemoryBytes(stems);
  return { fits: bytes <= PREVIEW_MEMORY_LIMIT_BYTES, bytes, limit: PREVIEW_MEMORY_LIMIT_BYTES };
}
