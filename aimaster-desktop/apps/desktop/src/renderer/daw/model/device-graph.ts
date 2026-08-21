// Device Chain — the signal path as a graph, not a list of slots.
//
// A linear insert list cannot express what engineers actually build:
//
//   INPUT
//     │
//     ▼
//   DENOISE
//     │
//     ▼
//   EQ ──────► PARALLEL SAT
//     │              │
//     ▼              │
//   COMP ◄───────────┘
//     │
//     ├────► REVERB SEND
//     │
//     ▼
//   LIMIT
//
// So the model IS a graph: nodes with edges, fan-out for parallel branches,
// fan-in for merges, and send nodes that tap the path without leaving it.
// WebAudio sums at an input and splits at an output natively, which means
// this graph maps onto the engine one-to-one — no hidden mixer maths.
//
// Everything here is pure; the engine builds nodes from it and the chain view
// draws it from the same data.

import { nextId } from './ids.js';

export type DeviceId = string;

export type DeviceKind =
  /** The channel's incoming signal — exactly one per graph. */
  | 'input'
  /** Where the graph leaves for the fader — exactly one per graph. */
  | 'output'
  /** A plugin. */
  | 'device'
  /** A nested chain with its own macros (see racks.ts). */
  | 'rack'
  /** Taps the path and feeds a bus; the signal continues downstream. */
  | 'send';

export interface DeviceNode {
  id: DeviceId;
  kind: DeviceKind;
  label: string;
  /** Plugin id for `device` nodes. */
  pluginId: string | null;
  params: Record<string, number>;
  bypass: boolean;
  /** Layout in the chain view: column = depth, row = parallel lane. */
  col: number;
  row: number;
  /** `send` nodes only. */
  busId: string | null;
  sendLevelDb: number;
  /** `rack` nodes only — id into the track's rack table. */
  rackId: string | null;
}

export interface DeviceEdge {
  id: string;
  from: DeviceId;
  to: DeviceId;
  /** Branch level, so a parallel path can be blended in rather than replaced. */
  gainDb: number;
}

export interface DeviceGraph {
  nodes: DeviceNode[];
  edges: DeviceEdge[];
}

export const INPUT_ID = 'dev-input';
export const OUTPUT_ID = 'dev-output';

// ── Construction ──────────────────────────────────────────────────────────────

export function createNode(over: Partial<DeviceNode> & { kind: DeviceKind }): DeviceNode {
  return {
    id: nextId('dev'),
    label: over.label ?? over.pluginId ?? over.kind,
    pluginId: null,
    params: {},
    bypass: false,
    col: 0,
    row: 0,
    busId: null,
    sendLevelDb: -12,
    rackId: null,
    ...over,
  };
}

export function createEdge(from: DeviceId, to: DeviceId, gainDb = 0): DeviceEdge {
  return { id: nextId('edge'), from, to, gainDb };
}

/** An empty chain: INPUT → OUTPUT. */
export function emptyGraph(): DeviceGraph {
  const input = createNode({ kind: 'input', id: INPUT_ID, label: 'INPUT', col: 0, row: 0 });
  const output = createNode({ kind: 'output', id: OUTPUT_ID, label: 'OUTPUT', col: 1, row: 0 });
  return { nodes: [input, output], edges: [createEdge(input.id, output.id)] };
}

