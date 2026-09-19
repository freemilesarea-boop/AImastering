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
  deviceOrder, edgesTo, topoOrder,
  type DeviceGraph, type DeviceId, type DeviceNode,
} from '../model/device-graph.js';
import { resolveRack, type Rack } from '../model/racks.js';
import { createInstance, descriptorLatency, findPlugin, type PluginInstance } from './plugins.js';

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
  /**
   * Delay lines that hold the branches of a fan-in level with each other.
   * Only edges into a node with more than one input have one — a chain that
   * never splits needs no alignment and gets no nodes.
   */
  edgeDelays: Map<string, DelayNode>;
  /** How long each of those lines is, since a `DelayNode` cannot be grown. */
  alignCapacitySec: number;
  /** Needed by `applyChainParams`, which has a graph but no context. */
  sampleRate: number;
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
  delays: ReadonlyMap<string, number>,
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
          delays,
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
        const instance = createInstance(descriptor, ctx, { ...paramsFor(node) });
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
    const key = `${keyPrefix}${edge.id}`;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(edge.gainDb);
    built.edgeGains.set(key, gain);
    disposables.push(() => { try { gain.disconnect(); } catch { /* ignore */ } });

    // A node with one input has nothing to be level with, so it gets no delay
    // line — which is every node in a chain that does not branch, and is why
    // this costs nothing until it is needed.
    if (edgesTo(graph, edge.to).length > 1) {
      const delay = ctx.createDelay(built.alignCapacitySec);
      delay.delayTime.value = alignSeconds(delays.get(key) ?? 0, built);
      built.edgeDelays.set(key, delay);
      disposables.push(() => { try { delay.disconnect(); } catch { /* ignore */ } });
      source.connect(gain).connect(delay).connect(target);
    } else {
      source.connect(gain).connect(target);
    }
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

/** A delay in samples as the seconds a `DelayNode` takes, within its line. */
function alignSeconds(samples: number, built: BuiltChain): number {
  const seconds = Math.max(0, samples) / built.sampleRate;
  return Math.min(built.alignCapacitySec, seconds);
}

export function buildDeviceChain(chain: ChainContext, graph: DeviceGraph): BuiltChain | null {
  const sampleRate = chain.ctx.sampleRate;
  const capacity = alignmentCapacity(graph, chain.racks, sampleRate);
  const built: BuiltChain = {
    input: chain.ctx.createGain(),
    output: chain.ctx.createGain(),
    instances: new Map(),
    edgeGains: new Map(),
    edgeDelays: new Map(),
    // `createDelay` rejects zero and the line has to hold at least one
    // sample for a graph whose capacity rounds away.
    alignCapacitySec: Math.max(1 / sampleRate, capacity / sampleRate),
    sampleRate,
    sendGains: new Map(),
    dispose: () => { /* filled in by buildInto */ },
  };
  const delays = alignmentDelays(graph, chain.racks, sampleRate);
  const ends = buildInto(chain, graph, built, '', (node) => node.params, delays);
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

  // A plugin's latency moves with its parameters — a look-ahead slider, the
  // linear-phase EQ's length menu, a bypass — and none of those rebuild the
  // chain.  So the alignment is recomputed here, on every sync, for the same
  // reason the parameters are.
  if (built.edgeDelays.size > 0) {
    for (const [key, samples] of alignmentDelays(graph, racks, built.sampleRate)) {
      const delay = built.edgeDelays.get(key);
      if (delay) delay.delayTime.value = alignSeconds(samples, built);
    }
  }
}

/**
 * What one node adds, and — for a rack — what its own graph adds inside it.
 *
 * `delays` is threaded through so that a rack's inner edges are aligned by the
 * same walk that measures it.  A BYPASSED rack still has its insides walked:
 * the builder wires a rack's graph up whether the rack node is bypassed or
 * not, so its edges exist and would otherwise keep whatever delay they were
 * built with.
 */
function nodeLatency(
  node: DeviceNode, racks: readonly Rack[], sampleRate: number,
  prefix: string, delays: Map<string, number> | null,
): number {
  if (node.kind === 'device') {
    // Bypass does NOT zero it: the device keeps delaying its dry path by what
    // it declares, so that switching it out compares processing rather than
    // timing.  See `descriptorLatency`.
    if (!node.pluginId) return 0;
    const descriptor = findPlugin(node.pluginId);
    return descriptor ? descriptorLatency(descriptor, node.params, sampleRate) : 0;
  }
  if (node.kind === 'rack') {
    const rack = racks.find((r) => r.id === node.rackId);
    if (!rack) return 0;
    const inner = walkLatency(rack.graph, racks, sampleRate, `${prefix}${rack.id}/`, delays);
    return inner;
  }
  return 0;
}

/**
 * One walk that answers both latency questions, because they are one question.
 *
 * `arrive[node]` is how late the signal leaving that node is.  A node with
 * several inputs waits for the latest of them, which is the longest path and
 * what the channel has to be compensated by — and the difference between that
 * and each individual input is exactly what that input has to be delayed by
 * so the sum lines up.  Computing them separately would let the two drift
 * apart, and they must never disagree: the first is what the rest of the
 * session is told, the second is what the audio actually does.
 */
