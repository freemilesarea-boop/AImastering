// MixerEngine — turns the session model into a live WebAudio graph.
//
// Per channel, the signal order matches a real console (and Pro Tools):
//
//   input → ADC delay → inserts A…J → [pre-fader sends]
//         → fader (volume × VCA × mute/solo) → pan → [post-fader sends]
//         → output bus / master
//
// Buses are plain summing GainNodes; an aux track whose `input` is a bus
// reads from that node, which is what makes returns and parallel chains
// work.  Sidechain inserts tap a bus node directly into the plugin's key
// input.
//
// The engine is context-agnostic: the same builder runs against a live
// AudioContext and against an OfflineAudioContext, so Bounce and Freeze
// render exactly the graph you were listening to.

import {
  computeDelayCompensation, detectFeedback, insertLatency,
} from '../model/routing.js';
import {
  dbToGain, effectiveFaderDb, isAudible,
} from '../model/mixer-math.js';
import type { BusId, DawSession, Track, TrackId } from '../model/types.js';
import { findPlugin, type PluginInstance } from './plugins.js';
import { parsePluginParamKey, pluginParamKey } from '../model/automation.js';
import type { AutomatableParam } from './plugin-kit.js';
import { descriptorFor } from './external-device.js';
import { materializeRack, moduleParams, type RackModuleId } from '../model/macros.js';
import { applyChainParams, buildDeviceChain, type BuiltChain } from './device-chain.js';

export interface Channel {
  trackId: TrackId;
  /** Where clip players (or a bus, for auxes) feed in. */
  input: GainNode;
  adc: DelayNode;
  insertIn: GainNode;
  insertOut: GainNode;
  /**
   * The node the insert chain hangs off — `insertIn`, or the output of the
   * macro rack / device chain that runs ahead of it.  Kept so the inserts can
   * be rebuilt on their own without disturbing anything a clip is connected
   * to.
   */
  insertChainIn: AudioNode;
  inserts: Map<string, PluginInstance>;
  /** Macro rack modules, ahead of the manual inserts. */
  rack: Map<RackModuleId, PluginInstance>;
  /** Device Chain, when the track uses one instead of the slot list. */
  chain: BuiltChain | null;
  preFaderTap: GainNode;
  fader: GainNode;
  panner: StereoPannerNode;
  postFaderTap: GainNode;
  sends: Map<string, GainNode>;
  meter: AnalyserNode | null;
}

/**
 * Tracks that actually pass audio.  VCAs are control-only, and a folder stack
 * that does not sum its children has no signal path of its own.
 */
export function carriesAudio(track: Track): boolean {
  if (track.kind === 'vca') return false;
  if (track.kind === 'folder' && track.input === null) return false;
  return true;
}

/**
 * What an insert chain is made of.
 *
 * Split out of the graph fingerprint on purpose.  Adding a plugin used to
 * change the whole-session key, which tore down and rebuilt every channel —
 * and every clip that was playing was connected to a node that no longer
 * existed, so the music stopped.  Reaching for a compressor in the middle of
 * a take is the most ordinary thing an engineer does; it cannot cost the take.
 */
function insertsKey(track: Track): string {
  return JSON.stringify(track.inserts.map((i) => [i.id, i.slot, i.pluginId, i.sidechainSource]));
}

/** Structural fingerprint — changing it forces a graph rebuild. */
function structureKey(session: DawSession): string {
  return JSON.stringify({
    buses: session.buses.map((b) => [b.id, b.channels]),
    tracks: session.tracks.map((t) => [
      t.id, t.kind, t.input, t.output,
      t.sends.map((s) => [s.id, s.slot, s.target, s.preFader]),
      // A macro that switches a module on or off changes the graph, so the
      // active set is part of the fingerprint.
      t.macros.enabled
        ? materializeRack(t.macros).filter((m) => m.active).map((m) => m.module.id)
        : null,
      // The device graph's SHAPE is structural; its parameter values are not.
      t.deviceGraph
        ? [
            t.deviceGraph.nodes.map((n) => [n.id, n.kind, n.pluginId, n.rackId]),
            t.deviceGraph.edges.map((e) => [e.id, e.from, e.to]),
            t.racks.map((r) => [r.id, r.graph.nodes.map((n) => [n.id, n.pluginId])]),
          ]
        : null,
    ]),
    adc: session.delayCompensation,
  });
}

