// Macro Control System — one knob, five processors.
//
// The idea borrowed from Smart Controls: a beginner turns PUNCH and gets a
// transient shaper, a compressor and an EQ moving together in musically
// sensible amounts; an engineer presses Advanced and sees — and can override —
// every underlying parameter.  Same session, same audio, two levels of
// exposure.
//
// The rules that keep this honest:
//   1. A macro is a PURE FUNCTION from macro values to concrete parameters.
//      Nothing is hidden: `materializeRack` returns every resulting value,
//      which is exactly what the Advanced view renders.
//   2. Macros ADD.  Each contributes a delta from the module's neutral
//      value, so WARMTH and AIR can both touch the high shelf without one
//      erasing the other.
//   3. A manual override always wins, is remembered per parameter, and is
//      marked in the UI so nobody wonders why a knob stopped responding.

import { findPlugin } from '../engine/plugins.js';

export type RackModuleId =
  | 'eq' | 'saturation' | 'transient' | 'compressor' | 'exciter' | 'width' | 'space' | 'loudness';

/** The fixed rack, in signal order. */
export interface RackModuleDef {
  id: RackModuleId;
  /** Plugin implementing it (see engine/plugins.ts). */
  pluginId: string;
  name: string;
  /** Slot in the channel's insert chain. */
  slot: number;
}

export const RACK_MODULES: readonly RackModuleDef[] = [
  { id: 'eq',         pluginId: 'eq3',        name: 'EQ',         slot: 0 },
  { id: 'saturation', pluginId: 'saturation', name: 'Saturation', slot: 1 },
  { id: 'transient',  pluginId: 'transient',  name: 'Transient',  slot: 2 },
  { id: 'compressor', pluginId: 'comp',       name: 'Compressor', slot: 3 },
  { id: 'exciter',    pluginId: 'exciter',    name: 'Exciter',    slot: 4 },
  { id: 'width',      pluginId: 'widener',    name: 'Width',      slot: 5 },
  { id: 'space',      pluginId: 'reverb',     name: 'Space',      slot: 6 },
  { id: 'loudness',   pluginId: 'limiter',    name: 'Loudness',   slot: 7 },
];

export type MacroId =
  | 'warmth' | 'clarity' | 'punch' | 'air' | 'width' | 'depth' | 'loudness';

export interface MacroTarget {
  module: RackModuleId;
  param: string;
  /** Delta applied to the module's neutral value at full macro. */
  amount: number;
  /** How the knob travels: linear, or weighted toward the low/high end. */
  curve?: 'linear' | 'slowStart' | 'fastStart';
  /**
   * Which half of a BIPOLAR macro drives this target.  Widening should engage
   * the bass-mono filter; narrowing must not drag the same filter below
   * 20 Hz, so that target only listens to the positive side.
   */
  side?: 'positive' | 'negative' | 'both';
  /** Human unit for the Advanced readout. */
  unit?: string;
}

export interface MacroDef {
  id: MacroId;
  name: string;
  /** Korean label shown under the knob. */
  label: string;
  description: string;
  /** −1…+1 instead of 0…1 (Width goes narrower as well as wider). */
  bipolar?: boolean;
  targets: MacroTarget[];
}

/**
 * Neutral parameter values — what the rack sounds like with every macro at
 * zero.  A flat, transparent chain: no gain changes, no saturation, no
 * compression, unity width, no space, no limiting.
 */
export const RACK_NEUTRAL: Record<RackModuleId, Record<string, number>> = {
  eq:         { lowDb: 0, midDb: 0, midHz: 900, highDb: 0, hpfHz: 20 },
  saturation: { driveDb: 0, mix: 0, bias: 0 },
  transient:  { attack: 0, sustain: 0, mix: 1 },
  compressor: { thresholdDb: 0, ratio: 1, attackMs: 20, releaseMs: 180, makeupDb: 0 },
  exciter:    { amount: 0, freqHz: 4000, mix: 0 },
  width:      { width: 1, lowMonoHz: 20 },
  space:      { decaySec: 1.4, mix: 0, preDelayMs: 18 },
  loudness:   { ceilingDb: 0, lookaheadMs: 2, releaseMs: 90 },
};

