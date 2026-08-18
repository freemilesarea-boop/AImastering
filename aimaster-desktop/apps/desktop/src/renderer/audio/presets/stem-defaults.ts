// stem-defaults — a starting chain per instrument.
//
// `recommended-defaults` answers "what would somebody who does this for a
// living put here?" for a FINISHED MIX. A stem is a different question with
// a different answer: a kick wants its 400 Hz box removed and its beater
// click found, a lead vocal wants a high-pass at 90 Hz and a de-esser, and
// neither wants what you would do to a whole record.
//
// # The rule that matters most: a stem is not a master
//
// Three things belong to the master bus only and are never written here:
//
//   • **The limiter and the loudness target.** Pushing an individual stem to
//     a LUFS target destroys the one thing a mix balance is — the relative
//     level between the parts. Twelve stems each limited to -9 LUFS is
//     twelve stems all the same loudness, which is not a mix. Level lives
//     on the mixer fader; loudness lives on the master.
//   • **Dither.** It is applied once, at the final word-length reduction.
//     Dithering every stem and then dithering the sum adds N+1 independent
//     noise floors instead of one.
//   • **The final ceiling.** Stems are summed; whatever headroom an
//     individual stem has says nothing about the sum's peak.
//
// `stem-defaults-selftest` fails if any preset here writes to those.
//
// # Where these numbers come from
//
// Standard engineering practice for each instrument — the moves that are
// taught, documented and unsurprising: high-pass what has no fundamental
// down there, cut the mud region, find the instrument's identifying band,
// compress with an attack that respects the transient. They are a starting
// point that should sound better than flat and never sound broken. They are
// NOT measurements of any specific record, and nothing here is tuned to a
// particular song — that is what the per-stem Studio and Match EQ are for.
//
// # Unknown stems get almost nothing
//
// `mid` and `other` mean the classifier could not identify the instrument.
// Their preset is a subsonic high-pass and nothing else. Acting confidently
// on a stem you cannot name is how an automatic system ruins a mix; doing
// nearly nothing is recoverable, and the user can name it themselves.

import type { ModuleId, ParameterValue } from '../parameters/index.js';
import type { ParametricBandType } from '../modules/parametric-eq-model.js';

/**
 * Instrument roles a stem chain can be built for.
 *
 * Mirrors `StemRole` in `main/offline/stem-role.ts`, which does the actual
 * classifying — the two cross the IPC boundary and cannot import each other
 * (the same split `SongProfile` already lives with). `stem-defaults-selftest`
 * compares the two lists and fails if they drift apart.
 */
export type StemRole =
  | 'kick' | 'snare' | 'drums' | 'bass'
  | 'vocal' | 'vocal-back' | 'guitar' | 'keys'
  | 'fx' | 'mid' | 'other';

export const STEM_ROLES: readonly StemRole[] = [
  'kick', 'snare', 'drums', 'bass',
  'vocal', 'vocal-back', 'guitar', 'keys',
  'fx', 'mid', 'other',
] as const;

/** An EQ band in a preset — no `id`, since one is minted on application. */
export interface StemEqBand {
  type: ParametricBandType;
  frequencyHz: number;
  gainDb: number;
  q: number;
}

export interface StemModuleSetting {
  bypass?: boolean;
  parameters: Record<string, ParameterValue>;
}

export interface StemChainPreset {
  /**
   * Modules this role has an opinion about.
   *
   * Absent means "leave it as it is" — every module starts neutral, so an
   * absent module is a module that does nothing. Listing all 25 per role
   * would bury the four or five that carry the sound.
   */
  modules: Partial<Record<ModuleId, StemModuleSetting>>;
  /** Free parametric EQ bands. Empty = no EQ. */
  eqBands: StemEqBand[];
  /** Korean — what this chain is doing and why, shown when it is applied. */
  why: string;
}

/** Modules a stem chain must never write to. See the header. */
export const MASTER_ONLY_MODULES: readonly ModuleId[] = ['limiter', 'export'] as const;

// A compressor that respects the transient it is given. Attack is the
// parameter that decides whether a drum keeps its hit, so it is the one that
// changes most between these.
function comp(thresholdDb: number, ratio: number, attackMs: number, releaseMs: number): StemModuleSetting {
  return { bypass: false, parameters: { thresholdDb, ratio, attackMs, releaseMs, mixPct: 100 } };
}