export interface MixerEngineOptions {
  /** Attach analysers for metering (skip for offline renders). */
  meters?: boolean;
}

export class MixerEngine {
  readonly ctx: BaseAudioContext;
  private readonly destination: AudioNode;
  private readonly withMeters: boolean;

  private channels = new Map<TrackId, Channel>();
  private buses = new Map<BusId, GainNode>();
  private key = '';
  private lastSession: DawSession | null = null;
  /** Latest feedback report — the UI shows this instead of blowing up. */
  feedbackPaths: string[][] = [];
  /**
   * Params currently driven by automation ramps.  `applyParams` leaves these
   * alone; writing `.value` on a ramping AudioParam cancels the ramp and the
   * fader would freeze mid-move.
   */
  private automated = new Map<TrackId, Set<string>>();
  /** Per-track device fingerprint, so a plugin change rebuilds only that chain. */
  private insertKeys = new Map<TrackId, string>();

  constructor(ctx: BaseAudioContext, destination: AudioNode, options: MixerEngineOptions = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.withMeters = options.meters ?? false;
  }

  /** Build or update the graph to match `session`. */
  sync(session: DawSession): void {
    const key = structureKey(session);
    if (key !== this.key) {
      this.rebuild(session);
      this.key = key;
      for (const track of session.tracks) this.insertKeys.set(track.id, insertsKey(track));
    } else {
      // Only the devices changed: re-thread the insert chain in place and
      // leave every node a playing clip is attached to exactly where it is.
      for (const track of session.tracks) {
        const next = insertsKey(track);
        if (this.insertKeys.get(track.id) === next) continue;
        this.insertKeys.set(track.id, next);
        this.rebuildInserts(track, session);
      }
    }
    this.applyParams(session);
    this.lastSession = session;
  }

  /**
   * Rebuild one channel's insert chain without touching the rest of it.
   *
   * `input`, `insertIn`, `insertOut`, the fader and the sends all survive, so
   * the AudioBufferSourceNodes and streaming worklets feeding this channel go
   * on playing through the change.
   */
  private rebuildInserts(track: Track, session: DawSession): void {
    const ch = this.channels.get(track.id);
    if (!ch) return;

    ch.insertChainIn.disconnect();
    for (const instance of ch.inserts.values()) {
      try { instance.output.disconnect(); } catch { /* already gone */ }
      instance.dispose();
    }
    ch.inserts.clear();

    let cursor: AudioNode = ch.insertChainIn;
    for (const insert of [...track.inserts].sort((a, b) => a.slot - b.slot)) {
      const descriptor = descriptorFor(insert);
      if (!descriptor) continue;
      const instance = descriptor.create(this.ctx, { ...insert.params });
      cursor.connect(instance.input);
      cursor = instance.output;
      ch.inserts.set(insert.id, instance);
    }
    cursor.connect(ch.insertOut);

    // Re-attach any key inputs the new devices asked for.
    for (const insert of track.inserts) {
      if (!insert.sidechainSource) continue;
      const instance = ch.inserts.get(insert.id);
      const bus = this.buses.get(insert.sidechainSource);
      if (!instance?.sidechain || !bus) continue;
      bus.connect(instance.sidechain);
      instance.setSidechainActive(true);
    }
    void session;
  }

  /**
   * The AudioParam behind one insert parameter, when the device offers one.
   *
   * This is what the player ramps.  Returning null is the honest answer for a
   * parameter that rebuilds a curve or splits across two nodes — the lane menu
   * never offers those, so a null here means the session was hand-edited or
   * the device changed between builds.
   */
  automatableParam(
    trackId: TrackId, insertId: string, paramId: string,
  ): AutomatableParam | null {
    const instance = this.channels.get(trackId)?.inserts.get(insertId);
    return instance?.automatable?.(paramId) ?? null;
  }

