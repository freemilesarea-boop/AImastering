// Device Chain engine — builds the WebAudio graph from a DeviceGraph.
//
// The mapping is one-to-one, which is the point of modelling the chain as a
// graph in the first place:
//
//   node          → a summing GainNode (its input) + a plugin instance
//   edge          → source.output → edge gain → target.input
//   fan-out       → several edges from one node; WebAudio splits natively
//   fan-in        → several edges into one node; WebAudio sums at the input
//   send node     → taps its input into a bus and does not continue
//   rack node     → the same builder, recursively, on the rack's own graph
//
// Nothing about parallel processing needs special handling: a parallel
// saturation branch is just two edges out of the EQ and two edges into the
// compressor.

import {
  deviceOrder, edgesTo, findNode, topoOrder,
  type DeviceGraph, type DeviceId, type DeviceNode,
} from '../model/device-graph.js';
import { resolveRack, type Rack } from '../model/racks.js';
import { findPlugin, type PluginInstance } from './plugins.js';

const dbToGain = (db: number): number => (db <= -144 ? 0 : Math.pow(10, db / 20));

export interface BuiltChain {
  /** Where the channel feeds the chain. */
  input: AudioNode;
  /** What the chain hands back to the channel. */
  output: AudioNode;
  /** Plugin instances by node id (rack children are prefixed `rackId/nodeId`). */
  instances: Map<string, PluginInstance>;
  /** Node input summing points, so params and levels can be updated live. */
  edgeGains: Map<string, GainNode>;
  sendGains: Map<DeviceId, GainNode>;
  dispose: () => void;
}

export interface ChainContext {
  ctx: BaseAudioContext;
  /** Resolve a bus id to its summing node (for send taps). */
  busFor: (busId: string) => AudioNode | undefined;
  racks: readonly Rack[];
}

/**
 * Build one graph.  `keyPrefix` namespaces the instance map so a rack's
 * devices do not collide with the channel's.
 */
function buildInto(
  chain: ChainContext,
  graph: DeviceGraph,
  built: BuiltChain,
  keyPrefix: string,
  paramsFor: (node: DeviceNode) => Record<string, number>,
): { input: AudioNode; output: AudioNode } | null {
  const { ctx } = chain;
  const inputs = new Map<DeviceId, GainNode>();
  const outputs = new Map<DeviceId, AudioNode>();
  const disposables: Array<() => void> = [];

  for (const node of topoOrder(graph)) {
    const nodeInput = ctx.createGain();
    inputs.set(node.id, nodeInput);

    switch (node.kind) {
      case 'input':
      case 'output':
        outputs.set(node.id, nodeInput);
        break;

      case 'send': {
        // A send does not continue downstream; it taps into a bus.
        const sendGain = ctx.createGain();
        sendGain.gain.value = dbToGain(node.sendLevelDb);
        nodeInput.connect(sendGain);
        const bus = node.busId ? chain.busFor(node.busId) : undefined;
        if (bus) sendGain.connect(bus);
        built.sendGains.set(node.id, sendGain);
        disposables.push(() => { try { sendGain.disconnect(); } catch { /* ignore */ } });
        break;
      }

      case 'rack': {
        const rack = chain.racks.find((r) => r.id === node.rackId);
        if (!rack) { outputs.set(node.id, nodeInput); break; }
        const resolved = resolveRack(rack);
        const inner = buildInto(
          chain, rack.graph, built, `${keyPrefix}${rack.id}/`,
          (innerNode) => resolved.get(innerNode.id) ?? innerNode.params,
        );
        if (!inner) { outputs.set(node.id, nodeInput); break; }
        nodeInput.connect(inner.input);
        outputs.set(node.id, inner.output);
        break;
      }

      case 'device':
      default: {
        const descriptor = node.pluginId ? findPlugin(node.pluginId) : undefined;
        if (!descriptor) { outputs.set(node.id, nodeInput); break; }
        const instance = descriptor.create(ctx, { ...paramsFor(node) });
        // Offline devices are visible in the chain but pass audio through
        // untouched; the render path applies them.
        instance.setBypass(node.bypass || descriptor.offline === true);
        nodeInput.connect(instance.input);
        outputs.set(node.id, instance.output);
        built.instances.set(`${keyPrefix}${node.id}`, instance);
        disposables.push(() => { try { instance.dispose(); } catch { /* ignore */ } });
        break;
      }
    }
  }

  for (const edge of graph.edges) {
    const source = outputs.get(edge.from);
    const target = inputs.get(edge.to);
    if (!source || !target) continue;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(edge.gainDb);
    source.connect(gain).connect(target);
    built.edgeGains.set(`${keyPrefix}${edge.id}`, gain);
    disposables.push(() => { try { gain.disconnect(); } catch { /* ignore */ } });
  }

  const graphInput = graph.nodes.find((n) => n.kind === 'input');
  const graphOutput = graph.nodes.find((n) => n.kind === 'output');
  if (!graphInput || !graphOutput) return null;

  const previousDispose = built.dispose;
  built.dispose = () => {
    for (const fn of disposables) fn();
    for (const gain of inputs.values()) { try { gain.disconnect(); } catch { /* ignore */ } }
    previousDispose();
  };

  return {
    input: inputs.get(graphInput.id) ?? ctx.createGain(),
    output: outputs.get(graphOutput.id) ?? ctx.createGain(),
  };
}

