// Racks — a chain inside a device, with only the knobs that matter on the lid.
//
//   LOUI VOCAL RACK
//     Denoise → Pitch → Dynamic EQ → Compressor → De-Esser → Saturation → Air
//
//   the user sees:
//     CLEAN     ●──────
//     BODY      ───●───
//     PRESENCE  ────●──
//     AIR       ─────●─
//
// This is the Ableton Rack idea joined to the Smart Control idea: the rack
// OWNS its devices, and a small set of macros maps into their parameters.
// Opening the rack shows the real chain and every mapping — nothing is
// hidden, it is just folded.
//
// Mapping style follows Ableton's: a macro moves a parameter between a FROM
// and a TO value, so one knob can push one parameter up while pulling another
// down.  (The channel-level Macro Control System uses additive deltas instead,
// because several macros share those parameters; inside a rack each mapping
// owns its parameter outright.)

import {
  createNode, linearGraph, type DeviceGraph, type DeviceId, findNode, deviceOrder,
} from './device-graph.js';
import { nextId } from './ids.js';
import { defaultParams } from '../engine/plugins.js';

export interface RackMacroTarget {
  nodeId: DeviceId;
  param: string;
  /** Parameter value when the macro is at 0. */
  from: number;
  /** Parameter value when the macro is at 1. */
  to: number;
}

export interface RackMacro {
  id: string;
  name: string;
  /** Korean label under the slider. */
  label: string;
  targets: RackMacroTarget[];
}

