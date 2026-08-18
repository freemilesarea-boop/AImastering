// stem-studio — open a stem in the Studio, and take its chain back out.
//
// The Studio is already keyed by absolute file path: it seeds itself from
// `loadSongSettings(path)` and saves back to the same place. A stem IS a
// file. So per-stem editing needs no second Studio, no nested parameter
// provider and no parallel storage — it needs the stem's path put in front
// of the page the app already has, and a way for the render to read what
// comes back.
//
// This file is that bridge, and it carries the two decisions that make it
// safe.
//
// # 1. Opening the Studio seeds the instrument's chain, not a blank rack
//
// A stem opened cold would otherwise show twenty-five neutral modules, and
// the kick chain the classifier chose would be gone the moment the user
// looked at it. So the first open writes the role's preset into the stem's
// settings. From then on the saved state is the truth for that stem.
//
// # 2. A hand-edited chain outranks the role, and is never silently thrown
//    away
//
// Once a stem has its own settings, changing its instrument does NOT
// overwrite them. Re-seeding would be defensible — "I said it's a bass, give
// me the bass chain" — but it would also discard an hour of work with no
// warning and no undo, and the two are indistinguishable from here. So the
// role change stands, the chain stays, and the mixer offers an explicit
// "reset to the instrument default" instead.
//
// # The master-only rule still holds
//
// The Studio edits the whole rack, limiter and dither included, because on
// a master that is the right rack. On a stem it is not: a limiter per stem
// destroys the mix balance and dither belongs at the final word-length
// reduction only. Whatever the user does in the Studio, those stages are
// stripped on the way out — see `stripMasterOnly`.

import type { ChainConfigWire } from '../chain-config.js';
import { buildChainConfig } from '../chain-config.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../parameters/module-parameter-definitions.js';
import { defaultAllModulesState, type AllModulesParameterState, type ModuleId } from '../parameters/parameter-state.js';
import type { FreeEqBand } from '../modules/eq-graph-model.js';
import { freeBandToWire } from '../modules/eq-graph-model.js';
import {
  loadSongSettings, saveSongSettings, clearSongSettings, type SongSettings,
} from '../session/song-settings.js';
import { STEM_CHAIN, type StemRole } from './stem-defaults.js';
import { stemWireFor } from './stem-chain-config.js';

/** Stages that belong to the master bus and are removed from every stem. */
export const MASTER_ONLY_WIRE_KEYS = ['limiter', 'loudness', 'dither'] as const;

let bandSeq = 0;
function bandId(): string {
  bandSeq += 1;
  return `stem-band-${bandSeq}`;
}

/**
 * Remove the stages a stem must not carry.
 *
 * Returns a copy: the caller's wire may be memoised somewhere and mutating
 * it would strip the master bus too, the one place these stages belong.
 */
export function stripMasterOnly(wire: ChainConfigWire): ChainConfigWire {
  const out: ChainConfigWire = { ...wire };
  for (const key of MASTER_ONLY_WIRE_KEYS) delete out[key];
  return out;
}

/**
 * The role preset expressed as a full rack state plus its EQ bands.
 *
 * # The rack starts neutral, not default
 *
 * `defaultAllModulesState` is the app's starting point for MASTERING a
 * finished song, and it is not neutral: the EQ arrives engaged with a 32 Hz
 * cut, a +1.2 dB low shelf, +1.4 dB presence and +2 dB of air, the
 * compressor is on at -14 dB / 2:1, and the imager has a band-width curve.
 * That is a reasonable opening move on a mix. On a stem it is wrong twice
 * over: the `mid` role promises to leave an unidentified stem alone and
 * would instead hand it a master's voicing, and every other role would get
 * that voicing stacked on top of its instrument chain — an air boost and a
 * second compressor on a kick.
 *
 * Measured before this was fixed: opening an untouched `mid` stem in the
 * Studio and changing nothing took 3.2 dB off it.
 *
 * So every module is bypassed first, and only what the role asks for is
 * switched back on. A stem chain is the instrument's chain and nothing else.
 */
export function stemPresetToState(role: StemRole): {
  state: AllModulesParameterState;
  freeBands: FreeEqBand[];
} {
  const preset = STEM_CHAIN[role];
  const state = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);

  for (const id of Object.keys(state) as ModuleId[]) {
    state[id] = { ...state[id], bypass: true };
  }

  for (const [id, setting] of Object.entries(preset.modules)) {
    const moduleId = id as ModuleId;
    if (!state[moduleId]) continue;
    state[moduleId] = {
      ...state[moduleId],
      // A module the role names is engaged unless it says otherwise — it is
      // in the preset because the instrument wants it.
      bypass: setting?.bypass ?? false,
      parameters: { ...state[moduleId].parameters, ...(setting?.parameters ?? {}) },
    };
  }

  // The free EQ is engaged by its bands, not by an entry in `modules` — a
  // role expresses its EQ as `eqBands`. Bypassing it along with everything
  // else would silently drop every band the instrument asked for:
  // `buildChainConfig` emits the parametric EQ only when the module is not
  // bypassed, so the kick would keep its compressor and lose its high-pass.
  if (preset.eqBands.length > 0 && state['parametric-eq']) {
    state['parametric-eq'] = { ...state['parametric-eq'], bypass: false };
  }

  const freeBands: FreeEqBand[] = preset.eqBands.map((b) => ({
    id: bandId(),
    kind: b.type,
    frequencyHz: b.frequencyHz,
    gainDb: b.gainDb,
    q: b.q,
    enabled: true,
  }));

  return { state, freeBands };
}

/** True when this stem has settings of its own — i.e. it has been opened. */
export function hasStemChain(filePath: string): boolean {
  return loadSongSettings(filePath) !== null;
}

/**
 * Make sure a stem has settings the Studio can open, and return them.
 *
 * Idempotent: a stem that already has settings keeps them untouched, which
 * is what stops a second visit to the Studio from resetting the first
 * visit's work.
 */
export function ensureStemChain(filePath: string, role: StemRole): SongSettings {
  const existing = loadSongSettings(filePath);
  if (existing) return existing;

  const { state, freeBands } = stemPresetToState(role);
  return saveSongSettings({
    filePath,
    state,
    freeBands,
    masterBypass: false,
    presetId: null,
  });
}

/** Throw away a stem's hand-edited chain and go back to its instrument default. */
export function resetStemChain(filePath: string, role: StemRole): SongSettings {
  clearSongSettings(filePath);
  return ensureStemChain(filePath, role);
}

/**
 * The engine config for a stem: its own edited chain if it has one, the
 * role's default if it does not.
 *
 * Two sources on purpose. Building everything through the Studio's saved
 * state would mean a stem nobody opened still had to have a full rack
 * written for it, and a role change on an untouched stem would have to
 * rewrite that rack to take effect. Reading the role directly when there is
 * nothing saved keeps an untouched stem following its instrument.
 */
export function resolveStemWire(filePath: string, role: StemRole): ChainConfigWire {
  const saved = loadSongSettings(filePath);
  if (!saved) return stripMasterOnly(stemWireFor(role));

  const wire = buildChainConfig({
    state: saved.state,
    masterBypass: saved.masterBypass,
    parametricBands: saved.freeBands.map(freeBandToWire),
    // Monitoring is session state — mono checks and side-solo are for
    // listening, not for the file — so it is deliberately not passed.
    ...(saved.referenceCurveDb ? { matchTargetCurveDb: saved.referenceCurveDb } : {}),
  });

  return stripMasterOnly(wire);
}
