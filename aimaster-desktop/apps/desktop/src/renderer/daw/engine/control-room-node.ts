// control-room-node.ts — the monitor chain, between the mix and the speakers.
//
// The single most important thing about this file is WHERE IT IS NOT USED.
//
// `MixerEngine` takes its destination as a constructor argument.  The live
// runtime builds a control room and hands the mixer its input; the offline
// render hands the mixer the render destination directly.  So the monitor
// level cannot reach a bounce, a stem or a mastering file — not because
// something checks a flag, but because in that code path this object was
// never constructed.  A promise kept by the shape of the graph is a promise
// that survives somebody editing the render six months from now.
//
// The chain is native nodes only, same rule as everywhere else in this engine:
//
//   mix in → [mono fold] → level → ctx.destination
//
// The mono fold is a splitter and a merger rather than a `channelCount` trick,
// because summing has to be explicit: a stereo pair collapsed by the browser's
// own up/down-mix rules is not the same sum a console makes, and mono
// compatibility is exactly the thing you are checking.

import { monitorGain, type ControlRoomState } from '../model/control-room.js';

/** How fast the level follows the fader.  Long enough not to click. */
const RAMP_SEC = 0.02;

export class ControlRoomNode {
  readonly ctx: BaseAudioContext;
  /** Connect the mixer's master output here. */
  readonly input: GainNode;

  private level: GainNode;
  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  /** Halves the sum, so mono is not 6 dB louder than stereo. */
  private monoTrim: GainNode;
  private stereoPath: GainNode;
  private mono = false;
  private disposed = false;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.level = ctx.createGain();

    // Two parallel paths out of the input: one straight through, one folded.
    // Switching is a gain crossfade rather than a reconnect, because
    // disconnecting a live node mid-playback is a click.
    this.stereoPath = ctx.createGain();
    this.stereoPath.gain.value = 1;
    this.input.connect(this.stereoPath).connect(this.level);

    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.monoTrim = ctx.createGain();
    // L+R summed into both outputs, then halved.  Without the halving a
    // centred vocal jumps 6 dB the moment you press MONO, and every judgement
    // you make about the fold is about that jump instead.
    this.monoTrim.gain.value = 0;
    this.input.connect(this.splitter);
    this.splitter.connect(this.merger, 0, 0);
    this.splitter.connect(this.merger, 1, 0);
    this.splitter.connect(this.merger, 0, 1);
    this.splitter.connect(this.merger, 1, 1);
    this.merger.connect(this.monoTrim).connect(this.level);

    this.level.connect(destination);
  }

  /** Push the whole state onto the graph. */
  apply(state: ControlRoomState): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.level.gain.setTargetAtTime(monitorGain(state), now, RAMP_SEC);
    this.setMono(state.mono);
  }

  private setMono(on: boolean): void {
    if (on === this.mono) return;
    this.mono = on;
    const now = this.ctx.currentTime;
    // 0.5 rather than 1 for the sum — see the constructor.
    this.monoTrim.gain.setTargetAtTime(on ? 0.5 : 0, now, RAMP_SEC);
    this.stereoPath.gain.setTargetAtTime(on ? 0 : 1, now, RAMP_SEC);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const node of [this.input, this.stereoPath, this.splitter,
      this.merger, this.monoTrim, this.level]) {
      try { node.disconnect(); } catch { /* already gone */ }
    }
  }
}