export interface Rack {
  id: string;
  name: string;
  graph: DeviceGraph;
  macros: RackMacro[];
  /** macroId → 0…1 */
  values: Record<string, number>;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createRack(name: string, graph: DeviceGraph, macros: RackMacro[] = []): Rack {
  return {
    id: nextId('rack'),
    name,
    graph,
    macros,
    values: Object.fromEntries(macros.map((m) => [m.id, 0])),
  };
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface ResolvedRackParam {
  nodeId: DeviceId;
  param: string;
  value: number;
  /** Macro that owns this parameter, if any. */
  macroId: string | null;
}

/**
 * Final parameter values for every device in the rack: each node's own params
 * as the base, with mapped parameters taken over by their macro.
 */
export function resolveRack(rack: Rack): Map<DeviceId, Record<string, number>> {
  const out = new Map<DeviceId, Record<string, number>>();
  for (const node of rack.graph.nodes) {
    if (node.kind !== 'device') continue;
    const base = node.pluginId ? defaultParams(node.pluginId) : {};
    out.set(node.id, { ...base, ...node.params });
  }
  for (const macro of rack.macros) {
    const value = clamp01(rack.values[macro.id] ?? 0);
    for (const target of macro.targets) {
      const params = out.get(target.nodeId);
      if (!params) continue;
      params[target.param] = target.from + (target.to - target.from) * value;
    }
  }
  return out;
}

/** Flat list for the rack's "show every mapping" view. */
export function resolvedParams(rack: Rack): ResolvedRackParam[] {
  const resolved = resolveRack(rack);
  const owner = new Map<string, string>();
  for (const macro of rack.macros) {
    for (const target of macro.targets) owner.set(`${target.nodeId}.${target.param}`, macro.id);
  }
  const out: ResolvedRackParam[] = [];
  for (const [nodeId, params] of resolved) {
    for (const [param, value] of Object.entries(params)) {
      out.push({ nodeId, param, value, macroId: owner.get(`${nodeId}.${param}`) ?? null });
    }
  }
  return out;
}

export function setRackMacro(rack: Rack, macroId: string, value: number): Rack {
  if (!rack.macros.some((m) => m.id === macroId)) return rack;
  return { ...rack, values: { ...rack.values, [macroId]: clamp01(value) } };
}

/**
 * Map (or re-map) a macro onto one parameter.
 *
 * A parameter can have only ONE owner: mapping a second macro onto it takes
 * it away from the first.  Two macros fighting over one value is a bug the
 * user cannot see, only hear.
 */
export function mapMacro(
  rack: Rack, macroId: string, target: RackMacroTarget,
): Rack {
  return {
    ...rack,
    macros: rack.macros.map((macro) => {
      const rest = macro.targets.filter(
        (t) => !(t.nodeId === target.nodeId && t.param === target.param),
      );
      return macro.id === macroId
        ? { ...macro, targets: [...rest, target] }
        : (rest.length === macro.targets.length ? macro : { ...macro, targets: rest });
    }),
  };
}

export function unmapMacro(
  rack: Rack, macroId: string, nodeId: DeviceId, param: string,
): Rack {
  return {
    ...rack,
    macros: rack.macros.map((macro) => (macro.id === macroId
      ? { ...macro, targets: macro.targets.filter((t) => !(t.nodeId === nodeId && t.param === param)) }
      : macro)),
  };
}

/** Which macro (if any) owns a parameter — the rack view marks these. */
export function macroFor(rack: Rack, nodeId: DeviceId, param: string): RackMacro | undefined {
  return rack.macros.find((m) => m.targets.some((t) => t.nodeId === nodeId && t.param === param));
}

/** "Denoise → Dynamic EQ → Compressor → …" for the collapsed rack row. */
export function describeRack(rack: Rack): string {
  return deviceOrder(rack.graph).map((n) => n.label).join(' → ');
}

// ── Built-in racks ────────────────────────────────────────────────────────────

interface RackBlueprint {
  id: string;
  name: string;
  description: string;
  devices: Array<{ pluginId: string; label: string }>;
  /** Macros described by device INDEX, resolved to ids when the rack is built. */
  macros: Array<{
    name: string;
    label: string;
    targets: Array<{ device: number; param: string; from: number; to: number }>;
  }>;
}

const BLUEPRINTS: readonly RackBlueprint[] = [
  {
    id: 'loui-vocal',
    name: 'LOUI VOCAL RACK',
    description: '보컬 한 채널을 네 개 노브로',
    devices: [
      { pluginId: 'denoise',      label: 'DENOISE' },
      { pluginId: 'pitchcorrect', label: 'PITCH' },
      { pluginId: 'dyneq',        label: 'DYN EQ' },
      { pluginId: 'comp',         label: 'COMP' },
      { pluginId: 'deesser',      label: 'DE-ESSER' },
      { pluginId: 'saturation',   label: 'SATURATION' },
      { pluginId: 'exciter',      label: 'AIR' },
    ],
    macros: [
      {
        name: 'CLEAN', label: '깨끗함',
        targets: [
          { device: 0, param: 'amount',      from: 0,  to: 0.85 },
          { device: 0, param: 'thresholdDb', from: -60, to: -42 },
          { device: 2, param: 'rangeDb',     from: 0,  to: -8 },
          { device: 4, param: 'amount',      from: 0,  to: 0.55 },
        ],
      },
      {
        name: 'BODY', label: '두께',
        targets: [
          { device: 5, param: 'driveDb',     from: 0,  to: 10 },
          { device: 5, param: 'mix',         from: 0,  to: 0.45 },
          { device: 3, param: 'thresholdDb', from: -6, to: -22 },
        ],
      },
      {
        name: 'PRESENCE', label: '존재감',
        targets: [
          { device: 3, param: 'ratio',    from: 1,  to: 3.5 },
          { device: 3, param: 'attackMs', from: 30, to: 8 },
          { device: 3, param: 'makeupDb', from: 0,  to: 3 },
          { device: 2, param: 'freqHz',   from: 300, to: 2600 },
        ],
      },
      {
        name: 'AIR', label: '공기감',
        targets: [
          { device: 6, param: 'amount', from: 0,    to: 0.8 },
          { device: 6, param: 'mix',    from: 0,    to: 0.4 },
          { device: 6, param: 'freqHz', from: 4000, to: 7000 },
        ],
      },
    ],
  },
  {
    id: 'loui-drum',
    name: 'LOUI DRUM RACK',
    description: '드럼 버스 — 어택과 무게',
    devices: [
      { pluginId: 'transient',  label: 'TRANSIENT' },
      { pluginId: 'eq3',        label: 'EQ' },
      { pluginId: 'comp',       label: 'GLUE' },
      { pluginId: 'saturation', label: 'DRIVE' },
    ],
    macros: [
      {
        name: 'ATTACK', label: '어택',
        targets: [
          { device: 0, param: 'attack', from: 0, to: 0.85 },
          { device: 1, param: 'midDb',  from: 0, to: 3 },
          { device: 1, param: 'midHz',  from: 900, to: 3200 },
        ],
      },
      {
        name: 'WEIGHT', label: '무게',
        targets: [
          { device: 1, param: 'lowDb',      from: 0,  to: 4.5 },
          { device: 3, param: 'driveDb',    from: 0,  to: 8 },
          { device: 3, param: 'mix',        from: 0,  to: 0.4 },
        ],
      },
      {
        name: 'GLUE', label: '접착',
        targets: [
          { device: 2, param: 'thresholdDb', from: 0,  to: -20 },
          { device: 2, param: 'ratio',       from: 1,  to: 3 },
          { device: 2, param: 'makeupDb',    from: 0,  to: 4 },
        ],
      },
    ],
  },
];

export function rackBlueprints(): ReadonlyArray<{ id: string; name: string; description: string }> {
  return BLUEPRINTS.map((b) => ({ id: b.id, name: b.name, description: b.description }));
}

/** Build a working rack from a blueprint. */
export function buildRack(blueprintId: string): Rack | null {
  const blueprint = BLUEPRINTS.find((b) => b.id === blueprintId);
  if (!blueprint) return null;

  const graph = linearGraph(blueprint.devices.map((d) => ({
    pluginId: d.pluginId,
    label: d.label,
    params: defaultParams(d.pluginId),
  })));
  const deviceNodes = deviceOrder(graph);

  const macros: RackMacro[] = blueprint.macros.map((macro) => ({
    id: nextId('macro'),
    name: macro.name,
    label: macro.label,
    targets: macro.targets
      .map((t) => {
        const node = deviceNodes[t.device];
        return node ? { nodeId: node.id, param: t.param, from: t.from, to: t.to } : null;
      })
      .filter((t): t is RackMacroTarget => t !== null),
  }));

  return createRack(blueprint.name, graph, macros);
}

/** A rack node for a device graph, pointing at a rack in the track's table. */
export function rackNode(rack: Rack, col: number, row = 0) {
  return createNode({
    kind: 'rack',
    label: rack.name,
    rackId: rack.id,
    col,
    row,
  });
}

/** Sanity check used by the rack editor and the tests. */
export function validateRack(rack: Rack): string[] {
  const problems: string[] = [];
  for (const macro of rack.macros) {
    for (const target of macro.targets) {
      const node = findNode(rack.graph, target.nodeId);
      if (!node) {
        problems.push(`${macro.name}: 존재하지 않는 디바이스를 가리킵니다`);
        continue;
      }
      if (node.kind !== 'device') {
        problems.push(`${macro.name}: ${node.label} 은(는) 파라미터가 없습니다`);
      }
    }
  }
  return problems;
}
