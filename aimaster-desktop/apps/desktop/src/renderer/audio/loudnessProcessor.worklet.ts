// AudioWorklet processor for live LUFS / TP metering.
//
// This file runs inside AudioWorkletGlobalScope (a separate JS context).
// It cannot share objects with the main thread — only postMessage payloads.
//
// Design: we run a LoudnessAnalyzer instance in this worklet, fed each
// 128-frame quantum.  Every 100 ms (~ every 4–6 quanta at 48 kHz / 128)
// we postMessage a metrics snapshot to the main thread.
//
// To keep the worklet self-contained (AudioWorkletGlobalScope module-import
// support is uneven across hosts/electron versions), we INLINE the K-weighting
// + true-peak logic here rather than importing.  The TS analyzer in
// loudnessCore.ts remains the source of truth for one-shot analysis;
// this is the streaming sibling.

/* eslint-disable @typescript-eslint/no-explicit-any */

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: any): void;

// ── K-weighting biquad (DF-I, scalar) ─────────────────────────────────────────
class _Biquad {
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(b0: number, b1: number, b2: number, a1: number, a2: number): void {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
  }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function _makeStage1(fs: number): [number, number, number, number, number] {
  const f0 = 1681.974450955533;
  const G  = 3.999843853973347;
  const Q  = 0.7071752369554196;
  const K  = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.499666774155);
  const a0 = 1 + K / Q + K * K;
  return [
    (Vh + Vb * K / Q + K * K) / a0,
    2 * (K * K - Vh) / a0,
    (Vh - Vb * K / Q + K * K) / a0,
    2 * (K * K - 1) / a0,
    (1 - K / Q + K * K) / a0,
  ];
}
function _makeStage2(fs: number): [number, number, number, number, number] {
  const f0 = 38.13547087602444;
  const Q  = 0.5003270373238773;
  const K  = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;
  return [
    1, -2, 1,
    2 * (K * K - 1) / a0,
    (1 - K / Q + K * K) / a0,
  ];
}

class _KFilter {
  s1 = new _Biquad();
  s2 = new _Biquad();
  constructor(fs: number) {
    const c1 = _makeStage1(fs);
    const c2 = _makeStage2(fs);
    this.s1.set(c1[0], c1[1], c1[2], c1[3], c1[4]);
    this.s2.set(c2[0], c2[1], c2[2], c2[3], c2[4]);
  }
  reset(): void { this.s1.reset(); this.s2.reset(); }
  process(x: number): number { return this.s2.process(this.s1.process(x)); }
}

// ── True-peak (4× polyphase, 12 taps × 4 phases = 48 taps total) ──────────────
const _PH1 = new Float32Array([
   0.0017089843750, 0.0109863281250,-0.0196533203125, 0.0332031250000,
  -0.0594482421875, 0.1373291015625, 0.9721679687500,-0.1024169921875,
   0.0476074218750,-0.0266113281250, 0.0148925781250,-0.0083007812500,
]);
const _PH2 = new Float32Array([
   0.0029296875000, 0.0196533203125,-0.0376586914062, 0.0709228515625,
  -0.1422119140625, 0.4625244140625, 0.4625244140625,-0.1422119140625,
   0.0709228515625,-0.0376586914062, 0.0196533203125, 0.0029296875000,
]);
const _PH3 = new Float32Array([
  -0.0083007812500, 0.0148925781250,-0.0266113281250, 0.0476074218750,
  -0.1024169921875, 0.9721679687500, 0.1373291015625,-0.0594482421875,
   0.0332031250000,-0.0196533203125, 0.0109863281250, 0.0017089843750,
]);
const _NTAPS = 12;