/** A straight chain of plugins between INPUT and OUTPUT. */
export function linearGraph(
  devices: ReadonlyArray<{ pluginId: string; label?: string; params?: Record<string, number> }>,
): DeviceGraph {
  const input = createNode({ kind: 'input', id: INPUT_ID, label: 'INPUT', col: 0, row: 0 });
  const nodes: DeviceNode[] = [input];
  const edges: DeviceEdge[] = [];
  let previous = input;

  devices.forEach((device, index) => {
    const node = createNode({
      kind: 'device',
      pluginId: device.pluginId,
      label: device.label ?? device.pluginId.toUpperCase(),
      params: { ...(device.params ?? {}) },
      col: index + 1,
      row: 0,
    });
    nodes.push(node);
    edges.push(createEdge(previous.id, node.id));
    previous = node;
  });

  const output = createNode({
    kind: 'output', id: OUTPUT_ID, label: 'OUTPUT', col: devices.length + 1, row: 0,
  });
  nodes.push(output);
  edges.push(createEdge(previous.id, output.id));
  return { nodes, edges };
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export function findNode(graph: DeviceGraph, id: DeviceId): DeviceNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function inputNode(graph: DeviceGraph): DeviceNode | undefined {
  return graph.nodes.find((n) => n.kind === 'input');
}

export function outputNode(graph: DeviceGraph): DeviceNode | undefined {
  return graph.nodes.find((n) => n.kind === 'output');
}

export function edgesFrom(graph: DeviceGraph, id: DeviceId): DeviceEdge[] {
  return graph.edges.filter((e) => e.from === id);
}

export function edgesTo(graph: DeviceGraph, id: DeviceId): DeviceEdge[] {
  return graph.edges.filter((e) => e.to === id);
}

/** Nodes with more than one outgoing edge — the parallel split points. */
export function splitPoints(graph: DeviceGraph): DeviceNode[] {
  return graph.nodes.filter((n) => edgesFrom(graph, n.id).length > 1);
}

/** Nodes with more than one incoming edge — where branches come back together. */
export function mergePoints(graph: DeviceGraph): DeviceNode[] {
  return graph.nodes.filter((n) => edgesTo(graph, n.id).length > 1);
}

// ── Editing ───────────────────────────────────────────────────────────────────

export function addNode(graph: DeviceGraph, node: DeviceNode): DeviceGraph {
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function updateNode(
  graph: DeviceGraph, id: DeviceId, fn: (n: DeviceNode) => DeviceNode,
): DeviceGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.id !== id) return n;
    const next = fn(n);
    if (next !== n) changed = true;
    return next;
  });
  return changed ? { ...graph, nodes } : graph;
}

export function connect(graph: DeviceGraph, from: DeviceId, to: DeviceId, gainDb = 0): DeviceGraph {
  if (from === to) return graph;
  if (graph.edges.some((e) => e.from === from && e.to === to)) return graph;
  const candidate = { ...graph, edges: [...graph.edges, createEdge(from, to, gainDb)] };
  // A feedback loop inside a channel is a scream, not a feature.
  return hasCycle(candidate) ? graph : candidate;
}

export function disconnect(graph: DeviceGraph, edgeId: string): DeviceGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/**
 * Drop a device onto an existing connection: A→B becomes A→NEW→B.
 * This is what dragging a plugin onto a cable does.
 */
export function insertOnEdge(graph: DeviceGraph, edgeId: string, node: DeviceNode): DeviceGraph {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return graph;
  const source = findNode(graph, edge.from);
  const target = findNode(graph, edge.to);
  const placed = {
    ...node,
    col: source && target ? Math.max(source.col + 1, target.col) : node.col,
    row: source?.row ?? node.row,
  };
  const withNode = addNode({ ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) }, placed);
  return layout({
    ...withNode,
    edges: [
      ...withNode.edges,
      createEdge(edge.from, placed.id, 0),
      createEdge(placed.id, edge.to, edge.gainDb),
    ],
  });
}

/**
 * Remove a device and heal the path around it, so deleting the compressor
 * does not silence the channel.
 */
export function removeNode(graph: DeviceGraph, id: DeviceId): DeviceGraph {
  const node = findNode(graph, id);
  if (!node || node.kind === 'input' || node.kind === 'output') return graph;

  const incoming = edgesTo(graph, id);
  const outgoing = edgesFrom(graph, id);
  const healed: DeviceEdge[] = [];
  for (const into of incoming) {
    for (const out of outgoing) {
      if (into.from === out.to) continue;
      if (graph.edges.some((e) => e.from === into.from && e.to === out.to)) continue;
      if (healed.some((e) => e.from === into.from && e.to === out.to)) continue;
      healed.push(createEdge(into.from, out.to, out.gainDb));
    }
  }
  return layout({
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: [...graph.edges.filter((e) => e.from !== id && e.to !== id), ...healed],
  });
}