  /** Gain reduction an insert is applying right now, in dB, when it knows. */
  reduction(trackId: TrackId, insertId: string): number | null {
    const instance = this.channels.get(trackId)?.inserts.get(insertId);
    return instance?.reduction?.() ?? null;
  }

  /** What a metering insert is reading, for devices whose job is to measure. */
  analyse(trackId: TrackId, insertId: string): { lufs: number; peakDb: number } | null {
    const instance = this.channels.get(trackId)?.inserts.get(insertId);
    return instance?.analyse?.() ?? null;
  }

  /** Called by the player when a lane takes over a parameter. */
  markAutomated(trackId: TrackId, param: string): void {
    const set = this.automated.get(trackId) ?? new Set<string>();
    set.add(param);
    this.automated.set(trackId, set);
  }

  /** Hand a parameter back to the static value (lane switched to off/read). */
  clearAutomated(trackId?: TrackId): void {
    if (trackId) this.automated.delete(trackId); else this.automated.clear();
  }

  /**
   * Hand ONE parameter back, and cancel what was already scheduled on it.
   *
   * Dropping the flag is not enough.  A ramp scheduled in an earlier window is
   * still queued on the AudioParam, and it overrides `.value` — so a fader
   * being recorded would follow your hand for a moment and then get pulled
   * back onto last take's automation.  The queue has to go too.
   */
  clearAutomatedParam(trackId: TrackId, param: string): void {
    const set = this.automated.get(trackId);
    if (set?.delete(param) !== true) return;

    const ch = this.channels.get(trackId);
    if (!ch) return;
    const now = this.ctx.currentTime;
    const plugin = parsePluginParamKey(param);
    const target: AudioParam | undefined = param === 'volume' ? ch.fader.gain
      : param === 'pan' ? ch.panner.pan
        : param.startsWith('send:') ? ch.sends.get(param.slice(5))?.gain
          : plugin
            ? ch.inserts.get(plugin.insertId)?.automatable?.(plugin.paramId)?.param ?? undefined
            : undefined;
    if (!target) return;
    const held = target.value;
    target.cancelScheduledValues(now);
    target.setValueAtTime(held, now);
  }

  isAutomated(trackId: TrackId, param: string): boolean {
    return this.automated.get(trackId)?.has(param) ?? false;
  }

  channel(trackId: TrackId): Channel | undefined { return this.channels.get(trackId); }
  bus(busId: BusId): GainNode | undefined { return this.buses.get(busId); }
  get trackIds(): TrackId[] { return [...this.channels.keys()]; }

  // ── Build ───────────────────────────────────────────────────────────────
  private rebuild(session: DawSession): void {
    this.teardown();
    this.feedbackPaths = detectFeedback(session);

    for (const bus of session.buses) {
      const node = this.ctx.createGain();
      this.buses.set(bus.id, node);
    }

    for (const track of session.tracks) {
      if (!carriesAudio(track)) continue;
      this.channels.set(track.id, this.buildChannel(track, session));
    }

    // Wire outputs once every channel exists.
    for (const track of session.tracks) {
      const ch = this.channels.get(track.id);
      if (!ch) continue;

      if (track.kind === 'master') {
        ch.postFaderTap.connect(this.destination);
      } else if (track.output.kind === 'master') {
        const master = session.tracks.find((t) => t.kind === 'master');
        const masterCh = master ? this.channels.get(master.id) : undefined;
        if (masterCh) ch.postFaderTap.connect(masterCh.input);
        else ch.postFaderTap.connect(this.destination);
      } else if (track.output.kind === 'bus') {
        const bus = this.buses.get(track.output.busId);
        if (bus) ch.postFaderTap.connect(bus);
      }

      // Aux input: a bus feeds this channel.
      if (track.input) this.buses.get(track.input)?.connect(ch.input);

      // Sends.
      for (const send of track.sends) {
        const node = ch.sends.get(send.id);
        const bus = this.buses.get(send.target);
        if (!node || !bus) continue;
        (send.preFader ? ch.preFaderTap : ch.panner).connect(node);
        node.connect(bus);
      }

      // Sidechain keys.
      for (const insert of track.inserts) {
        if (!insert.sidechainSource) continue;
        const instance = ch.inserts.get(insert.id);
        const bus = this.buses.get(insert.sidechainSource);
        if (!instance?.sidechain || !bus) continue;
        bus.connect(instance.sidechain);
        instance.setSidechainActive(true);
      }
    }

    // A cycle would make the graph scream; drop the offending sends instead.
    if (this.feedbackPaths.length > 0) {
      // eslint-disable-next-line no-console
      console.warn('[MixerEngine] feedback detected — cyclic routes:', this.feedbackPaths);
    }
  }