class _TPChannel {
  ring = new Float32Array(_NTAPS);
  head = 0;
  peak = 0;
  reset(): void { this.ring.fill(0); this.head = 0; this.peak = 0; }
  process(x: number): void {
    this.ring[this.head] = x;
    this.head = (this.head + 1) % _NTAPS;
    let p = Math.abs(x);
    if (p > this.peak) this.peak = p;
    let a1 = 0, a2 = 0, a3 = 0;
    let idx = this.head;
    for (let k = 0; k < _NTAPS; k++) {
      const v = this.ring[idx] as number;
      a1 += v * (_PH1[k] as number);
      a2 += v * (_PH2[k] as number);
      a3 += v * (_PH3[k] as number);
      idx = (idx + 1) % _NTAPS;
    }
    p = Math.abs(a1); if (p > this.peak) this.peak = p;
    p = Math.abs(a2); if (p > this.peak) this.peak = p;
    p = Math.abs(a3); if (p > this.peak) this.peak = p;
  }
}

// ── Channel weights ───────────────────────────────────────────────────────────
function _weights(n: number): number[] {
  switch (n) {
    case 1: return [1.0];
    case 2: return [1.0, 1.0];
    case 3: return [1.0, 1.0, 1.0];
    case 4: return [1.0, 1.0, 1.41, 1.41];
    case 5: return [1.0, 1.0, 1.0, 1.41, 1.41];
    case 6: return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];
    case 8: return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41, 1.41, 1.41];
    default: { const w = new Array<number>(n).fill(1.0); return w; }
  }
}

// ── Streaming analyzer (mirror of LoudnessAnalyzer in loudnessCore.ts) ────────
const _LUFS_OFFSET_DB = -0.691;
function _msToLufs(ms: number): number {
  if (ms <= 0) return -Infinity;
  return _LUFS_OFFSET_DB + 10 * Math.log10(ms);
}

class _Analyzer {
  channels: number;
  weights:  number[];
  fs:       number;
  kFilters: _KFilter[];
  tps:      _TPChannel[];
  subSamplesNeeded: number;
  subAccum: Float64Array;
  subSamplesIn: number;
  subBlocks: number[][] = [];
  momentaryMs: number[] = [];
  shortTermMs: number[] = [];
  lastM = -Infinity;
  lastS = -Infinity;
  totalSamples = 0;

  constructor(fs: number, channels: number) {
    this.fs       = fs;
    this.channels = channels;
    this.weights  = _weights(channels);
    this.kFilters = [];
    this.tps      = [];
    for (let c = 0; c < channels; c++) {
      this.kFilters.push(new _KFilter(fs));
      this.tps.push(new _TPChannel());
    }
    this.subSamplesNeeded = Math.round(fs * 0.1);
    this.subAccum = new Float64Array(channels);
    this.subSamplesIn = 0;
  }

  reset(): void {
    for (const f of this.kFilters) f.reset();
    for (const t of this.tps) t.reset();
    this.subAccum.fill(0);
    this.subSamplesIn = 0;
    this.subBlocks = [];
    this.momentaryMs = [];
    this.shortTermMs = [];
    this.lastM = -Infinity;
    this.lastS = -Infinity;
    this.totalSamples = 0;
  }

