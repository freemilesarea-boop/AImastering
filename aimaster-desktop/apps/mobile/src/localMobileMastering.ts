// On-device mastering for the mobile app — runs ENTIRELY in the WebView via the
// Web Audio API (OfflineAudioContext). No server, no upload, no polling. This
// replaces the Render `/v1/master` + `/v1/jobs` + `/v1/analyze` flow.
//
// MVP goal: $0 server cost + stable, usable mastering — not Ozone-grade. The DSP
// is a modest EQ + glue compression + loudness-normalize + true-peak limiter,
// rendered offline, then exported as a WAV the user can play / save / share.
//
// Pipeline: decode → analyze → EQ → dynamics → (stereo) → loudness normalize →
// limiter → WAV export → preview URL.

export interface LocalMasterOptions {
  style: string;        // balanced | warm | bright | kpop_loud | club
  targetLufs: number;   // e.g. -14
  targetTp: number;     // dBTP ceiling, e.g. -1.0
}

export interface LocalMasterResult {
  previewUrl: string;   // object URL (WAV) for <audio> playback
  blob: Blob;           // mastered WAV (the export)
  lufs: number | null;  // measured integrated loudness (approx) AFTER
  truePeak: number | null; // sample peak (dBFS) AFTER
  durationSec: number;
  style: string;
  warnings: string[];
}

export type LocalProgress = (percent: number, stage: string) => void;
export interface LocalSignal {
  cancelled?: () => boolean;
}

export type LocalErrorCode =
  | 'FILE_DECODE_FAILED'
  | 'UNSUPPORTED_FORMAT'
  | 'LOCAL_ENGINE_CRASHED'
  | 'EXPORT_FAILED'
  | 'INSUFFICIENT_MEMORY'
  | 'CANCELLED';

export class LocalMasteringError extends Error {
  code: LocalErrorCode;
  constructor(code: LocalErrorCode, message: string) {
    super(message);
    this.name = 'LocalMasteringError';
    this.code = code;
  }
}

const LARGE_DURATION_SEC = 8 * 60;   // warn beyond ~8 min
const MAX_DURATION_SEC = 20 * 60;    // hard guard (memory)

function checkCancel(sig?: LocalSignal): void {
  if (sig?.cancelled?.()) throw new LocalMasteringError('CANCELLED', 'cancelled');
}

type OAC = typeof OfflineAudioContext;
function getAudioCtor(): { AC: typeof AudioContext; OAC: OAC } {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    OfflineAudioContext?: OAC;
    webkitOfflineAudioContext?: OAC;
  };
  const AC = w.AudioContext || w.webkitAudioContext;
  const OACtor = w.OfflineAudioContext || w.webkitOfflineAudioContext;
  if (!AC || !OACtor) {
    throw new LocalMasteringError('LOCAL_ENGINE_CRASHED', '이 기기에서 오디오 엔진을 초기화할 수 없습니다.');
  }
  return { AC, OAC: OACtor };
}

// ── DSP per style (modest, safe moves) ────────────────────────────────────────
interface StyleDsp {
  lowShelfDb: number; lowShelfHz: number;
  highShelfDb: number; highShelfHz: number;
  presenceDb: number; presenceHz: number;
  compThresholdDb: number; compRatio: number; compAttack: number; compRelease: number;
}
function styleDsp(style: string): StyleDsp {
  switch (style) {
    case 'warm':
      return { lowShelfDb: 2, lowShelfHz: 120, highShelfDb: -1, highShelfHz: 9000, presenceDb: 0.5, presenceHz: 2500, compThresholdDb: -20, compRatio: 2, compAttack: 0.01, compRelease: 0.2 };
    case 'bright':
      return { lowShelfDb: 0.5, lowShelfHz: 110, highShelfDb: 3, highShelfHz: 9000, presenceDb: 1.5, presenceHz: 4000, compThresholdDb: -20, compRatio: 2, compAttack: 0.008, compRelease: 0.18 };
    case 'kpop_loud':
      return { lowShelfDb: 1.5, lowShelfHz: 90, highShelfDb: 2.5, highShelfHz: 10000, presenceDb: 2, presenceHz: 3500, compThresholdDb: -18, compRatio: 3, compAttack: 0.005, compRelease: 0.12 };
    case 'club':
      return { lowShelfDb: 3, lowShelfHz: 80, highShelfDb: 1.5, highShelfHz: 9000, presenceDb: 0.5, presenceHz: 2000, compThresholdDb: -18, compRatio: 3, compAttack: 0.006, compRelease: 0.14 };
    case 'balanced':
    default:
      return { lowShelfDb: 1, lowShelfHz: 100, highShelfDb: 1.5, highShelfHz: 9000, presenceDb: 0.5, presenceHz: 3000, compThresholdDb: -20, compRatio: 2, compAttack: 0.01, compRelease: 0.2 };
  }
}

// ── Measurement (approx; ITU-ish K-weight, good enough to hit target) ──────────
function approxLufs(buf: AudioBuffer): number {
  const ch = buf.numberOfChannels;
  let sumSq = 0;
  let n = 0;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    // light high-pass to emulate K-weighting's low cut (1st-order, fc ~120Hz)
    const a = Math.exp((-2 * Math.PI * 120) / buf.sampleRate);
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      const y = a * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = y;
      sumSq += y * y;
      n++;
    }
  }
  if (n === 0) return -70;
  const ms = sumSq / n;
  if (ms <= 1e-12) return -70;
  return -0.691 + 10 * Math.log10(ms);
}

