// Routing — the signal-flow graph, feedback detection and delay compensation.
//
// Three questions the rest of the app asks here:
//   1. Where does this channel's audio go?  (outputs + sends → buses → auxes)
//   2. Would this assignment feed back?      (a bus that loops to itself)
//   3. How much latency is on each path, and what delay does every other
//      path need so the mix stays phase-aligned?  (ADC)
//
// Pure graph maths over the session model — no audio nodes involved.

import type { BusId, DawSession, Insert, Track, TrackId } from './types.js';
import { findTrack } from './session-ops.js';
import { findPlugin } from '../engine/plugins.js';
import { materializeRack, moduleParams } from './macros.js';

// ── Graph ─────────────────────────────────────────────────────────────────────

export type RouteNodeId = string;    // `trk:<id>` | `bus:<id>` | 'master'

export const MASTER_NODE: RouteNodeId = 'master';
export const trackNode = (id: TrackId): RouteNodeId => `trk:${id}`;
export const busNode   = (id: BusId):   RouteNodeId => `bus:${id}`;

export interface RouteEdge {
  from: RouteNodeId;
  to: RouteNodeId;
  kind: 'output' | 'send' | 'input';
  /** Pre-fader sends bypass the channel fader. */
  preFader?: boolean;
}

export interface RouteGraph {
  nodes: RouteNodeId[];
  edges: RouteEdge[];
}

export function buildRouteGraph(session: DawSession): RouteGraph {
  const nodes = new Set<RouteNodeId>([MASTER_NODE]);
  const edges: RouteEdge[] = [];

  for (const bus of session.buses) nodes.add(busNode(bus.id));

  for (const track of session.tracks) {
    if (track.kind === 'vca') continue;               // VCAs carry no audio
    const self = trackNode(track.id);
    nodes.add(self);

    // Aux inputs read a bus.
    if (track.input) {
      nodes.add(busNode(track.input));
      edges.push({ from: busNode(track.input), to: self, kind: 'input' });
    }

    // Main output.
    if (track.kind !== 'master') {
      if (track.output.kind === 'bus') {
        nodes.add(busNode(track.output.busId));
        edges.push({ from: self, to: busNode(track.output.busId), kind: 'output' });
      } else if (track.output.kind === 'master') {
        edges.push({ from: self, to: MASTER_NODE, kind: 'output' });
      }
    }

    // Sends.
    for (const send of track.sends) {
      if (send.mute) continue;
      nodes.add(busNode(send.target));
      edges.push({ from: self, to: busNode(send.target), kind: 'send', preFader: send.preFader });
    }
  }

  return { nodes: [...nodes], edges };
}

/**
 * Every cycle in the routing graph, as node-id rings.  A non-empty result
 * means the engine must refuse the assignment — a feedback loop in a live
 * audio graph is a blown monitor, not a warning.
 */
export function detectFeedback(session: DawSession): RouteNodeId[][] {
  const graph = buildRouteGraph(session);
  const out = new Map<RouteNodeId, RouteNodeId[]>();
  for (const n of graph.nodes) out.set(n, []);
  for (const e of graph.edges) out.get(e.from)?.push(e.to);

  const cycles: RouteNodeId[][] = [];
  const state = new Map<RouteNodeId, 0 | 1 | 2>();   // 0 unseen, 1 on stack, 2 done
  const stack: RouteNodeId[] = [];

  const visit = (node: RouteNodeId): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) visit(next);
      else if (s === 1) {
        const from = stack.lastIndexOf(next);
        if (from !== -1) cycles.push([...stack.slice(from), next]);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const n of graph.nodes) if ((state.get(n) ?? 0) === 0) visit(n);
  return cycles;
}

/** Would routing `trackId` to `target` create a loop? */
export function wouldFeedback(
  session: DawSession, trackId: TrackId, target: BusId,
): boolean {
  const probe: DawSession = {
    ...session,
    tracks: session.tracks.map((t) =>
      t.id === trackId ? { ...t, output: { kind: 'bus' as const, busId: target } } : t),
  };
  return detectFeedback(probe).length > 0;
}

// ── Delay compensation ────────────────────────────────────────────────────────

