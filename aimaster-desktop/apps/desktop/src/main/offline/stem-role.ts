// stem-role — decide what instrument a stem is, so its chain can be tailored.
//
// # Why two sources of evidence
//
// A stem's SPECTRUM tells you a lot and lies about the rest.  A kick and a
// sub bass occupy the same octave; the only thing separating them is that
// one is a transient and the other is sustained, which is the crest factor.
// A lead vocal, a rhythm guitar and a Rhodes all sit between 200 Hz and
// 4 kHz with a similar envelope — no honest measurement of a single stem
// separates those three.  Claiming otherwise would produce a classifier
// that is confidently wrong on a third of a real session.
//
// A stem's NAME, on the other hand, is unusually reliable.  Stems are an
// export format: they come out of a DAW with the track name attached, and
// engineers name tracks after the instrument because that is the whole
// point of the label.  "Kick In.wav", "Bass DI.wav", "Lead Vox v3.wav".
//
// So: the name decides the fine role, the measurement decides the coarse
// one, and the two are cross-checked.  When they disagree the measurement
// wins the ARGUMENT (it reports a warning) but the name keeps the role —
// a mislabelled file is rarer than a stem that simply does not look like
// its instrument (a heavily filtered vocal, a kick with the sub removed).
// When there is no usable name the role stays as coarse as the spectrum
// can actually justify, and `confidence` says so.
//
// # What this deliberately does NOT do
//
// It does not try to split vocal / guitar / keys from spectrum alone, and
// it does not guess at lead-vs-backing without the name.  Those collapse
// into `mid` and `other`, which the caller treats as "ask the user".

import { bandHz, type SongProfile } from './song-profile.js';

/** Instrument roles a stem chain can be built for. */
export type StemRole =
  | 'kick'
  | 'snare'
  | 'drums'      // kit, percussion, hats, cymbals — non-pitched percussive
  | 'bass'
  | 'vocal'      // lead vocal
  | 'vocal-back' // backing vocals, harmonies, ad-libs
  | 'guitar'
  | 'keys'       // piano, synth, pad, organ
  | 'fx'         // risers, impacts, atmospheres, foley
  | 'mid'        // a harmonic mid instrument the spectrum cannot name
  | 'other';     // nothing usable from either source

/**
 * Every role, in one list.
 *
 * The renderer declares the same union in `presets/stem-defaults.ts` — the
 * two sides of the IPC boundary cannot import each other. `stem-defaults-
 * selftest` compares these two lists so a role added on one side and not
 * the other fails a test instead of silently having no chain.
 */
export const STEM_ROLES: readonly StemRole[] = [
  'kick', 'snare', 'drums', 'bass',
  'vocal', 'vocal-back', 'guitar', 'keys',
  'fx', 'mid', 'other',
] as const;

/** Where the decision came from. */
export type RoleBasis = 'name' | 'spectrum' | 'name+spectrum';

export interface StemFeatures {
  /** Energy-weighted spectral centroid, Hz. */
  centroidHz: number;
  /** Share of total energy below 150 Hz, 0..1. */
  lowFrac: number;
  /** Share of total energy above 5 kHz, 0..1. */
  highFrac: number;
  /** Peak-minus-RMS over the loud half, dB — transient vs sustained. */
  crestDb: number;
  /** Side energy as a percentage of mid. */
  widthPct: number;
  /** Integrated loudness, LUFS — how much content the stem actually has. */
  integratedLufs: number;
}

export interface StemClassification {
  role: StemRole;
  /** 0..1 — how much weight the caller should give this before asking. */
  confidence: number;
  basis: RoleBasis;
  /** Korean, shown in the UI next to the stem. */
  why: string;
  /** Set when the name and the measurement disagree. Korean. */
  warning?: string;
  features: StemFeatures;
}

/**
 * Below this, a stem has no content worth classifying.
 *
 * This is not a taste threshold, it is a correctness one. The profiler's
 * curve for digital silence is not flat — it is a floor around -250 dBFS
 * that tilts down with frequency, so the energy-weighted centroid lands in
 * the bottom band and a silent stem reads as "100% below 150 Hz, no
 * transients" — which is exactly the fingerprint of a sustained sub bass.
 * Without this gate an empty or muted stem is confidently filed as a bass
 * and gets a bass chain. -60 LUFS leaves ~10 dB of margin over what the
 * profiler reports for true silence (-70) while sitting far below any
 * stem a mix would actually contain.
 */
const SILENT_LUFS = -60;

// ── Feature extraction ──────────────────────────────────────────────────────

/**
 * Reduce a profile to the handful of numbers the rules below use.
 *
 * The curve is per-bin dBFS, so it is converted back to linear POWER before
 * anything is summed — averaging decibels weights a −60 dB bin as heavily
 * as a −6 dB one and would put the centroid of a kick up in the midrange.
 */