function samplePeakDb(buf: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= 1e-9) return -120;
  return 20 * Math.log10(peak);
}

// ── WAV (16-bit PCM) ──────────────────────────────────────────────────────────
function encodeWav16(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const frames = buf.length;
  const blockAlign = ch * 2;
  const dataLen = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataLen);
  const view = new DataView(out);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, dataLen, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let s = chans[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}

async function renderGraph(
  OACtor: OAC,
  input: AudioBuffer,
  build: (oac: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode,
): Promise<AudioBuffer> {
  const oac = new OACtor(input.numberOfChannels, input.length, input.sampleRate);
  const src = oac.createBufferSource();
  src.buffer = input;
  const tail = build(oac, src);
  tail.connect(oac.destination);
  src.start();
  try {
    return await oac.startRendering();
  } catch (e) {
    throw new LocalMasteringError('LOCAL_ENGINE_CRASHED', `렌더링 실패: ${(e as Error)?.message ?? e}`);
  }
}

// ── Public entry ──────────────────────────────────────────────────────────────
export async function runLocalMastering(
  blob: Blob,
  opts: LocalMasterOptions,
  onProgress: LocalProgress = () => {},
  sig?: LocalSignal,
): Promise<LocalMasterResult> {
  const warnings: string[] = [];
  const { AC, OAC: OACtor } = getAudioCtor();

  // 1) decode
  onProgress(8, '오디오를 분석하고 있습니다');
  const ac = new AC();
  let input: AudioBuffer;
  try {
    const arr = await blob.arrayBuffer();
    input = await ac.decodeAudioData(arr.slice(0));
  } catch {
    try { await ac.close(); } catch { /* noop */ }
    throw new LocalMasteringError('UNSUPPORTED_FORMAT', '이 파일 형식은 기기에서 디코딩할 수 없습니다. WAV/MP3/M4A를 사용해 주세요.');
  }
  try { await ac.close(); } catch { /* noop */ }

  const durationSec = input.duration;
  if (durationSec > MAX_DURATION_SEC) {
    throw new LocalMasteringError('INSUFFICIENT_MEMORY', `${Math.round(MAX_DURATION_SEC / 60)}분이 넘는 파일은 기기에서 처리할 수 없습니다.`);
  }
  if (durationSec > LARGE_DURATION_SEC) {
    warnings.push('긴 파일이라 처리에 시간이 더 걸리고 메모리를 많이 사용할 수 있습니다.');
  }
  checkCancel(sig);

  const d = styleDsp(opts.style);

  // 2) EQ + dynamics (offline render)
  onProgress(35, '로컬 엔진으로 마스터링 중입니다');
  const shaped = await renderGraph(OACtor, input, (oac, src) => {
    const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 24;
    const low = oac.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = d.lowShelfHz; low.gain.value = d.lowShelfDb;
    const pres = oac.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = d.presenceHz; pres.Q.value = 1; pres.gain.value = d.presenceDb;
    const high = oac.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = d.highShelfHz; high.gain.value = d.highShelfDb;
    const comp = oac.createDynamicsCompressor();
    comp.threshold.value = d.compThresholdDb; comp.knee.value = 6; comp.ratio.value = d.compRatio;
    comp.attack.value = d.compAttack; comp.release.value = d.compRelease;
    src.connect(hp); hp.connect(low); low.connect(pres); pres.connect(high); high.connect(comp);
    return comp;
  });
  checkCancel(sig);

  // 3) loudness normalize → gain to target
  onProgress(62, '라우드니스 정규화 중입니다');
  const measured = approxLufs(shaped);
  const gainDb = Math.max(-18, Math.min(18, opts.targetLufs - measured));
  const gainLin = Math.pow(10, gainDb / 20);

  // 4) gain + true-peak limiter (DynamicsCompressor as brickwall) — offline render
  onProgress(78, '리미터 적용 중입니다');
  const ceilLin = Math.pow(10, opts.targetTp / 20);
  const mastered = await renderGraph(OACtor, shaped, (oac, src) => {
    const g = oac.createGain(); g.gain.value = gainLin;
    const lim = oac.createDynamicsCompressor();
    lim.threshold.value = Math.max(-60, opts.targetTp - 0.5);
    lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    src.connect(g); g.connect(lim);
    return lim;
  });
  checkCancel(sig);

  // safety: hard-clamp any residual inter-sample-ish overshoot to the ceiling
  for (let c = 0; c < mastered.numberOfChannels; c++) {
    const arr = mastered.getChannelData(c);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > ceilLin) arr[i] = ceilLin;
      else if (arr[i] < -ceilLin) arr[i] = -ceilLin;
    }
  }

  // 5) export WAV + preview url
  onProgress(92, 'Export 준비 중입니다');
  let outBlob: Blob;
  try {
    outBlob = new Blob([encodeWav16(mastered)], { type: 'audio/wav' });
  } catch (e) {
    throw new LocalMasteringError('EXPORT_FAILED', `내보내기 실패: ${(e as Error)?.message ?? e}`);
  }
  const previewUrl = URL.createObjectURL(outBlob);

  onProgress(100, '완료');
  return {
    previewUrl,
    blob: outBlob,
    lufs: Math.round(approxLufs(mastered) * 10) / 10,
    truePeak: Math.round(samplePeakDb(mastered) * 10) / 10,
    durationSec: Math.round(durationSec * 10) / 10,
    style: opts.style,
    warnings,
  };
}