/**
 * Latency one insert reports.
 *
 * The PLUGIN is the source of truth — a look-ahead limiter's latency follows
 * its look-ahead parameter, so moving that slider has to move the
 * compensation with it.  `Insert.latencySamples` is only a cached copy for
 * display and for sessions whose plugin this build does not have.
 */
export function insertLatencySamples(insert: Insert, sampleRate: number): number {
  if (insert.bypass) return 0;
  const descriptor = findPlugin(insert.pluginId);
  return descriptor ? descriptor.latencyFor(insert.params, sampleRate) : insert.latencySamples;
}

/**
 * Latency of a channel's whole processing chain: the macro rack plus the
 * manual inserts.  The rack contains a look-ahead limiter, so leaving it out
 * would misalign every channel that has LOUDNESS turned up.
 */
export function insertLatency(track: Track, sampleRate: number): number {
  const manual = track.inserts.reduce((sum, i) => sum + insertLatencySamples(i, sampleRate), 0);
  if (!track.macros.enabled) return manual;
  const rack = materializeRack(track.macros)
    .filter((m) => m.active)
    .reduce((sum, m) => {
      const descriptor = findPlugin(m.module.pluginId);
      return sum + (descriptor ? descriptor.latencyFor(moduleParams(m), sampleRate) : 0);
    }, 0);
  return manual + rack;
}

/**
 * Total latency from a channel to the master output, following its main
 * output through every aux that reads the destination bus.  Cycles are cut
 * (feedback is reported separately) and the longest branch wins, because
 * that is what the mix bus actually waits for.
 */
export function pathLatency(
  session: DawSession, trackId: TrackId, seen: Set<TrackId> = new Set(),
): number {
  const track = findTrack(session, trackId);
  if (!track || seen.has(trackId)) return 0;
  seen.add(trackId);

  const own = insertLatency(track, session.sampleRate);
  if (track.kind === 'master' || track.output.kind === 'none') return own;
  if (track.output.kind === 'master') {
    const master = session.tracks.find((t) => t.kind === 'master');
    return own + (master ? insertLatency(master, session.sampleRate) : 0);
  }

  // Output feeds a bus — every aux reading that bus continues the path.
  const busId = track.output.busId;
  let downstream = 0;
  for (const t of session.tracks) {
    if (t.input !== busId) continue;
    downstream = Math.max(downstream, pathLatency(session, t.id, new Set(seen)));
  }
  return own + downstream;
}

export interface DelayCompensation {
  /** Samples of delay to insert on each channel so all paths line up. */
  perTrack: Map<TrackId, number>;
  /** The longest path in the session — the engine's total added latency. */
  maxSamples: number;
}

/**
 * Automatic delay compensation.  Every channel is delayed by
 * (longest path − its own path) so a 2048-sample look-ahead limiter on the
 * drum bus does not shove the drums 43 ms late against the vocal.
 */
export function computeDelayCompensation(session: DawSession): DelayCompensation {
  const perTrack = new Map<TrackId, number>();
  if (!session.delayCompensation) {
    for (const t of session.tracks) perTrack.set(t.id, 0);
    return { perTrack, maxSamples: 0 };
  }

  const latencies = new Map<TrackId, number>();
  let max = 0;
  for (const t of session.tracks) {
    if (t.kind === 'vca') continue;
    const l = pathLatency(session, t.id);
    latencies.set(t.id, l);
    if (l > max) max = l;
  }
  for (const [id, l] of latencies) perTrack.set(id, Math.max(0, max - l));
  return { perTrack, maxSamples: max };
}

/** Human-readable signal path, for the routing readout in the Mix window. */
export function describePath(session: DawSession, trackId: TrackId): string {
  const parts: string[] = [];
  const seen = new Set<TrackId>();
  let current = findTrack(session, trackId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.push(current.name);
    if (current.kind === 'master' || current.output.kind === 'none') break;
    if (current.output.kind === 'master') {
      const master = session.tracks.find((t) => t.kind === 'master');
      if (master) parts.push(master.name);
      break;
    }
    const busId = current.output.busId;
    const bus = session.buses.find((b) => b.id === busId);
    parts.push(bus?.name ?? busId);
    current = session.tracks.find((t) => t.input === busId);
  }
  return parts.join(' → ');
}