/**
 * The macro set.
 *
 * The amounts are the opinionated part — they encode what "more punch" means
 * on a mix bus.  They are deliberately conservative: a macro at 100 % should
 * be a strong but usable setting, not a broken one, because the whole point
 * is that a beginner cannot reach a bad place with one knob.
 */
export const MACROS: readonly MacroDef[] = [
  {
    id: 'warmth',
    name: 'WARMTH',
    label: '따뜻함',
    description: '저역을 살리고 고역을 부드럽게, 새츄레이션으로 배음을 더합니다.',
    targets: [
      { module: 'saturation', param: 'driveDb', amount: 9,    unit: 'dB' },
      { module: 'saturation', param: 'mix',     amount: 0.55 },
      { module: 'eq',         param: 'lowDb',   amount: 2.5,  unit: 'dB' },
      { module: 'eq',         param: 'highDb',  amount: -1.8, unit: 'dB' },
      { module: 'compressor', param: 'attackMs', amount: 18,  unit: 'ms', curve: 'slowStart' },
    ],
  },
  {
    id: 'clarity',
    name: 'CLARITY',
    label: '선명함',
    description: '탁한 로우미드를 덜어내고 프레즌스를 올려 또렷하게 만듭니다.',
    targets: [
      { module: 'eq',      param: 'midDb',  amount: -3.2, unit: 'dB' },
      { module: 'eq',      param: 'midHz',  amount: -400, unit: 'Hz' },
      { module: 'eq',      param: 'highDb', amount: 2.6,  unit: 'dB' },
      { module: 'eq',      param: 'hpfHz',  amount: 45,   unit: 'Hz', curve: 'slowStart' },
      { module: 'exciter', param: 'mix',    amount: 0.18 },
    ],
  },
  {
    id: 'punch',
    name: 'PUNCH',
    label: '펀치',
    description: '어택을 세우고 컴프를 빠르게 걸어 리듬이 앞으로 나오게 합니다.',
    targets: [
      { module: 'transient',  param: 'attack',      amount: 0.7 },
      { module: 'compressor', param: 'thresholdDb', amount: -16, unit: 'dB' },
      { module: 'compressor', param: 'ratio',       amount: 2.6 },
      { module: 'compressor', param: 'attackMs',    amount: -16, unit: 'ms', curve: 'fastStart' },
      { module: 'compressor', param: 'makeupDb',    amount: 3.2, unit: 'dB' },
      // A small upper-mid lift is what makes an attack read as "punch"
      // rather than just "louder".
      { module: 'eq',         param: 'midDb',       amount: 1.6, unit: 'dB' },
      { module: 'eq',         param: 'midHz',       amount: 2100, unit: 'Hz' },
    ],
  },
  {
    id: 'air',
    name: 'AIR',
    label: '공기감',
    description: '10kHz 위쪽에 배음을 더해 숨결과 반짝임을 살립니다.',
    targets: [
      { module: 'exciter', param: 'amount', amount: 0.75 },
      { module: 'exciter', param: 'freqHz', amount: 5500, unit: 'Hz' },
      { module: 'exciter', param: 'mix',    amount: 0.35 },
      { module: 'eq',      param: 'highDb', amount: 2.2,  unit: 'dB' },
    ],
  },
  {
    id: 'width',
    name: 'WIDTH',
    label: '넓이',
    description: '사이드 성분을 넓히거나 좁힙니다. 저역은 항상 모노로 유지합니다.',
    bipolar: true,
    targets: [
      { module: 'width', param: 'width',     amount: 0.85 },
      // Only when widening — narrowing must not push the filter below 20 Hz.
      { module: 'width', param: 'lowMonoHz', amount: 100, unit: 'Hz',
        curve: 'slowStart', side: 'positive' },
    ],
  },
  {
    id: 'depth',
    name: 'DEPTH',
    label: '깊이',
    description: '짧은 공간을 더해 소리를 앞뒤로 배치합니다.',
    targets: [
      { module: 'space', param: 'mix',        amount: 0.3 },
      { module: 'space', param: 'decaySec',   amount: 1.1, unit: 's' },
      { module: 'space', param: 'preDelayMs', amount: 14,  unit: 'ms' },
      { module: 'eq',    param: 'highDb',     amount: -0.8, unit: 'dB' },
    ],
  },
  {
    id: 'loudness',
    name: 'LOUDNESS',
    label: '음압',
    description: '리미터 실링을 낮추고 게인을 올려 체감 음량을 키웁니다.',
    targets: [
      { module: 'loudness',   param: 'ceilingDb', amount: -1,  unit: 'dB' },
      { module: 'compressor', param: 'thresholdDb', amount: -10, unit: 'dB' },
      { module: 'compressor', param: 'makeupDb',  amount: 5.5, unit: 'dB' },
      { module: 'loudness',   param: 'releaseMs', amount: -40, unit: 'ms' },
    ],
  },
];

