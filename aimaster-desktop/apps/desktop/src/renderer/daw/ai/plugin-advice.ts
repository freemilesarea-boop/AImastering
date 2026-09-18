// What each device should be set to, for THIS audio.
//
// ── The rule that makes this worth having ──────────────────────────────────
//
// Every number an advisor returns must come from a measurement in the
// `SourceProfile`, and the advisor must be able to name the measurement.  A
// recommendation that cannot say WHY is a preset with a story attached, and a
// preset with a story is worse than a preset, because you believe it.
//
// So each advisor returns `evidence`: the numbers it read, in the units they
// were measured in.  If you disagree with the setting you can check the
// reading it came from, which is the only way a suggestion can be argued with.
//
// ── When an advisor refuses ────────────────────────────────────────────────
//
// Three cases, and all three say so rather than returning something plausible:
//
//   the source is silent          nothing to measure
//   nothing is wrong              a compressor on already-even audio is damage
//   the knob is not a measurement  dither depth is a delivery decision, and no
//                                  amount of listening to the audio decides it
//
// A device that always has an opinion is a device whose opinion is worthless.

import type { SourceProfile } from './source-profile.js';
import { findPlugin } from '../engine/plugins.js';

export interface PluginAdvice {
  pluginId: string;
  /** The complete parameter map to apply — defaults, with the advice on top. */
  params: Record<string, number>;
  /** One line: what this does to this audio. */
  headline: string;
  /** The readings it came from, in their own units. */
  evidence: string[];
  /** 0…1.  Under 0.45 the UI calls it a starting point rather than a fix. */
  confidence: number;
}

export type AdviceResult =
  | { ok: true; advice: PluginAdvice }
  | { ok: false; reason: string };

interface Draft {
  params: Record<string, number>;
  headline: string;
  evidence: string[];
  confidence: number;
}

type Advisor = (p: SourceProfile) => Draft | { refuse: string };

// ── Small helpers ───────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const round = (v: number, step = 0.1): number => Math.round(v / step) * step;
const db = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
const hz = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const ms = (v: number): string => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;

/** One beat, in milliseconds, at the tempo this was measured at. */
const beatMs = (p: SourceProfile, division = 1): number =>
  (60_000 / Math.max(20, p.tempoBpm)) * division;

/** How percussive this is, 0 (a pad) … 1 (a close-miked snare). */
const percussive = (p: SourceProfile): number =>
  clamp((p.crestDb - 8) / 12, 0, 1);

const isDrum = (p: SourceProfile): boolean =>
  p.role.role === 'kick' || p.role.role === 'snare' || p.role.role === 'hat'
  || p.role.role === 'drums';
const isVoice = (p: SourceProfile): boolean =>
  p.role.role === 'vocal' || p.role.role === 'backing';
const isLowEnd = (p: SourceProfile): boolean =>
  p.role.role === 'bass' || p.role.role === 'kick';

/**
 * Where a high-pass belongs on this source.
 *
 * Below the energy, not into it: the corner sits a little under the measured
 * roll-off so nothing that is part of the sound is removed.  A bass or a kick
 * gets almost nothing, because on those the roll-off IS the instrument.
 */
function highPassHz(p: SourceProfile): number {
  if (isLowEnd(p)) return clamp(p.lowRolloffHz * 0.45, 20, 45);
  return clamp(p.lowRolloffHz * 0.8, 20, 300);
}

// ── The advisors ────────────────────────────────────────────────────────────