/**
 * Split a parallel branch off `fromId` that rejoins at `toId`.
 * The classic use is parallel saturation blended back into the compressor.
 */
export function addParallelBranch(
  graph: DeviceGraph, fromId: DeviceId, toId: DeviceId, node: DeviceNode, blendDb = -6,
): DeviceGraph {
  const source = findNode(graph, fromId);
  const target = findNode(graph, toId);
  if (!source || !target) return graph;
  const lane = Math.max(0, ...graph.nodes.map((n) => n.row)) + 1;
  const placed = { ...node, col: source.col + 1, row: lane };
  const withNode = addNode(graph, placed);
  return {
    ...withNode,
    edges: [
      ...withNode.edges,
      createEdge(fromId, placed.id, 0),
      createEdge(placed.id, toId, blendDb),
    ],
  };
}

/** Add a send tap after `afterId`; the main path is untouched. */
export function addSend(
  graph: DeviceGraph, afterId: DeviceId, busId: string, label = 'SEND', levelDb = -12,
): DeviceGraph {
  const source = findNode(graph, afterId);
  if (!source) return graph;
  const lane = Math.max(0, ...graph.nodes.map((n) => n.row)) + 1;
  const node = createNode({
    kind: 'send', label, busId, sendLevelDb: levelDb, col: source.col + 1, row: lane,
  });
  return { ...addNode(graph, node), edges: [...graph.edges, createEdge(afterId, node.id)] };
}

// ── Analysis ──────────────────────────────────────────────────────────────────

/** Depth-first cycle check. */
export function hasCycle(graph: DeviceGraph): boolean {
  const out = new Map<DeviceId, DeviceId[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) out.get(e.from)?.push(e.to);

  const state = new Map<DeviceId, 0 | 1 | 2>();
  const visit = (id: DeviceId): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}

/**
 * Processing order.  Kahn's algorithm, so a node is only built once every
 * source feeding it exists — which is exactly what the engine needs to wire
 * a merge correctly.
 */
export function topoOrder(graph: DeviceGraph): DeviceNode[] {
  const indegree = new Map<DeviceId, number>();
  for (const n of graph.nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);

  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
  const order: DeviceNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    order.push(node);
    for (const e of edgesFrom(graph, node.id)) {
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) {
        const next = findNode(graph, e.to);
        if (next) queue.push(next);
      }
    }
  }
  return order;
}

export interface GraphProblem {
  nodeId: DeviceId | null;
  message: string;
  severity: 'error' | 'warning';
}

/** What the chain view should warn about before the user hears a problem. */
export function validateGraph(graph: DeviceGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const input = inputNode(graph);
  const output = outputNode(graph);

  if (!input) problems.push({ nodeId: null, message: '입력 노드가 없습니다', severity: 'error' });
  if (!output) problems.push({ nodeId: null, message: '출력 노드가 없습니다', severity: 'error' });
  if (hasCycle(graph)) {
    problems.push({ nodeId: null, message: '피드백 루프가 있습니다', severity: 'error' });
    return problems;
  }

  if (input && output) {
    const reachable = reachableFrom(graph, input.id);
    if (!reachable.has(output.id)) {
      problems.push({ nodeId: null, message: '입력에서 출력까지 이어지지 않습니다 — 소리가 나지 않습니다', severity: 'error' });
    }
    for (const node of graph.nodes) {
      if (node.kind === 'input') continue;
      if (!reachable.has(node.id)) {
        problems.push({ nodeId: node.id, message: `${node.label}: 입력에서 도달할 수 없음`, severity: 'warning' });
        continue;
      }
      if (node.kind === 'send' || node.kind === 'output') continue;
      if (edgesFrom(graph, node.id).length === 0) {
        problems.push({ nodeId: node.id, message: `${node.label}: 출력으로 이어지지 않는 막다른 길`, severity: 'warning' });
      }
    }
  }
  return problems;
}

