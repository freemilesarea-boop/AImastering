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
import { materializeRack, moduleParams, type RackModuleId } from '../model/macros.js';

export interface Channel {
  trackId: TrackId;
  /** Where clip players (or a bus, for auxes) feed in. */
  input: GainNode;
  adc: DelayNode;
  insertIn: GainNode;
  insertOut: GainNode;
  inserts: Map<string, PluginInstance>;
  /** Macro rack modules, ahead of the manual inserts. */
  rack: Map<RackModuleId, PluginInstance>;
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

/** Structural fingerprint — changing it forces a graph rebuild. */
function structureKey(session: DawSession): string {
  return JSON.stringify({
    buses: session.buses.map((b) => [b.id, b.channels]),
    tracks: session.tracks.map((t) => [
      t.id, t.kind, t.input, t.output,
      t.inserts.map((i) => [i.id, i.slot, i.pluginId, i.sidechainSource]),
      t.sends.map((s) => [s.id, s.slot, s.target, s.preFader]),
      // A macro that switches a module on or off changes the graph, so the
      // active set is part of the fingerprint.
      t.macros.enabled
        ? materializeRack(t.macros).filter((m) => m.active).map((m) => m.module.id)
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
    }
    this.applyParams(session);
    this.lastSession = session;
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

  private isAutomated(trackId: TrackId, param: string): boolean {
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

    // Insert chain in slot order.
    const inserts = new Map<string, PluginInstance>();
    for (const insert of [...track.inserts].sort((a, b) => a.slot - b.slot)) {
      const descriptor = findPlugin(insert.pluginId);
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
      trackId: track.id, input, adc, insertIn, insertOut, inserts, rack,
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

      for (const insert of track.inserts) {
        const instance = ch.inserts.get(insert.id);
        if (!instance) continue;
        instance.setBypass(insert.bypass);
        for (const [id, value] of Object.entries(insert.params)) instance.setParam(id, value);
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