function walkLatency(
  graph: DeviceGraph, racks: readonly Rack[], sampleRate: number,
  prefix: string, delays: Map<string, number> | null,
): number {
  const arrive = new Map<DeviceId, number>();
  for (const node of topoOrder(graph)) {
    const incoming = edgesTo(graph, node.id);
    const upstream = incoming.length === 0
      ? 0
      : Math.max(...incoming.map((e) => arrive.get(e.from) ?? 0));
    if (delays) {
      for (const edge of incoming) {
        delays.set(`${prefix}${edge.id}`, upstream - (arrive.get(edge.from) ?? 0));
      }
    }
    arrive.set(node.id, upstream + nodeLatency(node, racks, sampleRate, prefix, delays));
  }
  const output = graph.nodes.find((n) => n.kind === 'output');
  return output ? (arrive.get(output.id) ?? 0) : Math.max(0, ...arrive.values());
}

/**
 * Latency of the longest path through the chain, so delay compensation still
 * works when the plugins live in a graph instead of a list.
 */
export function chainLatency(
  graph: DeviceGraph, racks: readonly Rack[], sampleRate: number,
): number {
  return walkLatency(graph, racks, sampleRate, '', null);
}

/**
 * How far each edge has to be delayed for a fan-in to sum the same moment.
 *
 * The chain's latency is the longest path, which is the right number to tell
 * the session: it is what the mix bus waits for.  It says nothing about what
 * happens INSIDE the chain, and what happens inside is that a node with two
 * inputs sums them regardless of whether they are the same moment.  Put a
 * saturator on one branch of a parallel split and the branch beside it arrives
 * 192 samples early — which is not a small phase error, it is a comb filter
 * with its first null at 125 Hz, and it is exactly the sound people blame on
 * the saturator.
 *
 * Keyed the way `edgeGains` is keyed, so a rack's edges carry its prefix.
 *
 * The delay these numbers become is a `DelayNode`, whose `delayTime` is a
 * float32 — so k/48000 lands a ten-thousandth of a sample off an integer and
 * the line interpolates by that much.  Measured in both renderers: 1.8e-5 at
 * 192 samples, 9.9e-5 at the 2047 the linear-phase EQ asks for.  That is
 * −80 dBFS against the full-depth comb filter it replaces, and it is the same
 * line the channel's own compensation has always used.  `ableton-selftest`
 * pins it.
 */
export function alignmentDelays(
  graph: DeviceGraph, racks: readonly Rack[], sampleRate: number,
): Map<string, number> {
  const delays = new Map<string, number>();
  walkLatency(graph, racks, sampleRate, '', delays);
  return delays;
}

/**
 * The most latency this graph could ever ask an alignment delay to hold.
 *
 * A `DelayNode`'s line is allocated when it is made and clamps silently past
 * it, and a plugin's latency moves with its PARAMETERS — the linear-phase EQ
 * goes from 127 samples to 2047 on one menu — while the chain is only rebuilt
 * when its shape changes.  So the line cannot be sized on what the graph
 * needs right now.
 *
 * It is sized on what the graph could need: every device's latency probed at
 * both ends of every parameter it has, then the longest path through THAT.
 * No alignment delay can exceed the longest path, so this is a bound rather
 * than a guess, and it costs nothing at run time — `latencyFor` is arithmetic
 * on a parameter map.
 */
export function alignmentCapacity(
  graph: DeviceGraph, racks: readonly Rack[], sampleRate: number,
): number {
  const worst = (node: DeviceNode): number => {
    if (node.kind === 'rack') {
      const rack = racks.find((r) => r.id === node.rackId);
      return rack ? capacityOf(rack.graph) : 0;
    }
    if (node.kind !== 'device' || !node.pluginId) return 0;
    const descriptor = findPlugin(node.pluginId);
    if (!descriptor || descriptor.offline) return 0;
    // Bypass is deliberately ignored: a bypassed device can be switched back
    // on without the chain being rebuilt, and the line has to be there when
    // it is.
    let most = descriptor.latencyFor(node.params, sampleRate);
    const ends: Record<string, number> = {};
    for (const def of descriptor.params) {
      for (const at of [def.min, def.max]) {
        most = Math.max(most, descriptor.latencyFor(
          { ...node.params, [def.id]: at }, sampleRate,
        ));
      }
      ends[def.id] = def.max;
    }
    // And every parameter at once, for a latency that takes two of them.
    return Math.max(most, descriptor.latencyFor({ ...node.params, ...ends }, sampleRate));
  };
  const capacityOf = (g: DeviceGraph): number => {
    const arrive = new Map<DeviceId, number>();
    for (const node of topoOrder(g)) {
      const incoming = edgesTo(g, node.id);
      const upstream = incoming.length === 0
        ? 0
        : Math.max(...incoming.map((e) => arrive.get(e.from) ?? 0));
      arrive.set(node.id, upstream + worst(node));
    }
    return Math.max(0, ...arrive.values());
  };
  return capacityOf(graph);
}