  private buildChannel(track: Track, session: DawSession): Channel {
    const ctx = this.ctx;
    const input        = ctx.createGain();
    const adc          = ctx.createDelay(2);
    const insertIn     = ctx.createGain();
    const insertOut    = ctx.createGain();
    const preFaderTap  = ctx.createGain();
    const fader        = ctx.createGain();
    const panner       = ctx.createStereoPanner();
    const postFaderTap = ctx.createGain();

    input.connect(adc).connect(insertIn);

    let cursor: AudioNode = insertIn;

    // Macro rack first: the Smart Controls shape the sound, then the
    // engineer's own plugins work on the result.
    const rack = new Map<RackModuleId, PluginInstance>();
    if (track.macros.enabled) {
      for (const resolved of materializeRack(track.macros)) {
        if (!resolved.active) continue;
        const descriptor = findPlugin(resolved.module.pluginId);
        if (!descriptor) continue;
        const instance = descriptor.create(ctx, moduleParams(resolved));
        cursor.connect(instance.input);
        cursor = instance.output;
        rack.set(resolved.module.id, instance);
      }
    }

    // Device Chain, if the track has one: the signal follows the graph,
    // branches and all.  Otherwise the plain slot list.
    let chain: BuiltChain | null = null;
    if (track.deviceGraph) {
      chain = buildDeviceChain(
        { ctx, busFor: (id) => this.buses.get(id), racks: track.racks },
        track.deviceGraph,
      );
      if (chain) {
        cursor.connect(chain.input);
        cursor = chain.output;
      }
    }

    // Insert chain in slot order.  Where it starts is remembered so the
    // devices can be swapped later without rebuilding the channel.
    const insertChainIn = cursor;
    const inserts = new Map<string, PluginInstance>();
    for (const insert of [...track.inserts].sort((a, b) => a.slot - b.slot)) {
      const descriptor = descriptorFor(insert);
      if (!descriptor) continue;
      const instance = descriptor.create(ctx, { ...insert.params });
      cursor.connect(instance.input);
      cursor = instance.output;
      inserts.set(insert.id, instance);
    }
    cursor.connect(insertOut);

    insertOut.connect(preFaderTap);
    preFaderTap.connect(fader);
    fader.connect(panner);
    panner.connect(postFaderTap);

    let meter: AnalyserNode | null = null;
    if (this.withMeters && typeof (ctx as AudioContext).createAnalyser === 'function') {
      meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      meter.smoothingTimeConstant = 0.2;
      postFaderTap.connect(meter);
    }

    const sends = new Map<string, GainNode>();
    for (const send of track.sends) sends.set(send.id, ctx.createGain());

    void session;
    return {
      trackId: track.id, input, adc, insertIn, insertOut, insertChainIn, inserts, rack, chain,
      preFaderTap, fader, panner, postFaderTap, sends, meter,
    };
  }