export function reachableFrom(graph: DeviceGraph, id: DeviceId): Set<DeviceId> {
  const seen = new Set<DeviceId>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const e of edgesFrom(graph, current)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return seen;
}

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * The chain's spine: from the input, always take the OLDEST cable out of each
 * node.  Branches are added after the path they hang off, so creation order
 * is exactly what "the main path" means to the person who built it — and it
 * is stable, unlike "the longest path", which a parallel branch would steal.
 */
export function mainPath(graph: DeviceGraph): DeviceId[] {
  const input = inputNode(graph);
  if (!input) return [];
  const path: DeviceId[] = [input.id];
  const seen = new Set<DeviceId>([input.id]);
  let current = input.id;

  for (;;) {
    const next = graph.edges.find((e) => e.from === current && !seen.has(e.to));
    if (!next) break;
    path.push(next.to);
    seen.add(next.to);
    current = next.to;
  }
  return path;
}

/**
 * Assign columns by depth from the input, so the chain reads left-to-right in
 * signal order, and rows so the spine stays on lane 0 with branches and sends
 * stacked beneath the node they hang off.
 */
export function layout(graph: DeviceGraph): DeviceGraph {
  if (hasCycle(graph)) return graph;
  const depth = new Map<DeviceId, number>();
  for (const node of topoOrder(graph)) {
    const incoming = edgesTo(graph, node.id);
    const col = incoming.length === 0
      ? 0
      : Math.max(...incoming.map((e) => (depth.get(e.from) ?? 0) + 1));
    depth.set(node.id, col);
  }

  const out = outputNode(graph);
  if (out) {
    // The output always sits at the far right, past everything else.
    const deepest = Math.max(0, ...[...depth.values()]);
    depth.set(out.id, Math.max(depth.get(out.id) ?? 0, deepest));
  }

  const spine = new Set(mainPath(graph));
  const rowByColumn = new Map<number, number>();
  const nodes = graph.nodes.map((node) => {
    const col = depth.get(node.id) ?? node.col;
    if (spine.has(node.id)) return { ...node, col, row: 0 };
    const used = rowByColumn.get(col) ?? 0;      // lane 0 belongs to the spine
    const row = used + 1;
    rowByColumn.set(col, row);
    return { ...node, col, row };
  });
  return { ...graph, nodes };
}

// ── Description ───────────────────────────────────────────────────────────────

/**
 * Render the graph as the ASCII diagram engineers actually draw.  Used in the
 * chain view's tooltip, in logs, and in the tests — a routing bug shows up as
 * a wrong picture, which is much easier to read than a node dump.
 */
export function describeFlow(graph: DeviceGraph): string {
  const spine = mainPath(graph);
  const onSpine = new Set(spine);
  const lines: string[] = [];

  const render = (id: DeviceId): void => {
    const node = findNode(graph, id);
    if (!node) return;
    const outgoing = edgesFrom(graph, id);
    const branches = outgoing.filter((e) => !onSpine.has(e.to));
    const main = outgoing.find((e) => onSpine.has(e.to));

    lines.push(node.label);
    for (const branch of branches) {
      const target = findNode(graph, branch.to);
      const rejoin = edgesFrom(graph, branch.to)[0];
      const rejoinLabel = rejoin ? findNode(graph, rejoin.to)?.label : undefined;
      lines.push(`  ├────► ${target?.label ?? branch.to}`
        + (rejoinLabel ? `  ──► ${rejoinLabel}` : ''));
    }
    if (main) lines.push('  │', '  ▼');
  };

  for (const id of spine) render(id);
  return lines.join('\n');
}

/** Devices in the order the signal meets them, ignoring the endpoints. */
export function deviceOrder(graph: DeviceGraph): DeviceNode[] {
  return topoOrder(graph).filter((n) => n.kind === 'device' || n.kind === 'rack');
}