export function stemFeatures(profile: SongProfile): StemFeatures {
  const curve = profile.curveDb;
  let total = 0, lowE = 0, highE = 0, weighted = 0;

  for (let i = 0; i < curve.length; i++) {
    const db = curve[i]!;
    // A silent band is -Infinity; Math.pow gives 0, which is what we want.
    const e = Number.isFinite(db) ? Math.pow(10, db / 10) : 0;
    const hz = bandHz(i);
    total += e;
    weighted += e * hz;
    if (hz < 150) lowE += e;
    if (hz > 5_000) highE += e;
  }

  // An empty stem has no centroid. Report 0 rather than NaN so every
  // downstream comparison is false instead of throwing.
  const centroidHz = total > 0 ? weighted / total : 0;

  return {
    centroidHz,
    lowFrac:  total > 0 ? lowE / total : 0,
    highFrac: total > 0 ? highE / total : 0,
    crestDb:  Number.isFinite(profile.crestDb) ? profile.crestDb : 0,
    widthPct: Number.isFinite(profile.widthPct) ? profile.widthPct : 0,
    // -Infinity for true silence; normalise so comparisons behave.
    integratedLufs: Number.isFinite(profile.integratedLufs) ? profile.integratedLufs : -Infinity,
  };
}

// ── Name matching ───────────────────────────────────────────────────────────

/**
 * Patterns per role, in PRIORITY ORDER — the first role that matches wins.
 *
 * The order carries real cases:
 *   • `kick` before `bass`, or "Bass Drum" is filed as a bass.
 *   • `drums` before `bass`, or "Drum Bus" would need its own rule.
 *   • `vocal-back` before `vocal`, since every backing name contains the
 *     word "vocal" or "vox" too.
 *   • `bass` before `guitar`, because a stem called "Bass Guitar" is the
 *     bass part, not a guitar part.
 */
const NAME_RULES: ReadonlyArray<{ role: StemRole; patterns: RegExp }> = [
  { role: 'kick',       patterns: /\b(kick|kik|bd)\b|bass\s*drum|킥|베이스\s*드럼/i },
  { role: 'snare',      patterns: /\b(snare|snr|sd|rim)\b|스네어|림샷/i },
  { role: 'drums',      patterns: /\b(drum|drums|dr|perc|percussion|hat|hats|hh|hi-?hat|cymbal|ride|crash|tom|toms|clap|shaker|tamb\w*|conga|bongo)\b|드럼|퍼커션|하이햇|심벌|탐|클랩|셰이커/i },
  { role: 'bass',       patterns: /\b(bass|bs|sub|subbass|808)\b|베이스|저음/i },
  { role: 'vocal-back', patterns: /\b(bgv|bv|backing|back\s*vox|back\s*vocal|harmony|harmonies|chorus\s*vox|adlib|ad-?libs?|double|stack)\b|백\s*보컬|코러스|화음|애드립/i },
  { role: 'vocal',      patterns: /\b(vocal|vocals|vox|vo|lead\s*vox|lv|acapella|acappella)\b|보컬|목소리|가창/i },
  { role: 'guitar',     patterns: /\b(guitar|guitars|gtr|gt|egt|agt|electric|acoustic|riff)\b|기타|일렉|어쿠스틱/i },
  { role: 'keys',       patterns: /\b(piano|pno|key|keys|synth|syn|pad|pads|organ|rhodes|wurli|epiano|e-?piano|string|strings|brass|lead|arp|pluck|bell)\b|피아노|신스|패드|건반|오르간|스트링|브라스/i },
  { role: 'fx',         patterns: /\b(fx|sfx|riser|rise|impact|downlifter|uplifter|sweep|whoosh|atmos|ambience|ambient|noise|foley|texture|transition)\b|효과음|이펙트|앰비언스/i },
];

/**
 * Role implied by a stem's file name, or null when nothing matches.
 *
 * Digits and separators are neutralised first so `Kick_01`, `03-KICK`, and
 * `Kick.L` all reach the same pattern. The extension is stripped because
 * `.aif` would otherwise match nothing and `.wav` matches nothing either —
 * but a track called "FX.wav" must not be beaten by its own extension.
 */
export function roleFromName(fileName: string): StemRole | null {
  const base = fileName
    .replace(/\.[a-z0-9]{1,5}$/i, '')       // extension
    .replace(/[_\-.]+/g, ' ')               // separators → spaces
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return null;

  for (const rule of NAME_RULES) {
    if (rule.patterns.test(base)) return rule.role;
  }
  return null;
}

// ── Spectral classification ─────────────────────────────────────────────────

/**
 * The coarse role the measurement alone can defend.
 *
 * Thresholds are stated as what they mean, not as tuning constants:
 *   • "almost all the energy is below 150 Hz" separates low stems.
 *   • crest ≥ 12 dB separates a transient from something sustained; a kick
 *     hits and decays, a sub bass holds.
 *   • "most of the energy above 5 kHz" is a hat / cymbal / air stem.
 * Anything with a midrange centroid returns `mid`, because that is where
 * vocal, guitar and keys are genuinely indistinguishable.
 */
