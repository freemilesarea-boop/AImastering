// stem-chain-config — turn a stem preset into the config the engine runs.
//
// `stem-defaults` describes a chain the way the UI thinks about it (module
// ids and parameter names). The engine wants a `ChainConfigWire`. This is
// the translation, and it is the ONLY place a stem's chain is built, so the
// rules that keep a stem from behaving like a master live here rather than
// being restated at every call site.
//
// The translation is deliberately narrow: it handles the modules the stem
// presets actually use. A module that appears in a preset and not here would
// silently do nothing, so `stem-chain-config-selftest` walks every preset
// and fails on any module this file does not translate — the table and the
// translator cannot drift apart without a test going red.

import type { ChainConfigWire, ParametricBandWire, ParametricBandKind } from '../chain-config.js';
import type { ParametricBandType } from '../modules/parametric-eq-model.js';
import {
  STEM_CHAIN, MASTER_ONLY_MODULES,
  type StemRole, type StemChainPreset, type StemModuleSetting,
} from './stem-defaults.js';
import type { ModuleId } from '../parameters/index.js';

/** Modules this file knows how to translate. */
export const TRANSLATED_MODULES: readonly ModuleId[] = [
  'dynamics', 'deess', 'impact', 'imager', 'low-end-focus',
] as const;

const BAND_KIND: Record<ParametricBandType, ParametricBandKind> = {
  highpass:  'highPass',
  lowpass:   'lowPass',
  bell:      'bell',
  lowshelf:  'lowShelf',
  highshelf: 'highShelf',
};

function n(setting: StemModuleSetting | undefined, key: string, fallback: number): number {
  const v = setting?.parameters[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function s(setting: StemModuleSetting | undefined, key: string, fallback: string): string {
  const v = setting?.parameters[key];
  return typeof v === 'string' ? v : fallback;
}

function b(setting: StemModuleSetting | undefined, key: string, fallback: boolean): boolean {
  const v = setting?.parameters[key];
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Build the engine config for one stem.
 *
 * `gainDb` is NOT applied here. The fader is a mixer control and belongs to
 * the sum, not to the stem's chain — putting it in the chain would mean a
 * fader move re-renders the stem instead of just scaling it, and would put
 * the gain before the stem's own compressor, where moving the fader would
 * change the compression as well as the level.
 */
export function stemPresetToWire(preset: StemChainPreset): ChainConfigWire {
  const wire: ChainConfigWire = {};
  const m = preset.modules;

  // ── Free parametric EQ ───────────────────────────────────────────────────
  if (preset.eqBands.length > 0) {
    const bands: ParametricBandWire[] = preset.eqBands.map((band) => ({
      kind: BAND_KIND[band.type],
      frequencyHz: band.frequencyHz,
      gainDb: band.gainDb,
      q: band.q,
      enabled: true,
    }));
    wire.parametricEq = { bands, bypass: false };
  }

  // ── Compressor ───────────────────────────────────────────────────────────
  if (m.dynamics) {
    wire.dynamics = {
      thresholdDb: n(m.dynamics, 'thresholdDb', -18),
      ratio:       n(m.dynamics, 'ratio', 2),
      attackMs:    n(m.dynamics, 'attackMs', 20),
      releaseMs:   n(m.dynamics, 'releaseMs', 120),
      mixPct:      n(m.dynamics, 'mixPct', 100),
      bypass:      m.dynamics.bypass === true,
    };
  }

  // ── De-esser ─────────────────────────────────────────────────────────────
  if (m.deess) {
    wire.deess = {
      frequencyHz: n(m.deess, 'frequencyHz', 7000),
      thresholdDb: n(m.deess, 'thresholdDb', -28),
      ratio:       n(m.deess, 'ratio', 4),
      rangeDb:     n(m.deess, 'rangeDb', 4),
      attackMs:    n(m.deess, 'attackMs', 1),
      releaseMs:   n(m.deess, 'releaseMs', 60),
      wideband:    b(m.deess, 'wideband', false),
      bypass:      m.deess.bypass === true,
    };
  }

  // ── Transient shaping ────────────────────────────────────────────────────
  if (m.impact) {
    wire.impact = {
      crossoverHz: [
        n(m.impact, 'crossover1Hz', 120),
        n(m.impact, 'crossover2Hz', 800),
        n(m.impact, 'crossover3Hz', 5000),
      ],
      impactPct: [
        n(m.impact, 'band0Pct', 0), n(m.impact, 'band1Pct', 0),
        n(m.impact, 'band2Pct', 0), n(m.impact, 'band3Pct', 0),
      ],
      bypass: m.impact.bypass === true,
    };
  }

  // ── Stereo ───────────────────────────────────────────────────────────────
  if (m.imager) {
    wire.imager = {
      widthPct:  n(m.imager, 'widthPct', 100),
      lowMonoHz: n(m.imager, 'lowMonoHz', 120),
      bypass:    m.imager.bypass === true,
    };
  }

  // ── Low-end separation ───────────────────────────────────────────────────
  if (m['low-end-focus']) {
    const mode = s(m['low-end-focus'], 'mode', 'punchy');
    wire.lowEndFocus = {
      mode:        mode === 'smooth' ? 'smooth' : 'punchy',
      frequencyHz: n(m['low-end-focus'], 'frequencyHz', 90),
      contrastPct: n(m['low-end-focus'], 'contrastPct', 25),
      gainDb:      n(m['low-end-focus'], 'gainDb', 0),
      bypass:      m['low-end-focus'].bypass === true,
    };
  }

  return wire;
}

/** The engine config for a role, straight from the table. */
export function stemWireFor(role: StemRole): ChainConfigWire {
  return stemPresetToWire(STEM_CHAIN[role]);
}

/**
 * Modules a preset asks for that this file does not translate.
 *
 * Used by the test rather than at runtime: a preset that reaches production
 * with an untranslated module would appear to be configured and do nothing,
 * which is the failure mode this whole file is arranged to prevent.
 */
export function untranslatedModules(preset: StemChainPreset): ModuleId[] {
  return (Object.keys(preset.modules) as ModuleId[])
    .filter((id) => !TRANSLATED_MODULES.includes(id));
}

/** True when a wire config would touch anything that belongs to the master. */
export function touchesMasterOnly(wire: ChainConfigWire): boolean {
  if (wire.limiter !== undefined) return true;
  if (wire.loudness !== undefined) return true;
  if (wire.dither !== undefined) return true;
  return false;
}

export { MASTER_ONLY_MODULES };