export function findMacro(id: MacroId): MacroDef | undefined {
  return MACROS.find((m) => m.id === id);
}

// ── Rack state ────────────────────────────────────────────────────────────────

export type MacroValues = Partial<Record<MacroId, number>>;

/** `"module.param"` → manual value from the Advanced view. */
export type ParamOverrides = Record<string, number>;

export interface MacroRack {
  enabled: boolean;
  values: MacroValues;
  overrides: ParamOverrides;
}

export const EMPTY_RACK: MacroRack = { enabled: false, values: {}, overrides: {} };

export function overrideKey(module: RackModuleId, param: string): string {
  return `${module}.${param}`;
}

// ── Materialisation ───────────────────────────────────────────────────────────

function shape(value: number, curve: MacroTarget['curve']): number {
  const sign = value < 0 ? -1 : 1;
  const v = Math.abs(value);
  switch (curve) {
    case 'slowStart': return sign * v * v;              // gentle at the bottom
    case 'fastStart': return sign * Math.sqrt(v);       // most of the move early
    default:          return sign * v;
  }
}

export interface ResolvedParam {
  module: RackModuleId;
  param: string;
  value: number;
  /** Value the macros alone would produce (before any override). */
  macroValue: number;
  /** True when the Advanced view has pinned this parameter. */
  overridden: boolean;
  /** Which macros moved it, for the "why is this here" readout. */
  drivenBy: MacroId[];
  unit: string;
}

export interface ResolvedModule {
  module: RackModuleDef;
  params: ResolvedParam[];
  /** A module nothing touched is bypassed — no CPU, no colour. */
  active: boolean;
}

const clampMacro = (def: MacroDef, value: number): number => {
  const lo = def.bipolar ? -1 : 0;
  return Math.max(lo, Math.min(1, value));
};

/**
 * Turn macro values into the concrete parameter set.
 *
 * This is the single source of truth: playback, the Advanced view, and the
 * offline bounce all read the result of this function.
 */
/**
 * Clamp to what the plugin actually accepts.
 *
 * This is the guard rail behind "one knob cannot reach a bad place": whatever
 * combination of macros and curves lands on a parameter, the value handed to
 * the engine is inside the range the plugin declares.
 */
function clampToPlugin(pluginId: string, param: string, value: number): number {
  const def = findPlugin(pluginId)?.params.find((p) => p.id === param);
  if (!def) return value;
  return Math.max(def.min, Math.min(def.max, value));
}

export function materializeRack(rack: MacroRack): ResolvedModule[] {
  const accumulated = new Map<string, { value: number; drivenBy: MacroId[]; unit: string }>();

  for (const macro of MACROS) {
    const raw = rack.values[macro.id] ?? 0;
    const value = clampMacro(macro, raw);
    if (value === 0) continue;
    for (const target of macro.targets) {
      const side = target.side ?? 'both';
      if (side === 'positive' && value < 0) continue;
      if (side === 'negative' && value > 0) continue;
      const key = overrideKey(target.module, target.param);
      const contribution = shape(value, target.curve) * target.amount;
      const existing = accumulated.get(key);
      accumulated.set(key, {
        value: (existing?.value ?? 0) + contribution,
        drivenBy: [...(existing?.drivenBy ?? []), macro.id],
        unit: target.unit ?? existing?.unit ?? '',
      });
    }
  }

  return RACK_MODULES.map((module) => {
    const neutral = RACK_NEUTRAL[module.id];
    const params: ResolvedParam[] = Object.entries(neutral).map(([param, base]) => {
      const key = overrideKey(module.id, param);
      const delta = accumulated.get(key);
      const macroValue = clampToPlugin(module.pluginId, param, base + (delta?.value ?? 0));
      const override = rack.overrides[key];
      return {
        module: module.id,
        param,
        value: override !== undefined
          ? clampToPlugin(module.pluginId, param, override)
          : macroValue,
        macroValue,
        overridden: override !== undefined,
        drivenBy: delta?.drivenBy ?? [],
        unit: delta?.unit ?? '',
      };
    });
    return {
      module,
      params,
      active: params.some((p) => p.overridden || p.drivenBy.length > 0),
    };
  });
}

