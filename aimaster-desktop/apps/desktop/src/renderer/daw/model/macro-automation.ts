// Automating a macro knob.
//
// A macro is a pure function from one number to every parameter of the rack,
// so automating it is not "ramp a parameter" — it is "recompute the rack,
// continuously".  What makes that possible on this engine is that the result
// still has to arrive as scheduled AudioParam ramps: everything else in this
// DAW is scheduled, and a macro driven by a timer would work while you
// monitored and vanish from the bounce.
//
// So a macro lane becomes SEVERAL ramps — one per AudioParam the macro
// reaches — each sampled from the same lane, each mapped through the macro's
// own curve.  A coupled pair (the compressor's threshold and its makeup
// compensation) moves together because one number decides both, which is
// exactly the case `PluginInstance.drives` exists for.
//
// Not every target can follow.  A shaper curve is rebuilt, not ramped; an
// impulse response is generated, not ramped.  Those parameters stay where
// the session left them, and this module's job is to say WHICH — a macro
// that half-moves in silence is worse than one that refuses.

import { findPlugin } from '../engine/plugins.js';
import {
  MACROS, RACK_MODULES, materializeRack, overrideKey,
  type MacroDef, type MacroId, type MacroRack, type RackModuleId,
} from './macros.js';

/** A parameter a macro lane will actually move. */
export interface MovingTarget {
  module: RackModuleId;
  param: string;
  /** The parameter's value when the macro sits at `value`. */
  at: (value: number) => number;
}

/** A parameter the macro touches but cannot ramp, and why. */
export interface FixedTarget {
  module: RackModuleId;
  param: string;
  reason: string;
}

export interface MacroCoverage {
  macro: MacroDef;
  moving: MovingTarget[];
  fixed: FixedTarget[];
  /** True when every target follows — the lane is the whole gesture. */
  complete: boolean;
}

/** Why a parameter cannot be ramped, in the terms the device is built in. */
function fixedReason(pluginId: string, param: string): string {
  const device = findPlugin(pluginId);
  const name = device?.params.find((p) => p.id === param)?.name ?? param;
  return `${name} — 곡선을 다시 만드는 값이라 램프할 수 없습니다`;
}

/**
 * Which of a macro's targets can follow a lane, given the rack's overrides.
 *
 * Depends on the rack because a MANUAL OVERRIDE wins over the macro: a
 * parameter the engineer has pinned does not move for anybody, and a lane
 * that pretended otherwise would fight the pin on every block.
 */
export function macroCoverage(macro: MacroDef, rack: MacroRack): MacroCoverage {
  const moving: MovingTarget[] = [];
  const fixed: FixedTarget[] = [];
  const seen = new Set<string>();

  for (const target of macro.targets) {
    const key = overrideKey(target.module, target.param);
    if (seen.has(key)) continue;
    seen.add(key);

    if (rack.overrides[key] !== undefined) {
      fixed.push({
        module: target.module,
        param: target.param,
        reason: '수동으로 고정된 값입니다',
      });
      continue;
    }

    const module = RACK_MODULES.find((m) => m.id === target.module);
    const device = module ? findPlugin(module.pluginId) : undefined;
    if (!module || !device) continue;

    const rampable = [
      ...(device.automatableParams ?? []),
      ...(device.drivenParams ?? []),
    ].includes(target.param);

    if (!rampable) {
      fixed.push({
        module: target.module,
        param: target.param,
        reason: fixedReason(module.pluginId, target.param),
      });
      continue;
    }

    moving.push({
      module: target.module,
      param: target.param,
      at: (value) => rackValueAt(rack, macro.id, value, target.module, target.param),
    });
  }

  return { macro, moving, fixed, complete: fixed.length === 0 && moving.length > 0 };
}

/**
 * The rack as it would be with one macro moved to `value`.
 *
 * Memoised per (macro, value): a ramp samples the lane at dozens of points
 * per window and asks every moving target for its value at each one, so
 * without this the whole rack would be materialised once per parameter per
 * point instead of once per point.
 */
const rackCache = new WeakMap<MacroRack, Map<string, Map<string, number>>>();

function rackValueAt(
  rack: MacroRack, macroId: MacroId, value: number,
  module: RackModuleId, param: string,
): number {
  let byMacro = rackCache.get(rack);
  if (!byMacro) { byMacro = new Map(); rackCache.set(rack, byMacro); }
  const cacheKey = `${macroId}:${value}`;
  let flat = byMacro.get(cacheKey);
  if (!flat) {
    flat = new Map();
    const moved: MacroRack = { ...rack, values: { ...rack.values, [macroId]: value } };
    for (const resolved of materializeRack(moved)) {
      for (const p of resolved.params) {
        flat.set(overrideKey(resolved.module.id, p.param), p.value);
      }
    }
    // Bounded: a ramp walks a window in fixed steps, but a session left
    // running would otherwise grow this forever.
    if (byMacro.size > 512) byMacro.clear();
    byMacro.set(cacheKey, flat);
  }
  return flat.get(overrideKey(module, param)) ?? 0;
}

/** Macros a lane can be drawn on at all, in menu order. */
export function automatableMacros(rack: MacroRack): MacroCoverage[] {
  return MACROS.map((macro) => macroCoverage(macro, rack)).filter((c) => c.moving.length > 0);
}

export function findCoverage(rack: MacroRack, macroId: MacroId): MacroCoverage | null {
  const macro = MACROS.find((m) => m.id === macroId);
  return macro ? macroCoverage(macro, rack) : null;
}

/**
 * The lane's label — and, when the gesture is only partly followed, what is
 * being left behind.
 *
 * Named parts, not a count: "2 targets will not follow" sends you hunting
 * through the Advanced view for which two.
 */
export function describeCoverage(coverage: MacroCoverage): string {
  if (coverage.complete) return coverage.macro.label;
  if (coverage.moving.length === 0) return `${coverage.macro.label} (자동화 불가)`;
  const names = coverage.fixed.map((f) => {
    const module = RACK_MODULES.find((m) => m.id === f.module);
    const device = module ? findPlugin(module.pluginId) : undefined;
    const param = device?.params.find((p) => p.id === f.param);
    return `${module?.name ?? f.module} ${param?.name ?? f.param}`;
  });
  // Phrased without a particle: the module names are English (as they are
  // everywhere in the Advanced view) and 은/는 depends on how the word ends,
  // which no English word settles.
  return `${coverage.macro.label} (${names.join(', ')} 제외)`;
}

/** The macros that cannot be automated at all, for the menu's absence to be explicable. */
export function unautomatableMacros(rack: MacroRack): MacroCoverage[] {
  return MACROS.map((macro) => macroCoverage(macro, rack)).filter((c) => c.moving.length === 0);
}