export function roleFromSpectrum(f: StemFeatures): { role: StemRole; confidence: number } {
  // Nothing measurable — an empty, muted or silent stem. Checked FIRST,
  // because the shape rules below would otherwise read the noise floor's
  // tilt as a real spectrum.
  if (f.centroidHz <= 0 || f.integratedLufs < SILENT_LUFS) {
    return { role: 'other', confidence: 0 };
  }

  if (f.lowFrac >= 0.6) {
    return f.crestDb >= 12
      ? { role: 'kick', confidence: 0.7 }
      : { role: 'bass', confidence: 0.7 };
  }

  if (f.highFrac >= 0.45) {
    return f.crestDb >= 12
      ? { role: 'drums', confidence: 0.6 }   // hats / cymbals
      : { role: 'fx',    confidence: 0.4 };  // sustained air / atmos
  }

  // Broadband and very transient across the whole range — a full kit bus.
  if (f.crestDb >= 16 && f.lowFrac >= 0.15 && f.highFrac >= 0.15) {
    return { role: 'drums', confidence: 0.55 };
  }

  if (f.centroidHz >= 200 && f.centroidHz <= 4_000) {
    return { role: 'mid', confidence: 0.35 };
  }

  return { role: 'other', confidence: 0.2 };
}

// ── Cross-check ─────────────────────────────────────────────────────────────

/** Coarse family a role belongs to, for agreement testing. */
function family(role: StemRole): 'low' | 'percussive' | 'mid' | 'high' | 'unknown' {
  switch (role) {
    case 'kick':  case 'bass':                       return 'low';
    case 'snare': case 'drums':                      return 'percussive';
    case 'vocal': case 'vocal-back':
    case 'guitar': case 'keys': case 'mid':          return 'mid';
    case 'fx':                                       return 'high';
    default:                                         return 'unknown';
  }
}

const ROLE_KO: Record<StemRole, string> = {
  kick: '킥', snare: '스네어', drums: '드럼/퍼커션', bass: '베이스',
  vocal: '리드 보컬', 'vocal-back': '백 보컬', guitar: '기타',
  keys: '건반/신스', fx: '효과음', mid: '중역 악기', other: '미분류',
};

/**
 * Decide a stem's role from its file name and its measured profile.
 *
 * `fileName` may be a full path — only the basename is read.
 */
export function classifyStem(fileName: string, profile: SongProfile): StemClassification {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const features = stemFeatures(profile);
  const named = roleFromName(base);
  const measured = roleFromSpectrum(features);

  // No usable name: the spectrum is all there is, and it only gets to be as
  // specific as it can defend.
  if (!named) {
    return {
      role: measured.role,
      confidence: measured.confidence,
      basis: 'spectrum',
      why: `이름에서 악기를 알 수 없어 측정으로 판단했습니다 — 중심 주파수 ${Math.round(features.centroidHz)} Hz, 크레스트 ${features.crestDb.toFixed(1)} dB → ${ROLE_KO[measured.role]}`,
      features,
    };
  }

  // Named but empty. The name still names it, but an empty stem in a
  // session is nearly always an accident (a muted track, a bad export
  // range) and saying nothing about it would let it ship silently.
  if (features.integratedLufs < SILENT_LUFS) {
    return {
      role: named,
      confidence: 0.4,
      basis: 'name',
      why: `파일 이름으로 ${ROLE_KO[named]}로 판단했습니다`,
      warning: `이 스템은 사실상 무음입니다 (${features.integratedLufs > -Infinity ? features.integratedLufs.toFixed(1) : '-∞'} LUFS). 뮤트된 트랙이나 잘못된 구간이 익스포트된 것은 아닌지 확인하세요.`,
      features,
    };
  }

  const agrees = family(named) === family(measured.role);

  // The measurement is too weak to confirm or deny anything.
  if (measured.confidence < 0.3) {
    return {
      role: named,
      confidence: 0.6,
      basis: 'name',
      why: `파일 이름으로 ${ROLE_KO[named]}로 판단했습니다 (측정으로는 확인이 어려운 스템)`,
      features,
    };
  }

  if (agrees) {
    return {
      role: named,
      confidence: 0.95,
      basis: 'name+spectrum',
      why: `이름과 측정이 일치합니다 — ${ROLE_KO[named]}, 중심 주파수 ${Math.round(features.centroidHz)} Hz, 크레스트 ${features.crestDb.toFixed(1)} dB`,
      features,
    };
  }

  // Disagreement. The name still decides the role — a stem that does not
  // look like its instrument is far more common than a mislabelled file —
  // but the caller is told, because this is exactly the case where the
  // automatic chain will be wrong and the user should look.
  return {
    role: named,
    confidence: 0.5,
    basis: 'name',
    why: `파일 이름으로 ${ROLE_KO[named]}로 판단했습니다`,
    warning: `이름은 ${ROLE_KO[named]}인데 측정은 ${ROLE_KO[measured.role]}에 가깝습니다 (중심 주파수 ${Math.round(features.centroidHz)} Hz, 크레스트 ${features.crestDb.toFixed(1)} dB). 자동 설정이 맞지 않으면 악기를 직접 지정하세요.`,
    features,
  };
}

/** Korean label for a role — shared with the renderer. */
export function roleLabelKo(role: StemRole): string {
  return ROLE_KO[role];
}