export const STEM_CHAIN: Record<StemRole, StemChainPreset> = {
  // ── Low ──────────────────────────────────────────────────────────────────
  kick: {
    eqBands: [
      { type: 'highpass',  frequencyHz: 30,   gainDb: 0,    q: 0.7 },
      { type: 'bell',      frequencyHz: 65,   gainDb: 2,    q: 0.9 },
      { type: 'bell',      frequencyHz: 400,  gainDb: -3,   q: 1.2 },
      { type: 'bell',      frequencyHz: 3500, gainDb: 2,    q: 1.5 },
    ],
    modules: {
      // 15 ms attack lets the beater through before the compressor closes —
      // a fast attack here is what turns a kick into a thud.
      dynamics: comp(-18, 3, 15, 120),
      impact: {
        bypass: false,
        parameters: {
          crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
          band0Pct: 12, band1Pct: 4, band2Pct: 6, band3Pct: 0,
        },
      },
      // A kick belongs in the centre. Anything below 200 Hz that is not
      // mono disappears on a club system and on vinyl.
      imager: { bypass: false, parameters: { widthPct: 100, lowMonoHz: 200, stereoize: false } },
    },
    why: '30 Hz 아래 서브소닉을 자르고, 65 Hz의 무게감을 살리고, 400 Hz의 박스 울림을 뺐습니다. 3.5 kHz는 비터가 때리는 소리라 살짝 올렸습니다. 어택 15 ms는 때리는 순간을 컴프레서가 먹지 않게 하려는 설정입니다.',
  },

  bass: {
    eqBands: [
      { type: 'highpass', frequencyHz: 25,  gainDb: 0,  q: 0.7 },
      { type: 'bell',     frequencyHz: 80,  gainDb: 1.5, q: 0.8 },
      { type: 'bell',     frequencyHz: 250, gainDb: -2,  q: 1.0 },
      // Bass has no fundamental on a phone speaker — this band is what
      // makes it audible there at all.
      { type: 'bell',     frequencyHz: 800, gainDb: 2,   q: 1.2 },
    ],
    modules: {
      // Bass is the part that must not move. Ratio 4 with a 20 ms attack
      // holds it steady without flattening the pick or the pluck.
      dynamics: comp(-20, 4, 20, 150),
      'low-end-focus': { bypass: false, parameters: { mode: 'smooth', frequencyHz: 110, contrastPct: 30, gainDb: 0 } },
      imager: { bypass: false, parameters: { widthPct: 100, lowMonoHz: 200, stereoize: false } },
    },
    why: '25 Hz 아래를 자르고 80 Hz의 기음을 살렸습니다. 250 Hz를 빼서 탁함을 줄이고, 800 Hz를 올려 작은 스피커에서도 베이스 라인이 들리게 했습니다. 비율 4:1은 베이스가 흔들리지 않게 잡아두는 설정입니다.',
  },

  // ── Percussive ───────────────────────────────────────────────────────────
  snare: {
    eqBands: [
      { type: 'highpass', frequencyHz: 80,   gainDb: 0,  q: 0.7 },
      { type: 'bell',     frequencyHz: 200,  gainDb: 2,  q: 1.0 },
      { type: 'bell',     frequencyHz: 600,  gainDb: -2, q: 1.2 },
      { type: 'bell',     frequencyHz: 5000, gainDb: 3,  q: 1.2 },
    ],
    modules: {
      dynamics: comp(-18, 3, 10, 100),
      impact: {
        bypass: false,
        parameters: {
          crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
          band0Pct: 0, band1Pct: 8, band2Pct: 10, band3Pct: 6,
        },
      },
    },
    why: '200 Hz의 몸통을 살리고 600 Hz의 답답함을 뺐습니다. 5 kHz는 스네어가 갈라지는 소리라 올렸습니다.',
  },

  drums: {
    eqBands: [
      { type: 'highpass',  frequencyHz: 40,   gainDb: 0,  q: 0.7 },
      { type: 'bell',      frequencyHz: 400,  gainDb: -2, q: 1.0 },
      { type: 'highshelf', frequencyHz: 8000, gainDb: 2,  q: 0.7 },
    ],
    modules: {
      // A kit bus is many instruments at once — a gentler ratio and a
      // slower attack, or the room and the cymbals get pumped.
      dynamics: comp(-20, 2.5, 20, 120),
      impact: {
        bypass: false,
        parameters: {
          crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
          band0Pct: 6, band1Pct: 6, band2Pct: 8, band3Pct: 4,
        },
      },
      imager: { bypass: false, parameters: { widthPct: 110, lowMonoHz: 120, stereoize: false } },
    },
    why: '400 Hz의 뭉침을 빼고 8 kHz를 올려 심벌과 하이햇을 열었습니다. 킷 전체가 한 버스에 있으므로 비율은 2.5:1로 약하게, 어택은 느리게 잡아 룸이 펌핑되지 않게 했습니다.',
  },

  // ── Voices ───────────────────────────────────────────────────────────────
  vocal: {
    eqBands: [
      // 90 Hz: a voice has nothing below this, but plosives and mic stand
      // rumble do.
      { type: 'highpass',  frequencyHz: 90,    gainDb: 0,  q: 0.7 },
      { type: 'bell',      frequencyHz: 300,   gainDb: -2, q: 1.0 },
      { type: 'bell',      frequencyHz: 3000,  gainDb: 2,  q: 1.0 },
      { type: 'highshelf', frequencyHz: 10000, gainDb: 2,  q: 0.7 },
    ],
    modules: {
      // The one move that defines a vocal chain. Everything else is taste;
      // an un-de-essed lead vocal is a defect.
      deess: {
        bypass: false,
        parameters: {
          frequencyHz: 7000, rangeDb: 4, thresholdDb: -28,
          ratio: 4, attackMs: 1, releaseMs: 60, wideband: false,
        },
      },
      // Faster and firmer than an instrument: a vocal moves 20 dB between
      // a verse and a chorus and has to sit still in the mix.
      dynamics: comp(-22, 3, 8, 80),
      imager: { bypass: false, parameters: { widthPct: 100, lowMonoHz: 300, stereoize: false } },
    },
    why: '90 Hz 아래를 잘라 팝 노이즈와 저역 울림을 없앴습니다. 300 Hz를 빼서 답답함을 줄이고 3 kHz를 올려 가사가 앞으로 나오게 했습니다. 7 kHz 디에서는 ㅅ·ㅊ 소리를 최대 4 dB만 눌러줍니다. 리드 보컬은 가운데 고정입니다.',
  },

  'vocal-back': {
    eqBands: [
      // Higher than the lead: backing vocals do not need the low end, and
      // taking it out is what stops them crowding the lead.
      { type: 'highpass',  frequencyHz: 120,   gainDb: 0,  q: 0.7 },
      { type: 'bell',      frequencyHz: 350,   gainDb: -2, q: 1.0 },
      { type: 'bell',      frequencyHz: 3000,  gainDb: -1, q: 1.2 },
      { type: 'highshelf', frequencyHz: 10000, gainDb: 1.5, q: 0.7 },
    ],
    modules: {
      deess: {
        bypass: false,
        parameters: {
          frequencyHz: 7000, rangeDb: 5, thresholdDb: -30,
          ratio: 4, attackMs: 1, releaseMs: 60, wideband: false,
        },
      },
      dynamics: comp(-22, 3.5, 8, 90),
      // Wide, because that is what separates a stack from the lead.
      imager: { bypass: false, parameters: { widthPct: 130, lowMonoHz: 250, stereoize: false } },
    },
    why: '리드 보컬과 자리를 다투지 않도록 120 Hz 아래를 자르고 3 kHz를 살짝 내렸습니다. 폭을 130%로 넓혀 가운데의 리드와 분리했습니다.',
  },

  // ── Harmonic instruments ─────────────────────────────────────────────────
  guitar: {
    eqBands: [
      { type: 'highpass', frequencyHz: 80,   gainDb: 0,  q: 0.7 },
      { type: 'bell',     frequencyHz: 400,  gainDb: -2, q: 1.0 },
      { type: 'bell',     frequencyHz: 2500, gainDb: 2,  q: 1.0 },
    ],
    modules: {
      dynamics: comp(-20, 2.5, 15, 120),
      imager: { bypass: false, parameters: { widthPct: 110, lowMonoHz: 150, stereoize: false } },
    },
    why: '80 Hz 아래를 잘라 베이스와 겹치지 않게 하고, 400 Hz의 탁함을 빼고 2.5 kHz를 올려 기타가 앞으로 나오게 했습니다.',
  },

  keys: {
    eqBands: [
      { type: 'highpass',  frequencyHz: 60,   gainDb: 0,   q: 0.7 },
      { type: 'bell',      frequencyHz: 350,  gainDb: -1.5, q: 1.0 },
      { type: 'highshelf', frequencyHz: 8000, gainDb: 1.5, q: 0.7 },
    ],
    modules: {
      // Gentle: a pad or a piano that is compressed hard stops breathing,
      // and it is usually the bed the rest of the mix sits on.
      dynamics: comp(-22, 2, 25, 150),
      imager: { bypass: false, parameters: { widthPct: 115, lowMonoHz: 150, stereoize: false } },
    },
    why: '60 Hz 아래를 자르고 350 Hz를 살짝 빼서 자리를 비웠습니다. 건반과 패드는 곡의 바닥이라 컴프레서는 2:1로 약하게만 걸었습니다.',
  },

  fx: {
    eqBands: [
      { type: 'highpass', frequencyHz: 100, gainDb: 0, q: 0.7 },
    ],
    modules: {
      imager: { bypass: false, parameters: { widthPct: 130, lowMonoHz: 200, stereoize: false } },
    },
    why: '효과음은 곡마다 역할이 완전히 달라 손대지 않는 것이 맞습니다. 저역만 정리하고 넓게 펼쳤습니다.',
  },

  // ── Unidentified ─────────────────────────────────────────────────────────
  // Deliberately almost empty. See the header.
  mid: {
    eqBands: [
      { type: 'highpass', frequencyHz: 30, gainDb: 0, q: 0.7 },
    ],
    modules: {},
    why: '어떤 악기인지 확정하지 못해 서브소닉만 잘랐습니다. 악기를 직접 지정하면 그에 맞는 체인이 적용됩니다.',
  },

  other: {
    eqBands: [
      { type: 'highpass', frequencyHz: 30, gainDb: 0, q: 0.7 },
    ],
    modules: {},
    why: '악기를 알 수 없어 서브소닉만 잘랐습니다. 모르는 스템에 확신을 갖고 손대는 것보다 아무것도 하지 않는 편이 되돌리기 쉽습니다.',
  },
};

/** The preset for a role. */
export function stemChainFor(role: StemRole): StemChainPreset {
  return STEM_CHAIN[role];
}