/** Flat `{param: value}` map for one module — what the engine feeds a plugin. */
export function moduleParams(resolved: ResolvedModule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of resolved.params) out[p.param] = p.value;
  return out;
}

// ── Explanations ──────────────────────────────────────────────────────────────

/**
 * "PUNCH 60 % → 트랜지언트 어택 +0.42, 컴프 임계값 −9.6 dB …"
 *
 * A macro that cannot explain itself is a black box, and a black box is
 * exactly what an engineer refuses to use.
 */
export function explainMacro(macro: MacroDef, value: number): string[] {
  const v = clampMacro(macro, value);
  if (v === 0) return [];
  return macro.targets.map((target) => {
    const delta = shape(v, target.curve) * target.amount;
    const moduleName = RACK_MODULES.find((m) => m.id === target.module)?.name ?? target.module;
    const sign = delta > 0 ? '+' : '';
    const rounded = Math.abs(delta) >= 10 ? delta.toFixed(0) : delta.toFixed(2);
    return `${moduleName} ${target.param} ${sign}${rounded}${target.unit ?? ''}`;
  });
}

/** Every macro currently doing something, for a compact strip readout. */
export function activeMacros(rack: MacroRack): Array<{ macro: MacroDef; value: number }> {
  return MACROS
    .map((macro) => ({ macro, value: clampMacro(macro, rack.values[macro.id] ?? 0) }))
    .filter((entry) => entry.value !== 0);
}

/** Reset one parameter back to what the macros say. */
export function clearOverride(rack: MacroRack, module: RackModuleId, param: string): MacroRack {
  const key = overrideKey(module, param);
  if (rack.overrides[key] === undefined) return rack;
  const overrides = { ...rack.overrides };
  delete overrides[key];
  return { ...rack, overrides };
}

export function setOverride(
  rack: MacroRack, module: RackModuleId, param: string, value: number,
): MacroRack {
  return { ...rack, overrides: { ...rack.overrides, [overrideKey(module, param)]: value } };
}

export function setMacro(rack: MacroRack, id: MacroId, value: number): MacroRack {
  const def = findMacro(id);
  if (!def) return rack;
  return { ...rack, values: { ...rack.values, [id]: clampMacro(def, value) } };
}

/** Presets a beginner can start from — every one is just macro values. */
export interface MacroPreset {
  id: string;
  name: string;
  description: string;
  values: MacroValues;
}

export const MACRO_PRESETS: readonly MacroPreset[] = [
  { id: 'vocal-front', name: 'Vocal Front', description: '보컬을 앞으로',
    values: { clarity: 0.55, punch: 0.35, air: 0.45, depth: 0.2, loudness: 0.3 } },
  { id: 'warm-tape', name: 'Warm Tape', description: '아날로그 질감',
    values: { warmth: 0.65, punch: 0.2, loudness: 0.25 } },
  { id: 'drum-slam', name: 'Drum Slam', description: '드럼 버스',
    values: { punch: 0.8, clarity: 0.3, loudness: 0.45 } },
  { id: 'wide-master', name: 'Wide Master', description: '마스터 버스',
    values: { clarity: 0.25, air: 0.35, width: 0.4, loudness: 0.5 } },
  { id: 'intimate', name: 'Intimate', description: '가까운 소리',
    values: { warmth: 0.4, width: -0.35, depth: 0.15 } },
];
