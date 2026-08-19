// RecordBuffer — the growing tape.
//
// Chunks arrive from the worklet as small Float32Arrays; a take is however
// many of them the player felt like producing.  Keeping the chunks and
// concatenating once at the end is O(n) with no re-allocation churn, and it
// keeps this class pure enough to unit-test without an audio context.

export class RecordBuffer {
  readonly sampleRate: number;
  readonly channelCount: number;
  private chunks: Float32Array[][] = [];
  private frames = 0;

  constructor(sampleRate: number, channelCount: number) {
    this.sampleRate = sampleRate;
    this.channelCount = Math.max(1, channelCount);
  }

  get frameCount(): number { return this.frames; }
  get durationSec(): number { return this.frames / this.sampleRate; }
  get isEmpty(): boolean { return this.frames === 0; }

  /** Append one block.  Missing channels are filled from the last one given. */
  push(channels: readonly Float32Array[]): void {
    if (channels.length === 0) return;
    const length = channels[0]?.length ?? 0;
    if (length === 0) return;
    const row: Float32Array[] = [];
    for (let c = 0; c < this.channelCount; c++) {
      row.push(channels[Math.min(c, channels.length - 1)] ?? new Float32Array(length));
    }
    this.chunks.push(row);
    this.frames += length;
  }

  clear(): void {
    this.chunks = [];
    this.frames = 0;
  }

  /** Flatten to one array per channel. */
  toChannels(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < this.channelCount; c++) out.push(new Float32Array(this.frames));
    let offset = 0;
    for (const row of this.chunks) {
      const length = row[0]?.length ?? 0;
      for (let c = 0; c < this.channelCount; c++) {
        const source = row[c];
        if (source) (out[c] as Float32Array).set(source, offset);
      }
      offset += length;
    }
    return out;
  }

  /**
   * Flatten a time slice.  Used to drop the pre-roll (which was recorded so
   * the player could hear their way in, not so it could be kept) and to cut
   * loop passes apart.
   */
  slice(fromSec: number, toSec: number): Float32Array[] {
    const from = Math.max(0, Math.round(fromSec * this.sampleRate));
    const to = Math.min(this.frames, Math.round(toSec * this.sampleRate));
    const length = Math.max(0, to - from);
    const full = this.toChannels();
    return full.map((ch) => ch.subarray(from, from + length).slice());
  }
}