const ADVISORS: Record<string, Advisor> = {

  // ── Utility ─────────────────────────────────────────────────────────────

  trim: (p) => {
    // Bring the channel to a working level: −18 dBFS RMS is where the rest of
    // the chain was calibrated to expect it, and it leaves headroom for
    // everything after.
    const target = -18;
    const gain = clamp(round(target - p.rmsDb, 0.5), -24, 24);
    if (Math.abs(gain) < 1) return { refuse: '이미 적정 레벨입니다 (−18 dBFS 근처)' };
    return {
      params: { gainDb: gain },
      headline: `${db(gain)} — 채널을 −18 dBFS 작업 레벨로`,
      evidence: [`RMS ${db(p.rmsDb)}`, `피크 ${db(p.peakDb)}`],
      confidence: 0.8,
    };
  },

  phase: (p) => {
    if (p.channels < 2) return { refuse: '모노 소스라 위상 문제가 없습니다' };
    if (p.correlation > -0.2) {
      return { refuse: `상관도 ${p.correlation.toFixed(2)} — 위상은 정상입니다` };
    }
    return {
      params: { invertL: 0, invertR: 1, swap: 0, mono: 0 },
      headline: '오른쪽 채널 위상 반전 — 모노에서 사라지던 소리를 되살립니다',
      evidence: [`상관도 ${p.correlation.toFixed(2)} (음수 = 역상)`,
        `저역 상관도 ${p.bassCorrelation.toFixed(2)}`],
      confidence: p.correlation < -0.5 ? 0.85 : 0.5,
    };
  },

  dcblock: () => ({ refuse: '설정할 파라미터가 없습니다 — 켜면 그게 전부입니다' }),

  // ── EQ ──────────────────────────────────────────────────────────────────

  eq3: (p) => {
    const hpf = clamp(round(highPassHz(p), 5), 20, 400);
    const low = clamp(round(-p.mudDb * 0.6, 0.5), -18, 18);
    const mid = clamp(round(-(p.resonance?.excessDb ?? 0) * 0.4, 0.5), -18, 18);
    const midHz = clamp(p.resonance?.hz ?? 1000, 200, 8000);
    const high = clamp(round(p.airDb < -8 ? Math.min(4, -p.airDb * 0.3) : 0, 0.5), -18, 18);
    const evidence = [`저역 시작 ${hz(p.lowRolloffHz)}`, `머드(180–350) ${db(p.mudDb)}`,
      `에어(10 k+) ${db(p.airDb)}`];
    if (p.resonance) evidence.push(`공진 ${hz(p.resonance.hz)} ${db(p.resonance.excessDb)}`);
    return {
      params: { hpfHz: hpf, lowDb: low, midDb: mid, midHz, highDb: high },
      headline: `${hz(hpf)} 하이패스${low < -0.5 ? ` · 머드 ${db(low)}` : ''}${high > 0.5 ? ` · 에어 ${db(high)}` : ''}`,
      evidence,
      confidence: 0.7,
    };
  },

  matcheq: (p) => {
    // The curve is NOT advised, and cannot be: it is the difference between a
    // reference's spectrum and this one, and an advisor is handed only this
    // one.  What it CAN decide is what to do with a curve once it exists, and
    // those three controls are where a match is won or lost.
    //
    //   · SMOOTH separates tonality from arrangement.  Two pieces of music
    //     never agree band to band, and the finer the resolution the more of
    //     the disagreement is which note was played.  A dense, busy source
    //     needs more smoothing than a sparse one — and density reads as a low
    //     crest factor, because everything is sounding at once.
    //   · LIMIT is how far a reference may be believed.  A source whose low
    //     end starts high is missing a sub the reference may well have, and
    //     the difference there will be enormous and meaningless.
    //   · AMOUNT belongs under 100 always.  Matching a reference exactly
    //     makes a worse copy of it, and the number engineers settle on is
    //     around two thirds.
    const dense = 1 - percussive(p);
    const smoothOct = clamp(round(0.3 + dense * 0.5, 0.05), 0.2, 1);
    // A source with no bottom cannot be given one by an EQ, so the limit is
    // tightened rather than letting the curve ask for twenty decibels of it.
    const thin = p.lowRolloffHz > 90;
    const limitDb = clamp(round(thin ? 4 : 7, 0.5), 0, 18);
    const amount = 0.65;
    return {
      params: {
        amount, smoothOct, limitDb,
        // The middle length, measured rather than assumed.  A match curve is
        // NOT broad enough for the shortest response — a band is 164 Hz wide
        // at 785 Hz and 255 taps only build down to 1478 Hz — and on a 5.5 dB
        // gap the middle length closed 1.24 dB of it against the short one's
        // 1.75, for eight milliseconds more delay.  The long one reached 1.16
        // for four times that, which is not a trade worth advising.
        length: 1,
        mix: 1, outDb: 0,
      },
      headline: `${Math.round(amount * 100)}% · ${smoothOct.toFixed(2)} 옥타브 평활 · `
        + `한계 ${limitDb.toFixed(0)} dB — 커브는 레퍼런스를 재야 생깁니다`,
      evidence: [
        `크레스트 ${p.crestDb.toFixed(1)} dB`,
        `저역 시작 ${hz(p.lowRolloffHz)}`,
        `중심 ${hz(p.centroidHz)}`,
      ],
      // The three knobs follow the source; the curve is a measurement this
      // advisor never sees, so it is not claiming to have matched anything.
      confidence: 0.4,
    };
  },

  linphase: (p) => {
    // The same corrective moves eq8 would make, decided the same way — but
    // the LENGTH is the decision this device adds, and a measurement can
    // genuinely make it.  Two things pull against each other:
    //
    //   · detail.  The response can only resolve what it is long enough to
    //     resolve: 255 taps reach about 190 Hz at 48 kHz, 1023 about 47.  A
    //     narrow cut low down needs the long one or it simply does not happen.
    //   · PRE-RINGING.  A symmetric response rings ahead of the transient as
    //     well as behind it, and longer means the ringing starts earlier.  On
    //     a close-miked snare that is a tick before the hit.
    //
    // So: percussive material gets the short one and pays in accuracy;
    // sustained material gets the long one, because there is no transient for
    // the pre-ringing to sit in front of.
    const perc = percussive(p);
    const needsLowDetail = p.lowRolloffHz < 120 || (p.resonance?.hz ?? 1000) < 300;
    const length = perc > 0.6 ? 0 : (needsLowDetail ? 2 : 1);

    const hpf = clamp(round(highPassHz(p), 5), 20, 500);
    const mud = clamp(round(-p.mudDb * 0.7, 0.5), -18, 18);
    const air = clamp(round(p.airDb < -6 ? Math.min(4, -p.airDb * 0.35) : 0, 0.5), -18, 18);
    const b1Hz = clamp(p.resonance?.hz ?? 400, 100, 2000);
    const b1Q = p.resonance ? clamp(2 + p.resonance.excessDb / 3, 1, 8) : 1.2;
    const b1Db = p.resonance
      ? clamp(round(-p.resonance.excessDb * 0.5, 0.5), -18, 0) : mud;
    const harsh = clamp(round(-Math.max(0, p.harshDb) * 0.5, 0.5), -18, 0);

    const taps = [255, 1023, 4095][length] ?? 1023;
    const evidence = [
      `크레스트 ${p.crestDb.toFixed(1)} dB`,
      `저역 시작 ${hz(p.lowRolloffHz)}`,
      `머드 ${db(p.mudDb)}`,
      `에어 ${db(p.airDb)}`,
    ];
    if (p.resonance) evidence.push(`공진 ${hz(p.resonance.hz)} ${db(p.resonance.excessDb)}`);
    return {
      params: {
        hpfHz: hpf,
        lowDb: mud, lowHz: 120,
        b1Db, b1Hz, b1Q,
        b2Db: harsh, b2Hz: clamp(p.sibilanceHz > 0 ? Math.min(p.sibilanceHz, 5000) : 3000, 500, 12000),
        b2Q: 1.2,
        highDb: air, highHz: 9000,
        length,
        mix: 1,
        outDb: 0,
      },
      headline: `${taps}탭 (${((taps - 1) / 2 / 48_000 * 1000).toFixed(1)} ms 지연) — `
        + (perc > 0.6
          ? `크레스트 ${p.crestDb.toFixed(1)} dB, 트랜지언트 앞의 프리링잉을 짧게`
          : (needsLowDetail
            ? `저역 ${hz(p.lowRolloffHz)} 을 분해하려면 이만큼 길어야 합니다`
            : '분해능과 지연이 균형을 이루는 길이')),
      evidence,
      // The curve is as confident as eq8's; the LENGTH is a judgement about
      // how much pre-ringing somebody will accept, and that is not measurable.
      confidence: 0.55,
    };
  },

  eq8: (p) => {
    const hpf = clamp(round(highPassHz(p), 5), 20, 1000);
    const mud = clamp(round(-p.mudDb * 0.7, 0.5), -18, 18);
    const box = clamp(round(-p.boxDb * 0.5, 0.5), -18, 18);
    const harsh = clamp(round(-Math.max(0, p.harshDb) * 0.5, 0.5), -18, 0);
    const air = clamp(round(p.airDb < -6 ? Math.min(4, -p.airDb * 0.35) : 0, 0.5), -18, 18);
    // The narrow band goes on the resonance when there is one; otherwise it
    // sits on the box region at a gentle Q, where it can do no harm.
    const b1Hz = clamp(p.resonance?.hz ?? 300, 60, 2000);
    const b1Q = p.resonance ? clamp(2 + p.resonance.excessDb / 3, 1, 8) : 1;
    const b1Db = p.resonance
      ? clamp(round(-p.resonance.excessDb * 0.5, 0.5), -18, 0) : mud;
    const lpf = clamp(round(Math.min(20000, p.highRolloffHz * 1.6), 100), 2000, 20000);

    const evidence = [`저역 시작 ${hz(p.lowRolloffHz)}`, `머드 ${db(p.mudDb)}`,
      `박스 ${db(p.boxDb)}`, `하시 ${db(p.harshDb)}`, `에어 ${db(p.airDb)}`];
    if (p.resonance) evidence.push(`공진 ${hz(p.resonance.hz)} ${db(p.resonance.excessDb)}`);
    return {
      params: {
        hpfHz: hpf,
        lowDb: mud, lowHz: 120,
        b1Db, b1Hz, b1Q,
        b2Db: box, b2Hz: clamp(500, 200, 8000), b2Q: 1.2,
        b3Db: harsh, b3Hz: clamp(p.sibilanceHz > 0 ? Math.min(p.sibilanceHz, 5000) : 3500, 800, 16000), b3Q: 1.4,
        highDb: air, highHz: 9000,
        lpfHz: lpf,
      },
      headline: p.resonance
        ? `${hz(hpf)} HPF · ${hz(p.resonance.hz)} 공진 ${db(b1Db)}`
        : `${hz(hpf)} HPF · 머드 ${db(mud)} · 에어 ${db(air)}`,
      evidence,
      confidence: p.resonance ? 0.75 : 0.6,
    };
  },

  tilt: (p) => {
    // The centroid says which way the source leans; the tilt leans it back,
    // but only part of the way — a dark guitar should still be a dark guitar.
    const targetHz = isVoice(p) ? 2200 : isDrum(p) ? 2600 : 1800;
    const octaves = Math.log2(clamp(p.centroidHz, 80, 12000) / targetHz);
    const tilt = clamp(round(-octaves * 2.2, 0.5), -12, 12);
    if (Math.abs(tilt) < 0.5) return { refuse: `스펙트럼 무게중심 ${hz(p.centroidHz)} — 기울일 필요가 없습니다` };
    return {
      params: { tiltDb: tilt, pivotHz: 1000 },
      headline: `${db(tilt)} 틸트 — ${tilt > 0 ? '밝게' : '어둡게'}`,
      evidence: [`무게중심 ${hz(p.centroidHz)}`, `목표 ${hz(targetHz)}`],
      confidence: 0.5,
    };
  },

  mseq: (p) => {
    if (p.channels < 2) return { refuse: '모노 소스입니다' };
    const sideLow = clamp(round(p.bassCorrelation < 0.6 ? -6 : -2, 0.5), -12, 12);
    const sideHigh = clamp(round(p.widthPercent < 40 ? 2.5 : 0, 0.5), -12, 12);
    return {
      params: { midLowDb: 0, midHighDb: 0, sideLowDb: sideLow, sideHighDb: sideHigh },
      headline: `사이드 저역 ${db(sideLow)}${sideHigh > 0.5 ? ` · 사이드 고역 ${db(sideHigh)}` : ''}`,
      evidence: [`저역 상관도 ${p.bassCorrelation.toFixed(2)}`, `폭 ${Math.round(p.widthPercent)} %`],
      confidence: 0.55,
    };
  },

  exciter: (p) => {
    if (p.airDb > -3) return { refuse: `고역이 이미 충분합니다 (에어 ${db(p.airDb)})` };
    const amount = clamp(round(Math.min(0.5, -p.airDb / 24), 0.05), 0, 1);
    const freq = clamp(round(Math.max(3000, p.highRolloffHz * 0.7), 100), 1500, 12000);
    return {
      params: { amount, freqHz: freq, mix: clamp(round(amount * 0.8, 0.05), 0, 1) },
      headline: `${hz(freq)} 위로 배음 추가 — 소스에 없는 고역을 만듭니다`,
      evidence: [`에어 ${db(p.airDb)}`, `고역 끝 ${hz(p.highRolloffHz)}`],
      confidence: 0.55,
    };
  },

  dyneq: (p) => {
    // Dynamic EQ is for a problem that comes and goes, so it goes on the
    // resonance if there is one, and on the mud otherwise.
    const target = p.resonance ?? (p.mudDb > 3 ? { hz: 250, excessDb: p.mudDb } : null);
    if (!target) return { refuse: '눌러야 할 특정 대역이 없습니다' };
    return {
      params: {
        freqHz: clamp(target.hz, 60, 12000),
        q: clamp(round(1.5 + target.excessDb / 4, 0.1), 0.3, 8),
        thresholdDb: clamp(round(p.rmsDb + 4, 1), -48, 0),
        rangeDb: clamp(round(-Math.min(9, target.excessDb * 0.8), 0.5), -18, 0),
      },
      headline: `${hz(target.hz)} 를 클 때만 ${db(-Math.min(9, target.excessDb * 0.8))}`,
      evidence: [`대역 초과 ${db(target.excessDb)}`, `RMS ${db(p.rmsDb)}`],
      confidence: 0.6,
    };
  },

  // ── Dynamics ────────────────────────────────────────────────────────────

  comp: (p) => {
    if (p.dynamicRangeDb < 3) {
      return { refuse: `다이내믹 레인지 ${p.dynamicRangeDb.toFixed(1)} dB — 이미 평탄합니다` };
    }
    // Threshold under the loud parts, ratio from how uneven it is, attack
    // from how fast this source rises, release from how fast it falls.
    const threshold = clamp(round(p.rmsDb + 2, 0.5), -60, 0);
    const ratio = clamp(round(1.8 + p.dynamicRangeDb / 6, 0.1), 1, 20);
    const attack = clamp(round(isDrum(p) ? p.attackMs * 0.5 : p.attackMs * 1.4, 0.1), 0.1, 100);
    const release = clamp(round(Math.max(60, p.decayMs * 0.7), 5), 10, 1000);
    const reduction = Math.min(8, (p.rmsDb + 2 - threshold) + p.dynamicRangeDb / ratio);
    return {
      params: {
        thresholdDb: threshold,
        ratio,
        kneeDb: percussive(p) > 0.6 ? 3 : 9,
        attackMs: attack,
        releaseMs: release,
        makeupDb: clamp(round(Math.max(0, reduction * 0.7), 0.5), 0, 24),
      },
      headline: `${ratio.toFixed(1)}:1 · ${ms(attack)} 어택 — ${p.dynamicRangeDb.toFixed(0)} dB 편차를 고릅니다`,
      evidence: [`다이내믹 레인지 ${p.dynamicRangeDb.toFixed(1)} dB`, `크레스트 ${p.crestDb.toFixed(1)} dB`,
        `어택 ${ms(p.attackMs)}`, `감쇠 ${ms(p.decayMs)}`],
      confidence: 0.75,
    };
  },

  ducker: (p) => ({
    params: {
      thresholdDb: clamp(round(p.rmsDb - 6, 1), -60, 0),
      ratio: 6,
      attackMs: clamp(round(Math.max(5, p.attackMs), 1), 5, 200),
      releaseMs: clamp(round(Math.max(80, p.decayMs * 0.6), 10), 20, 1000),
      makeupDb: 0,
    },
    headline: '키 입력이 들어올 때 비켜줍니다 — 사이드체인 소스를 지정하세요',
    evidence: [`RMS ${db(p.rmsDb)}`, `감쇠 ${ms(p.decayMs)}`],
    confidence: 0.4,
  }),

  limiter: (p) => {
    const ceiling = -1;
    if (p.truePeakDbtp < ceiling - 3) {
      return { refuse: `트루피크 ${db(p.truePeakDbtp)} — 아직 리미터가 할 일이 없습니다` };
    }
    return {
      params: {
        ceilingDb: ceiling,
        lookaheadMs: percussive(p) > 0.5 ? 3 : 1.5,
        releaseMs: clamp(round(Math.max(40, p.decayMs * 0.4), 5), 10, 500),
      },
      headline: `−1 dBTP 실링 · ${ms(clamp(round(Math.max(40, p.decayMs * 0.4), 5), 10, 500))} 릴리즈`,
      evidence: [`트루피크 ${db(p.truePeakDbtp)}`, `감쇠 ${ms(p.decayMs)}`],
      confidence: 0.8,
    };
  },

  transient: (p) => {
    // Percussive sources with a short decay want sustain, not attack; a soft
    // source with a slow rise is the one that wants its attack back.
    const wantAttack = clamp(round((25 - p.attackMs) / 40, 0.05), -1, 1);
    const wantSustain = clamp(round(isDrum(p) && p.decayMs < 180 ? 0.25 : 0, 0.05), -1, 1);
    if (Math.abs(wantAttack) < 0.1 && Math.abs(wantSustain) < 0.1) {
      return { refuse: `어택 ${ms(p.attackMs)} — 손댈 필요가 없습니다` };
    }
    return {
      params: { attack: wantAttack, sustain: wantSustain, mix: 1 },
      headline: `어택 ${wantAttack > 0 ? '+' : ''}${(wantAttack * 100).toFixed(0)} %`,
      evidence: [`어택 ${ms(p.attackMs)}`, `감쇠 ${ms(p.decayMs)}`,
        `트랜지언트 ${p.transientRate.toFixed(1)}/초`],
      confidence: 0.6,
    };
  },

  deesser: (p) => {
    if (p.sibilanceDb < 2) {
      return { refuse: `치찰음 ${db(p.sibilanceDb)} — 뺄 게 없습니다` };
    }
    return {
      params: {
        freqHz: clamp(round(p.sibilanceHz, 50), 2000, 12000),
        thresholdDb: clamp(round(p.rmsDb + 6 - p.sibilanceDb, 1), -48, 0),
        amount: clamp(round(Math.min(0.7, p.sibilanceDb / 12), 0.05), 0, 1),
      },
      headline: `${hz(p.sibilanceHz)} — 이 소스의 실제 치찰음 위치`,
      evidence: [`치찰음 ${hz(p.sibilanceHz)} ${db(p.sibilanceDb)}`, `RMS ${db(p.rmsDb)}`],
      confidence: isVoice(p) ? 0.8 : 0.55,
    };
  },

  gate: (p) => {
    const span = p.rmsDb - p.noiseFloorDb;
    if (span < 12) {
      return { refuse: `노이즈 플로어가 ${span.toFixed(0)} dB 아래뿐 — 게이트가 소리를 자릅니다` };
    }
    return {
      params: {
        thresholdDb: clamp(round(p.noiseFloorDb + 6, 1), -80, 0),
        rangeDb: clamp(round(Math.min(40, span * 0.7), 1), 0, 60),
        attackMs: clamp(round(Math.max(1, p.attackMs * 0.3), 0.5), 1, 100),
        releaseMs: clamp(round(Math.max(60, p.decayMs), 10), 20, 2000),
      },
      headline: `${db(p.noiseFloorDb + 6)} 스레숄드 — 측정된 노이즈 플로어 6 dB 위`,
      evidence: [`노이즈 플로어 ${db(p.noiseFloorDb)}`, `RMS ${db(p.rmsDb)}`,
        `감쇠 ${ms(p.decayMs)}`],
      confidence: 0.7,
    };
  },

  mbcomp: (p) => ({
    params: {
      lowXHz: clamp(round(isLowEnd(p) ? 120 : 180, 10), 60, 500),
      highXHz: clamp(round(Math.max(2200, Math.min(5000, p.sibilanceHz * 0.7)), 100), 1500, 8000),
      lowThrDb: clamp(round(p.rmsDb + (p.mudDb > 3 ? 0 : 4), 1), -48, 0),
      lowRatio: clamp(round(p.mudDb > 3 ? 3.5 : 2, 0.5), 1, 12),
      midThrDb: clamp(round(p.rmsDb + 3, 1), -48, 0),
      midRatio: clamp(round(1.5 + p.dynamicRangeDb / 10, 0.5), 1, 12),
      hiThrDb: clamp(round(p.rmsDb + (p.sibilanceDb > 3 ? 0 : 5), 1), -48, 0),
      hiRatio: clamp(round(p.sibilanceDb > 3 ? 3 : 1.8, 0.5), 1, 12),
      makeupDb: 0,
    },
    headline: `저 ${p.mudDb > 3 ? '강하게' : '가볍게'} · 고 ${p.sibilanceDb > 3 ? '강하게' : '가볍게'}`,
    evidence: [`머드 ${db(p.mudDb)}`, `치찰음 ${db(p.sibilanceDb)}`,
      `다이내믹 레인지 ${p.dynamicRangeDb.toFixed(1)} dB`],
    confidence: 0.55,
  }),

  clipper: (p) => {
    const headroom = -1 - p.peakDb;
    if (headroom > 3) {
      return { refuse: `피크 ${db(p.peakDb)} — 아직 깎을 게 없습니다` };
    }
    return {
      params: {
        driveDb: clamp(round(Math.min(6, Math.max(0, -headroom)), 0.5), 0, 24),
        ceilingDb: -1,
        hardness: percussive(p) > 0.6 ? 0.35 : 0.6,
      },
      headline: `−1 dB 실링 · ${percussive(p) > 0.6 ? '부드럽게' : '단단하게'}`,
      evidence: [`피크 ${db(p.peakDb)}`, `크레스트 ${p.crestDb.toFixed(1)} dB`],
      confidence: 0.6,
    };
  },

  // ── Saturation ──────────────────────────────────────────────────────────

  saturation: (p) => {
    const drive = clamp(round(percussive(p) > 0.6 ? 3 : 6, 0.5), 0, 24);
    return {
      params: { driveDb: drive, mix: clamp(round(0.25 + (1 - percussive(p)) * 0.2, 0.05), 0, 1), bias: 0 },
      headline: `${db(drive)} 드라이브 · 병렬 — 크레스트 ${p.crestDb.toFixed(0)} dB 소스에 맞춘 양`,
      evidence: [`크레스트 ${p.crestDb.toFixed(1)} dB`, `RMS ${db(p.rmsDb)}`],
      confidence: 0.45,
    };
  },

  tube: (p) => ({
    params: {
      drive: clamp(round(percussive(p) > 0.6 ? 0.2 : 0.35, 0.05), 0, 1),
      bias: 0.15,
      toneHz: clamp(round(Math.max(4000, p.highRolloffHz * 0.8), 500), 1000, 16000),
      mix: 100,
      outDb: clamp(round(-percussive(p) * 2, 0.5), -24, 12),
    },
    headline: `${hz(Math.max(4000, p.highRolloffHz * 0.8))} 위로 짝수 배음`,
    evidence: [`크레스트 ${p.crestDb.toFixed(1)} dB`, `고역 끝 ${hz(p.highRolloffHz)}`],
    confidence: 0.45,
  }),

  bitcrush: () => ({ refuse: '비트 크러셔는 측정이 아니라 취향입니다 — 원하는 만큼 부수세요' }),

  // ── Modulation ──────────────────────────────────────────────────────────
  //
  // Rates are locked to the session tempo, which is the one thing about
  // modulation that IS a measurement.  Depth is taste, so confidence is low
  // and the headline says so.

  chorus: (p) => ({
    params: {
      rateHz: clamp(round(1000 / beatMs(p, 4), 0.01), 0.05, 8),
      depthMs: 4, delayMs: 18, mix: isVoice(p) ? 22 : 35,
    },
    headline: `${p.tempoBpm.toFixed(0)} BPM 기준 1마디 주기 — 깊이는 취향입니다`,
    evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
    confidence: 0.35,
  }),

  amp: (p) => ({
    params: {
      // How many stages, not how hard one is driven — that is the decision an
      // amplifier actually offers, and it is the one thing here a measurement
      // can help with: a source that is already dense does not want three
      // valves in front of it.
      gain: isVoice(p) ? 28 : 50,
      stages: isVoice(p) ? 1 : 2,
      bass: isVoice(p) ? -3 : 0,
      mid: 0,
      treble: 0,
      stack: 0,
      presence: 3,
      master: 40,
      sag: 35,
      // A guitar cabinet's 80 Hz high-pass takes the fundamental off anything
      // that lives down there, so the recommendation is to turn it off rather
      // than to hide the problem behind a Bass knob.
      cab: isVoice(p) ? 1 : 1,
      mic: isVoice(p) ? 70 : 45,
      level: isVoice(p) ? -3 : 0,
    },
    headline: isVoice(p)
      ? '목소리에는 한 단, 마이크는 오프 액시스 — 캐비닛의 고역 차단이 목적입니다'
      : '두 단 크런치에 2×12 — 기타 앰프의 가장 평범한 자리',
    evidence: [
      isVoice(p) ? '보컬로 판정' : '보컬이 아님',
      `${isVoice(p) ? 1 : 2} 단`,
    ],
    // Low on purpose: how much gain a part wants is the performance's
    // question, not the signal's.
    confidence: 0.35,
  }),

  tape: (p) => {
    // Tape speed is the one setting here a measurement can genuinely decide,
    // and it decides it for a reason that is not about tone in general: the
    // head bump is a PEAK at a known frequency, and whether that is glue or
    // mud depends entirely on whether the source already lives there.
    //
    //   · 7.5 ips puts it at 35 Hz — under almost everything, so it adds
    //     weight without touching a fundamental
    //   · 15 ips puts it at 60 Hz — on top of a bass guitar's low E and a
    //     kick's body, which is why that speed is called fat and why it is
    //     the wrong one for a bass
    //   · 30 ips puts it at 100 Hz — above the sub, which keeps the bottom
    //     clean and is why it is the mastering speed
    //
    // So the rule is to keep the bump off the source's own low end, and the
    // measurement is where that low end starts.
    const lowHz = p.lowRolloffHz;
    const speed = lowHz > 140 ? 1 : (lowHz > 70 ? 2 : 0);
    const bumpHz = [35, 60, 100][speed] ?? 60;

    // How hard to hit it follows the crest.  A percussive source only reaches
    // the curve on transients, so it can be driven harder before anything
    // sustained is affected; a source already squashed sits in the bend all
    // the time and 10 dB in would just be distortion.
    const drive = Math.round(clamp(2 + percussive(p) * 9, 0, 11));

    // Bias is a straight trade — brighter and dirtier one way, cleaner and
    // duller the other — so it follows what the source can spare.  Something
    // already dark has no top to give away.
    const bright = clamp((p.centroidHz - 700) / 2600, 0, 1);
    const bias = Math.round((0.38 + bright * 0.24) * 100) / 100;

    // Wow and flutter are pitch modulation, and a sustained pitched source
    // reports it immediately while a percussive one hides it.  Low on
    // anything that holds a note.
    const steady = 1 - percussive(p);
    const wow = Math.round(clamp(0.35 - steady * 0.3, 0.03, 0.35) * 100) / 100;

    return {
      params: {
        speed, drive, bias,
        bump: isLowEnd(p) ? 1.5 : 3,
        wow,
        flutter: Math.round(clamp(wow * 0.9, 0.05, 0.35) * 100) / 100,
        // Zero, always.  Hiss is a decision to add noise to a recording that
        // does not have any, and no measurement of the source can make that
        // decision for someone — it is a period reference, not a repair.
        hiss: 0,
        crosstalk: 0.2,
        mix: 1,
        out: 0,
      },
      headline: `${[7.5, 15, 30][speed] ?? 15} ips — 헤드 범프 ${bumpHz} Hz 를 `
        + `이 소스의 저역(${Math.round(lowHz)} Hz)에서 비켜 세웁니다`,
      evidence: [
        `저역 시작 ${Math.round(lowHz)} Hz`,
        `크레스트 ${p.crestDb.toFixed(1)} dB`,
        `중심 ${Math.round(p.centroidHz)} Hz`,
      ],
      // Where the bump goes is a measurement; how much tape somebody wants is
      // not, and that is most of this device.
      confidence: 0.4,
    };
  },

  rotary: (p) => ({
    params: {
      // The two speeds a rotary speaker has are not arbitrary and are not
      // tempo: a Leslie's chorale sits under one turn a second and its
      // tremolo around six or seven, and everything between is the ramp
      // rather than a setting anybody stops at.  So this picks an END and
      // says which, instead of dividing the bar into a rate the way the
      // chorus and the flanger do.
      rateHz: isVoice(p) ? 0.7 : 6.4,
      accelSec: 1.6,
      xoverHz: isVoice(p) ? 900 : 800,
      doppler: 100,
      // A voice through a rotary is an effect rather than an instrument, so
      // it wants less of the throb and less of the wet.
      throb: isVoice(p) ? 35 : 60,
      micAngle: 90,
      balance: 0,
      drive: isVoice(p) ? 8 : 25,
      mix: isVoice(p) ? 45 : 100,
    },
    headline: isVoice(p)
      ? '보컬에는 느린 코랄로, 절반만 섞어서 — 목소리가 회전하면 가사가 지워집니다'
      : '빠른 트레몰로 — 오르간과 기타가 이 스피커에 들어가던 속도입니다',
    evidence: [
      isVoice(p) ? '보컬로 판정' : '보컬이 아님',
      `크로스오버 ${isVoice(p) ? 900 : 800} Hz`,
    ],
    // Low, and honestly so: which of the two speeds a part wants is a
    // musical decision and nothing in a measurement decides it.
    confidence: 0.3,
  }),

  flanger: (p) => ({
    params: {
      rateHz: clamp(round(1000 / beatMs(p, 8), 0.01), 0.05, 5),
      depthMs: 2, delayMs: 3, feedback: 0.45, mix: 40,
    },
    headline: `2마디 주기 — 깊이와 피드백은 취향입니다`,
    evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
    confidence: 0.3,
  }),

  phaser: (p) => ({
    params: {
      rateHz: clamp(round(1000 / beatMs(p, 4), 0.01), 0.05, 8),
      depth: 0.7,
      centreHz: clamp(round(p.centroidHz, 10), 200, 4000),
      feedback: 0.4, mix: 45,
    },
    headline: `중심 ${hz(clamp(p.centroidHz, 200, 4000))} — 이 소스의 무게중심에`,
    evidence: [`무게중심 ${hz(p.centroidHz)}`, `템포 ${p.tempoBpm.toFixed(0)} BPM`],
    confidence: 0.4,
  }),

  tremolo: (p) => ({
    params: { rateHz: clamp(round(1000 / beatMs(p, 0.5), 0.1), 0.1, 20), depth: 0.45, shape: 0 },
    headline: '8분음표 주기 — 템포에 맞춰 떨립니다',
    evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
    confidence: 0.4,
  }),

  autopan: (p) => {
    if (p.channels < 2) return { refuse: '모노 소스입니다 — 팬할 스테레오가 없습니다' };
    return {
      params: { rateHz: clamp(round(1000 / beatMs(p, 8), 0.01), 0.05, 10), depth: 0.6 },
      headline: '2마디 주기로 좌우 — 깊이는 취향입니다',
      evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
      confidence: 0.35,
    };
  },

  // ── Delay ───────────────────────────────────────────────────────────────

  delay: (p) => {
    const division = isVoice(p) ? 0.5 : 0.75;
    const time = clamp(round(beatMs(p, division), 1), 1, 2000);
    return {
      params: { timeMs: time, feedback: isVoice(p) ? 0.22 : 0.35, mix: isVoice(p) ? 0.18 : 0.25 },
      headline: `${ms(time)} — ${p.tempoBpm.toFixed(0)} BPM 의 ${division === 0.5 ? '8분' : '점8분'}음표`,
      evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`, `역할 ${p.role.role}`],
      confidence: 0.6,
    };
  },

  pingpong: (p) => {
    const time = clamp(round(beatMs(p, 0.75), 1), 20, 1500);
    return {
      params: {
        timeMs: time, feedback: 0.35,
        toneHz: clamp(round(Math.min(9000, p.highRolloffHz), 100), 800, 16000),
        mix: 24,
      },
      headline: `${ms(time)} 점8분음표 · ${hz(Math.min(9000, p.highRolloffHz))} 위는 반복에서 제거`,
      evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`, `고역 끝 ${hz(p.highRolloffHz)}`],
      confidence: 0.6,
    };
  },

  tapedelay: (p) => {
    const time = clamp(round(beatMs(p, 1), 1), 40, 1500);
    return {
      params: {
        timeMs: time, feedback: 0.4,
        toneHz: clamp(round(Math.min(5000, p.highRolloffHz * 0.6), 100), 600, 12000),
        wowMs: 0.6, drive: 0.25, mix: 22,
      },
      headline: `${ms(time)} 4분음표 — 반복마다 어두워집니다`,
      evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
      confidence: 0.55,
    };
  },

  // ── Reverb ──────────────────────────────────────────────────────────────
  //
  // Pre-delay is one eighth note, so the reverb arrives after the word rather
  // than on it.  Decay comes from the tempo too: a tail longer than a bar
  // turns a busy track to mush, and the tempo is what says how long a bar is.

  reverb: (p) => {
    const decay = clamp(round(Math.min(3.2, beatMs(p, 4) / 1000 * 0.8), 0.1), 0.2, 8);
    return {
      params: { decaySec: decay, preDelayMs: clamp(round(beatMs(p, 0.25), 1), 0, 120), mix: 1 },
      headline: `${decay.toFixed(1)}초 — 한 마디보다 짧게`,
      evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`],
      confidence: 0.5,
    };
  },

  spacereverb: (p) => {
    // The space is chosen by what the source is: a voice wants a plate or a
    // hall, a drum wants a room, a pad wants the biggest thing available.
    const space = isVoice(p) ? 21          // plate-vocal
      : p.role.role === 'snare' ? 17       // room-drum
        : isDrum(p) ? 18                   // room-wood
          : p.role.role === 'pad' || p.role.role === 'synth' ? 13   // hall-cathedral
            : 8;                           // hall-recital
    const decay = clamp(round(Math.min(160, (beatMs(p, 4) / 1000) * 70), 5), 25, 300);
    return {
      params: {
        space,
        sizePct: 100,
        decayPct: decay,
        preDelayMs: clamp(round(beatMs(p, 0.25), 1), 0, 200),
        dampingPct: 100,
        erDb: isVoice(p) ? -4 : 0,
        tailDb: 0,
        lowCutHz: clamp(round(Math.max(160, highPassHz(p) * 2), 10), 20, 800),
        highCutHz: clamp(round(Math.min(13000, Math.max(6000, p.highRolloffHz)), 100), 1000, 20000),
        widthPct: 110,
        holdMs: 260,
        mixPct: isVoice(p) ? 22 : 26,
      },
      headline: `${isVoice(p) ? '보컬 플레이트' : isDrum(p) ? '드럼 룸' : '홀'} · 프리딜레이 ${ms(beatMs(p, 0.25))}`,
      evidence: [`역할 ${p.role.role}`, `템포 ${p.tempoBpm.toFixed(0)} BPM`,
        `저역 시작 ${hz(p.lowRolloffHz)}`],
      confidence: p.role.confidence > 0.4 ? 0.65 : 0.45,
    };
  },

  plate: (p) => ({
    params: {
      decaySec: clamp(round(Math.min(3, (beatMs(p, 4) / 1000) * 0.7), 0.1), 0.2, 12),
      preDelayMs: clamp(round(beatMs(p, 0.25), 1), 0, 200),
      dampHz: clamp(round(Math.min(9000, Math.max(4000, p.highRolloffHz * 0.7)), 100), 500, 20000),
      diffusion: 0.72,
      lowCutHz: clamp(round(Math.max(220, highPassHz(p) * 2.5), 10), 20, 800),
      highCutHz: 12000,
      widthPct: 110,
      mixPct: isVoice(p) ? 22 : 28,
    },
    headline: `${Math.min(3, (beatMs(p, 4) / 1000) * 0.7).toFixed(1)}초 · 저역 ${hz(Math.max(220, highPassHz(p) * 2.5))} 아래 제거`,
    evidence: [`템포 ${p.tempoBpm.toFixed(0)} BPM`, `저역 시작 ${hz(p.lowRolloffHz)}`],
    confidence: 0.55,
  }),

  spring: (p) => ({
    params: {
      decaySec: clamp(round(Math.min(2.6, (beatMs(p, 4) / 1000) * 0.6), 0.1), 0.2, 8),
      toneHz: clamp(round(Math.max(900, Math.min(2000, p.centroidHz)), 50), 400, 4000),
      dampHz: 4200, boing: 0.6, mixPct: 26,
    },
    headline: `${hz(Math.max(900, Math.min(2000, p.centroidHz)))} 중심 — 이 소스의 무게중심 근처`,
    evidence: [`무게중심 ${hz(p.centroidHz)}`, `템포 ${p.tempoBpm.toFixed(0)} BPM`],
    confidence: 0.45,
  }),

  shimmer: (p) => {
    if (percussive(p) > 0.65) {
      return { refuse: `크레스트 ${p.crestDb.toFixed(0)} dB — 타악기에 셔머는 뭉갭니다` };
    }
    return {
      params: {
        space: 13, decayPct: 100, shimmer: 0.4,
        loopMs: clamp(round(beatMs(p, 0.5), 1), 20, 800),
        preDelayMs: clamp(round(beatMs(p, 0.25), 1), 0, 200),
        lowCutHz: 240, highCutHz: 11000, widthPct: 125, mixPct: 32,
      },
      headline: `루프 ${ms(beatMs(p, 0.5))} — 8분음표마다 한 옥타브씩`,
      evidence: [`크레스트 ${p.crestDb.toFixed(1)} dB`, `템포 ${p.tempoBpm.toFixed(0)} BPM`],
      confidence: 0.45,
    };
  },

  // ── Imaging ─────────────────────────────────────────────────────────────

  widener: (p) => {
    if (p.channels < 2) return { refuse: '모노 소스입니다 — 넓힐 스테레오가 없습니다' };
    const width = clamp(round(p.widthPercent < 50 ? 1.3 : p.widthPercent > 130 ? 0.85 : 1, 0.05), 0, 2);
    if (Math.abs(width - 1) < 0.05) return { refuse: `폭 ${Math.round(p.widthPercent)} % — 적당합니다` };
    return {
      params: { width, lowMonoHz: clamp(round(p.bassCorrelation < 0.7 ? 140 : 90, 10), 20, 400) },
      headline: `폭 ${(width * 100).toFixed(0)} % · 저역은 ${hz(p.bassCorrelation < 0.7 ? 140 : 90)} 아래 모노`,
      evidence: [`폭 ${Math.round(p.widthPercent)} %`, `저역 상관도 ${p.bassCorrelation.toFixed(2)}`],
      confidence: 0.6,
    };
  },

  monomaker: (p) => {
    if (p.channels < 2) return { refuse: '모노 소스입니다' };
    if (p.bassCorrelation > 0.9) {
      return { refuse: `저역 상관도 ${p.bassCorrelation.toFixed(2)} — 이미 모노입니다` };
    }
    // The worse the bass correlates, the higher the crossover has to go.
    const freq = clamp(round(90 + (1 - p.bassCorrelation) * 160, 10), 20, 400);
    return {
      params: { freqHz: freq, widthPct: 100 },
      headline: `${hz(freq)} 아래 모노 — 저역 상관도 ${p.bassCorrelation.toFixed(2)}`,
      evidence: [`저역 상관도 ${p.bassCorrelation.toFixed(2)}`, `전체 상관도 ${p.correlation.toFixed(2)}`],
      confidence: 0.75,
    };
  },

  haas: (p) => {
    if (p.channels > 1 && p.widthPercent > 60) {
      return { refuse: `이미 폭 ${Math.round(p.widthPercent)} % — 하스는 모노 소스용입니다` };
    }
    return {
      params: { delayMs: 14, amount: 0.45 },
      headline: '14 ms — 모노 소스를 넓히되 콤 필터는 피하는 지연',
      evidence: [`폭 ${Math.round(p.widthPercent)} %`, `채널 ${p.channels}`],
      confidence: 0.45,
    };
  },

  // ── Restore ─────────────────────────────────────────────────────────────

  denoise: (p) => {
    const span = p.rmsDb - p.noiseFloorDb;
    if (span > 45) {
      return { refuse: `노이즈 플로어가 ${span.toFixed(0)} dB 아래 — 지울 노이즈가 없습니다` };
    }
    return {
      params: {
        thresholdDb: clamp(round(p.noiseFloorDb + 4, 1), -80, -10),
        amount: clamp(round(Math.min(0.6, (45 - span) / 45), 0.05), 0, 1),
        releaseMs: clamp(round(Math.max(80, p.decayMs * 0.5), 10), 10, 500),
      },
      headline: `${db(p.noiseFloorDb + 4)} 아래를 줄입니다 — 측정된 플로어 4 dB 위`,
      evidence: [`노이즈 플로어 ${db(p.noiseFloorDb)}`, `신호 대 플로어 ${span.toFixed(0)} dB`],
      confidence: 0.7,
    };
  },

  hum: (p) => {
    if (p.humHz === null) {
      return { refuse: '50 / 60 Hz 험이 검출되지 않았습니다' };
    }
    return {
      params: { baseHz: p.humHz, harmonics: 5, q: 30 },
      headline: `${p.humHz} Hz 험 + 배음 5개 — 스펙트럼에서 검출됨`,
      evidence: [`험 기본파 ${p.humHz} Hz`, '배음 2개 이상 확인'],
      confidence: 0.85,
    };
  },

  // ── Pitch ───────────────────────────────────────────────────────────────

  pitchcorrect: (p) => {
    if (!isVoice(p)) {
      return { refuse: `${p.role.role} 트랙입니다 — 피치 보정은 보컬용입니다` };
    }
    return {
      params: { amount: 0.7, formant: 0 },
      headline: '보정 70 % — 자연스러운 범위. 키/스케일은 코드 트랙에서',
      evidence: [`역할 ${p.role.role} (확신 ${(p.role.confidence * 100).toFixed(0)} %)`],
      confidence: 0.4,
    };
  },

  // ── Master ──────────────────────────────────────────────────────────────

  loudness: () => ({
    params: { targetLufs: -14 },
    headline: '−14 LUFS — 스트리밍 제출 기준',
    evidence: ['배급 기준값 (측정이 아니라 목표)'],
    confidence: 0.9,
  }),

  dither: () => ({
    refuse: '디더는 오디오가 아니라 배급 포맷이 정합니다 — 16비트로 낼 때만 마지막 슬롯에',
  }),
};

// ── The entry point ─────────────────────────────────────────────────────────

/** Devices this can advise, for the UI to grey out the rest. */
export function canAdvise(pluginId: string): boolean {
  return ADVISORS[pluginId] !== undefined;
}

export const LOW_CONFIDENCE = 0.45;

/**
 * What this device should be set to for this audio.
 *
 * The returned `params` is COMPLETE — the device's defaults with the advice on
 * top — so applying it is one assignment and never leaves half the device on
 * the last thing somebody did.
 */
export function adviseFor(
  pluginId: string, profile: SourceProfile,
  current: Record<string, number> = {},
): AdviceResult {
  const descriptor = findPlugin(pluginId);
  if (!descriptor) return { ok: false, reason: '알 수 없는 장치입니다' };

  const advisor = ADVISORS[pluginId];
  if (!advisor) {
    return { ok: false, reason: `${descriptor.name} 은(는) 아직 추천을 만들지 않습니다` };
  }
  if (profile.silent) {
    return { ok: false, reason: '이 구간에는 소리가 없습니다 — 측정할 것이 없습니다' };
  }

  const draft = advisor(profile);
  if ('refuse' in draft) return { ok: false, reason: draft.refuse };

  // Defaults underneath, advice on top, everything clamped to the device's own
  // declared range.  An advisor cannot put a device somewhere it cannot go.
  //
  // With one exception, and it is the same rule from the other side: a value
  // the device MEASURED is not a value an advisor may invent, so a `curve`
  // parameter keeps whatever is already there.  Falling back to the default
  // would zero the match EQ's reference curve every time somebody asked for
  // advice about its Amount — advice that silently deletes a measurement.
  const params: Record<string, number> = {};
  for (const def of descriptor.params) {
    const suggested = draft.params[def.id];
    if (typeof suggested === 'number' && Number.isFinite(suggested)) {
      params[def.id] = clamp(suggested, def.min, def.max);
      continue;
    }
    const held = def.curve ? current[def.id] : undefined;
    params[def.id] = typeof held === 'number' && Number.isFinite(held)
      ? clamp(held, def.min, def.max)
      : def.default;
  }

  return {
    ok: true,
    advice: {
      pluginId,
      params,
      headline: draft.headline,
      evidence: draft.evidence,
      confidence: clamp(draft.confidence, 0, 1),
    },
  };
}