  feed(planar: Float32Array[]): void {
    const ch0 = planar[0] as Float32Array;
    const nFrames = ch0.length;
    const ch = Math.min(this.channels, planar.length);
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < ch; c++) {
        const x = (planar[c] as Float32Array)[f] as number;
        (this.tps[c] as _TPChannel).process(x);
        const k = (this.kFilters[c] as _KFilter).process(x);
        this.subAccum[c] = (this.subAccum[c] as number) + k * k;
      }
      this.subSamplesIn++;
      if (this.subSamplesIn >= this.subSamplesNeeded) this.commit();
    }
    this.totalSamples += nFrames;
  }

  private commit(): void {
    const N = this.subSamplesIn;
    const row: number[] = new Array(this.channels);
    for (let c = 0; c < this.channels; c++) {
      row[c] = (this.subAccum[c] as number) / N;
      this.subAccum[c] = 0;
    }
    this.subBlocks.push(row);
    this.subSamplesIn = 0;

    const n = this.subBlocks.length;
    if (n >= 4) {
      const wms = this.windowMs(n - 4, 4);
      this.momentaryMs.push(wms);
      this.lastM = _msToLufs(wms);
    } else this.momentaryMs.push(0);
    if (n >= 30) {
      const wms = this.windowMs(n - 30, 30);
      this.shortTermMs.push(wms);
      this.lastS = _msToLufs(wms);
    } else this.shortTermMs.push(0);
  }

  private windowMs(start: number, len: number): number {
    let total = 0;
    for (let c = 0; c < this.channels; c++) {
      const w = this.weights[c] as number;
      if (w === 0) continue;
      let s = 0;
      for (let i = 0; i < len; i++) s += (this.subBlocks[start + i] as number[])[c] as number;
      total += w * (s / len);
    }
    return total;
  }

  integrated(): number {
    const ABS_MS = Math.pow(10, (-70 - _LUFS_OFFSET_DB) / 10);
    const surv: number[] = [];
    for (const ms of this.momentaryMs) if (ms > ABS_MS) surv.push(ms);
    if (!surv.length) return -Infinity;
    let s = 0;
    for (const ms of surv) s += ms;
    const meanLufs = _msToLufs(s / surv.length);
    const REL_MS = Math.pow(10, (meanLufs - 10 - _LUFS_OFFSET_DB) / 10);
    let s2 = 0, n2 = 0;
    for (const ms of surv) if (ms > REL_MS) { s2 += ms; n2++; }
    return n2 ? _msToLufs(s2 / n2) : -Infinity;
  }

  truePeakDb(): number {
    let p = 0;
    for (const t of this.tps) if (t.peak > p) p = t.peak;
    return p <= 0 ? -Infinity : 20 * Math.log10(p);
  }

  perChannelTpDb(): number[] {
    return this.tps.map((t) => t.peak <= 0 ? -Infinity : 20 * Math.log10(t.peak));
  }
}

// ── Worklet processor ────────────────────────────────────────────────────────
class LoudnessProcessor extends AudioWorkletProcessor {
  private an:        _Analyzer | null = null;
  private updateMs   = 100;
  private lastEmitMs = 0;
  private quantumMs  = (128 / sampleRate) * 1000;

  constructor(options?: any) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    this.updateMs = typeof opts.updateMs === 'number' ? opts.updateMs : 100;

    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data || {};
      if (msg.type === 'reset') {
        if (this.an) this.an.reset();
        this.lastEmitMs = 0;
      } else if (msg.type === 'setUpdateMs') {
        this.updateMs = Math.max(20, msg.value | 0);
      } else if (msg.type === 'snapshot') {
        // Forced snapshot — used by stream consumer at end of stream.
        this.emit();
      }
    };
  }

  private emit(): void {
    if (!this.an) return;
    this.port.postMessage({
      type: 'metrics',
      momentaryLufs:  this.an.lastM,
      shortTermLufs:  this.an.lastS,
      integratedLufs: this.an.integrated(),
      truePeakDbtp:   this.an.truePeakDb(),
      perChannelTpDb: this.an.perChannelTpDb(),
      durationSec:    this.an.totalSamples / this.an.fs,
      blocksAnalyzed: this.an.subBlocks.length,
      ts:             currentTime,
    });
  }

  process(inputs: Float32Array[][]): boolean {
    const inp = inputs[0];
    if (!inp || inp.length === 0 || (inp[0] as Float32Array | undefined)?.length === 0) return true;
    const ch = inp.length;
    if (!this.an || this.an.channels !== ch) {
      this.an = new _Analyzer(sampleRate, ch);
      this.lastEmitMs = 0;
    }
    this.an.feed(inp);

    const elapsedMs = this.an.totalSamples / this.an.fs * 1000;
    if (elapsedMs - this.lastEmitMs >= this.updateMs) {
      this.lastEmitMs = elapsedMs;
      this.emit();
    }
    return true;
  }
}

registerProcessor('loudness-processor', LoudnessProcessor);