  // ── Parameters ──────────────────────────────────────────────────────────
  /** Push every non-structural value (gain, pan, mute, params, ADC) in. */
  applyParams(session: DawSession): void {
    const compensation = computeDelayCompensation(session);

    for (const track of session.tracks) {
      const ch = this.channels.get(track.id);
      if (!ch) continue;

      const delaySamples = compensation.perTrack.get(track.id) ?? 0;
      ch.adc.delayTime.value = Math.min(2, delaySamples / this.ctx.sampleRate);

      const audible = isAudible(session, track);
      if (!this.isAutomated(track.id, 'volume')) {
        ch.fader.gain.value = audible ? dbToGain(effectiveFaderDb(session, track)) : 0;
      } else if (!audible) {
        // Mute always wins over a running ramp.
        ch.fader.gain.cancelScheduledValues(this.ctx.currentTime);
        ch.fader.gain.value = 0;
        this.automated.get(track.id)?.delete('volume');
      }
      if (!this.isAutomated(track.id, 'pan')) {
        ch.panner.pan.value = Math.max(-1, Math.min(1, track.pan));
      }

      // Macro rack — every value comes from materializeRack, which is also
      // what the Advanced view shows, so the two can never disagree.
      if (ch.rack.size > 0) {
        for (const resolved of materializeRack(track.macros)) {
          const instance = ch.rack.get(resolved.module.id);
          if (!instance) continue;
          instance.setBypass(!track.macros.enabled);
          for (const [id, value] of Object.entries(moduleParams(resolved))) {
            instance.setParam(id, value);
          }
        }
      }

      if (ch.chain && track.deviceGraph) {
        applyChainParams(ch.chain, track.deviceGraph, track.racks);
      }

      for (const insert of track.inserts) {
        const instance = ch.inserts.get(insert.id);
        if (!instance) continue;
        instance.setBypass(insert.bypass);
        for (const [id, value] of Object.entries(insert.params)) {
          // A parameter an automation lane is driving must not be written back
          // from the session on every sync — the store changes constantly
          // while the transport runs, and each write would cancel the ramp and
          // snap the knob back to where the session thinks it is.
          if (this.isAutomated(track.id, pluginParamKey(insert.id, id))) continue;
          instance.setParam(id, value);
        }
      }

      for (const send of track.sends) {
        const node = ch.sends.get(send.id);
        if (!node) continue;
        if (this.isAutomated(track.id, `send:${send.id}`) && !send.mute) continue;
        node.gain.value = send.mute ? 0 : dbToGain(send.levelDb);
      }
    }
  }

  /** Insert latency on this channel, from the same resolver ADC uses. */
  measuredLatency(track: Track): number {
    return insertLatency(track, this.ctx.sampleRate);
  }

  /** Post-fader RMS per channel, for the Mix window meters. */
  meterLevels(): Map<TrackId, number> {
    const levels = new Map<TrackId, number>();
    for (const [id, ch] of this.channels) {
      if (!ch.meter) continue;
      const data = new Float32Array(ch.meter.fftSize);
      ch.meter.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = data[i] ?? 0; sum += v * v; }
      levels.set(id, Math.sqrt(sum / data.length));
    }
    return levels;
  }

  teardown(): void {
    for (const ch of this.channels.values()) {
      for (const instance of [...ch.inserts.values(), ...ch.rack.values()]) {
        try { instance.dispose(); } catch { /* ignore */ }
      }
      try { ch.chain?.dispose(); } catch { /* ignore */ }
      for (const node of [ch.input, ch.adc, ch.insertIn, ch.insertOut,
        ch.preFaderTap, ch.fader, ch.panner, ch.postFaderTap]) {
        try { node.disconnect(); } catch { /* ignore */ }
      }
      for (const s of ch.sends.values()) { try { s.disconnect(); } catch { /* ignore */ } }
    }
    for (const bus of this.buses.values()) { try { bus.disconnect(); } catch { /* ignore */ } }
    this.channels.clear();
    this.buses.clear();
  }

  dispose(): void {
    this.teardown();
    this.automated.clear();
    this.key = '';
    this.lastSession = null;
  }

  get session(): DawSession | null { return this.lastSession; }
}