export function buildDeviceChain(chain: ChainContext, graph: DeviceGraph): BuiltChain | null {
  const built: BuiltChain = {
    input: chain.ctx.createGain(),
    output: chain.ctx.createGain(),
    instances: new Map(),
    edgeGains: new Map(),
    sendGains: new Map(),
    dispose: () => { /* filled in by buildInto */ },
  };
  const ends = buildInto(chain, graph, built, '', (node) => node.params);
  if (!ends) return null;
  built.input = ends.input;
  built.output = ends.output;
  return built;
}

/** Push current parameter values into a built chain without rebuilding it. */
export function applyChainParams(
  built: BuiltChain, graph: DeviceGraph, racks: readonly Rack[],
): void {
  for (const node of graph.nodes) {
    if (node.kind === 'device') {
      const instance = built.instances.get(node.id);
      if (!instance) continue;
      const descriptor = node.pluginId ? findPlugin(node.pluginId) : undefined;
      instance.setBypass(node.bypass || descriptor?.offline === true);
      for (const [id, value] of Object.entries(node.params)) instance.setParam(id, value);
    } else if (node.kind === 'send') {
      const gain = built.sendGains.get(node.id);
      if (gain) gain.gain.value = dbToGain(node.sendLevelDb);
    } else if (node.kind === 'rack') {
      const rack = racks.find((r) => r.id === node.rackId);
      if (!rack) continue;
      const resolved = resolveRack(rack);
      for (const inner of deviceOrder(rack.graph)) {
        const instance = built.instances.get(`${rack.id}/${inner.id}`);
        if (!instance) continue;
        const descriptor = inner.pluginId ? findPlugin(inner.pluginId) : undefined;
        instance.setBypass(inner.bypass || descriptor?.offline === true);
        for (const [id, value] of Object.entries(resolved.get(inner.id) ?? {})) {
          instance.setParam(id, value);
        }
      }
    }
  }
  for (const edge of graph.edges) {
    const gain = built.edgeGains.get(edge.id);
    if (gain) gain.gain.value = dbToGain(edge.gainDb);
  }
}

/**
 * Latency of the longest path through the chain, so delay compensation still
 * works when the plugins live in a graph instead of a list.
 */
export function chainLatency(
  graph: DeviceGraph, racks: readonly Rack[], sampleRate: number,
): number {
  const latencyOf = (node: DeviceNode): number => {
    if (node.bypass) return 0;
    if (node.kind === 'device' && node.pluginId) {
      const descriptor = findPlugin(node.pluginId);
      return descriptor && !descriptor.offline
        ? descriptor.latencyFor(node.params, sampleRate)
        : 0;
    }
    if (node.kind === 'rack') {
      const rack = racks.find((r) => r.id === node.rackId);
      if (!rack) return 0;
      return chainLatency(rack.graph, racks, sampleRate);
    }
    return 0;
  };

  const best = new Map<DeviceId, number>();
  for (const node of topoOrder(graph)) {
    const incoming = edgesTo(graph, node.id);
    const upstream = incoming.length === 0
      ? 0
      : Math.max(...incoming.map((e) => best.get(e.from) ?? 0));
    best.set(node.id, upstream + latencyOf(node));
  }
  const output = graph.nodes.find((n) => n.kind === 'output');
  return output ? (best.get(output.id) ?? 0) : Math.max(0, ...best.values());
}

/** Convenience for the UI: does this node exist and is it a real plugin? */
export function isProcessingNode(graph: DeviceGraph, id: DeviceId): boolean {
  const node = findNode(graph, id);
  return node?.kind === 'device' || node?.kind === 'rack';
}
