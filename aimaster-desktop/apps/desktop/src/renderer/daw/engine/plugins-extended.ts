// The rest of the rack: everything a mix and a master actually need.
//
// The core file holds the devices the DAW grew up with.  This one holds the
// ones an engineer expects to find when they sit down — a real parametric EQ,
// a gate, a multiband, a clipper, the modulation family, mid/side tools, and
// the metering-and-dither end of a master chain.
//
// Every one is native Web Audio.  That is not a stylistic preference: the live
// channel and the offline bounce are the same graph, so anything that cannot
// be built from filters, gains, delays, shapers and the dynamics node would
// make monitoring and rendering disagree.  Where that rule bites — modulation
// with a free-running LFO — the device says so rather than pretending.

import {
  BUTTERWORTH_Q, OVERSAMPLE_LATENCY_SAMPLES,
  absShaper, automatableFrom, dbToGain, makeShaper, smoother, tanhCurve, wetDry,
  withBypass, type PluginDescriptor,
} from './plugin-kit.js';

const p = (params: Record<string, number>, id: string, fallback: number): number => {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

// ── Building blocks ─────────────────────────────────────────────────────────
// ── Tape ────────────────────────────────────────────────────────────────────

/**
 * The three transport speeds, and everything that moves with them.
 *
 * Tape speed is not a tone control with three positions — it is the one
 * number the rest of the machine is derived from, because every effect here
 * is about WAVELENGTH on the tape and wavelength is speed over frequency.
 * Double the speed and the same physical feature on the head happens at twice
 * the frequency.
 *
 *   · HEAD BUMP.  The playback head does not see the tape as a point; the
 *     wrap around it is a physical length, and the frequency whose wavelength
 *     matches it comes back louder.  A fixed length means the bump frequency
 *     is proportional to speed — which is why 15 ips is the one people call
 *     fat and 30 ips is the one they call clean, and it is the same machine.
 *   · HIGH-FREQUENCY LOSS.  Short wavelengths lose to the head gap, to the
 *     spacing between tape and head, and to self-erasure through the depth of
 *     the coating.  Faster tape makes a given frequency a longer wavelength,
 *     so it survives.
 *   · HISS.  The noise is per unit of tape, so running more tape past the
 *     head per second buys signal without buying noise.  Six decibels a
 *     doubling, near enough.
 *   · PRE-EMPHASIS.  A recorder boosts the top going on and cuts it coming
 *     off.  Slower tape needs more of it, which is why slow tape distorts the
 *     top first — see `tapeStage`.
 *
 * The numbers are a family portrait rather than any one machine, and the
 * pre-emphasis is a simplification of the NAB/IEC/AES curves rather than an
 * implementation of one: those differ by speed AND by standard, and a knob
 * that said "which standard" would be three curves nobody can hear the
 * difference between without a test tape.
 */
export const TAPE_SPEEDS = [
  { ips: 7.5,  bumpHz: 35,  topHz: 9000,  hissDb: -70, preHz: 2000, preDb: 12 },
  { ips: 15,   bumpHz: 60,  topHz: 15000, hissDb: -76, preHz: 3200, preDb: 9 },
  { ips: 30,   bumpHz: 100, topHz: 21000, hissDb: -82, preHz: 4500, preDb: 6 },
] as const;

export const TAPE_SPEED_NAMES: readonly string[] = TAPE_SPEEDS.map((s) => `${s.ips} ips`);

/** What choosing each speed actually costs and buys, for the picker. */
export const TAPE_SPEED_NOTES: readonly string[] = [
  '느린 테이프 — 범프가 35 Hz 로 내려가 근음 아래에 무게만 얹고, 상단은 9 kHz 에서 끝납니다. 히스도 가장 큽니다',
  '가장 흔한 속도 — 범프 60 Hz 는 킥의 몸통과 베이스의 낮은 E 위에 앉습니다. 이 속도를 두껍다고 부르는 이유',
  '마스터링 속도 — 범프가 100 Hz 로 올라가 서브를 비켜 가고, 그 아래가 같이 빠지면서 바닥이 깨끗해집니다',
];

/**
 * The tape's transfer curve, for a bias setting.
 *
 * The drive is BAKED IN rather than applied by a gain in front, and that is
 * not a style choice — a `WaveShaper` maps its curve across an input of −1 to
 * +1 and CLAMPS outside it, so a gain in front of a fixed curve turns a soft
 * magnetic bend into a hard clipper for anything loud.  The guitar amp in
 * this file learned that the expensive way; this one inherits the lesson.
 *
 * Normalised to unit slope at the origin, so the bias knob changes the
 * CHARACTER and not the level of anything quiet.  It still changes the
 * ceiling — that is what bias does, and the machine's own answer is to re-set
 * the record level after moving it, which is what the Level knob is for.
 */
export function tapeCurve(kink: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = Math.max(0.05, kink);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / k;
  }
  return curve;
}

/**
 * The transport's own delay, which is there so the modulation has somewhere
 * to go: wow and flutter move the read point either side of it, and a delay
 * line cannot go negative.
 */
export const TAPE_BASE_SEC = 0.003;

/** Which speed a knob position means. */
export function tapeSpeedAt(value: number): typeof TAPE_SPEEDS[number] {
  const i = Math.max(0, Math.min(TAPE_SPEEDS.length - 1, Math.round(value)));
  return TAPE_SPEEDS[i] ?? TAPE_SPEEDS[1]!;
}

/**
 * Where the high end ends, for a speed and a bias setting.
 *
 * Bias is the ultrasonic current mixed with the signal to drag the tape's
 * transfer curve into its linear region.  Too little and the tape is working
 * in the kink at the bottom of its own magnetisation curve, which distorts;
 * too much and the bias itself starts erasing the shortest wavelengths as it
 * lays them down.  So the knob is a straight trade — clean and dull one way,
 * dirty and bright the other — and where you set it is taste.
 *
 * Stated plainly because the textbook picture is richer than this: under-bias
 * loses the top as well, below a point, so the real curve has a peak rather
 * than a slope.  This is monotone, which is the half of it that is a decision
 * the user makes.
 */
export function tapeTopHz(speed: typeof TAPE_SPEEDS[number], bias: number): number {
  const b = Math.max(0, Math.min(1, bias));
  return speed.topHz * Math.pow(2, (0.5 - b) * 1.4);
}

/** How hard the tape's own transfer curve is driven, for a bias setting. */
export function tapeKink(bias: number): number {
  const b = Math.max(0, Math.min(1, bias));
  return 0.35 + (1 - b) * 1.9;
}


/**
 * Split into mid and side, and put them back together.
 *
 * M = (L+R)/2, S = (L-R)/2, and the inverse — the matrix every stereo tool in
 * this file is built on.  Done with a splitter, gains and a merger because
 * that is exactly what the matrix is; there is no node that does it for you.
 */
interface MidSide {
  input: GainNode;
  mid: GainNode;
  side: GainNode;
  output: GainNode;
  /** Feed the processed mid and side back in. */
  midReturn: GainNode;
  sideReturn: GainNode;
}

function midSide(ctx: BaseAudioContext): MidSide {
  const input = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  const mid = ctx.createGain();
  const side = ctx.createGain();
  const half = ctx.createGain(); half.gain.value = 0.5;
  const halfNeg = ctx.createGain(); halfNeg.gain.value = -0.5;

  // mid = 0.5L + 0.5R
  const lToMid = ctx.createGain(); lToMid.gain.value = 0.5;
  const rToMid = ctx.createGain(); rToMid.gain.value = 0.5;
  splitter.connect(lToMid, 0); splitter.connect(rToMid, 1);
  lToMid.connect(mid); rToMid.connect(mid);

  // side = 0.5L - 0.5R
  const lToSide = ctx.createGain(); lToSide.gain.value = 0.5;
  const rToSide = ctx.createGain(); rToSide.gain.value = -0.5;
  splitter.connect(lToSide, 0); splitter.connect(rToSide, 1);
  lToSide.connect(side); rToSide.connect(side);

  // L = M + S, R = M - S
  const midReturn = ctx.createGain();
  const sideReturn = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const mToL = ctx.createGain();
  const sToL = ctx.createGain();
  const mToR = ctx.createGain();
  const sToR = ctx.createGain(); sToR.gain.value = -1;
  midReturn.connect(mToL); sideReturn.connect(sToL);
  midReturn.connect(mToR); sideReturn.connect(sToR);
  mToL.connect(merger, 0, 0); sToL.connect(merger, 0, 0);
  mToR.connect(merger, 0, 1); sToR.connect(merger, 0, 1);

  const output = ctx.createGain();
  merger.connect(output);
  void half; void halfNeg;
  return { input, mid, side, output, midReturn, sideReturn };
}

/** A free-running LFO on an AudioParam: oscillator through a depth gain. */
interface Lfo {
  osc: OscillatorNode;
  depth: GainNode;
  setRate: (hz: number) => void;
  setDepth: (value: number) => void;
}

function lfo(ctx: BaseAudioContext, rateHz: number, depth: number, type: OscillatorType = 'sine'): Lfo {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = rateHz;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  // Started at zero so an offline render always begins at the same phase.  In
  // a live context "zero" is when the context was created, not when the song
  // started, which is why these devices are marked free-running.
  osc.start(0);
  return {
    osc,
    depth: gain,
    setRate: (hz) => { osc.frequency.value = hz; },
    setDepth: (v) => { gain.gain.value = v; },
  };
}


/**
 * A rotor: one speaker going round, heard by two microphones.
 *
 * This is the whole of a rotary speaker and it is four things at once, which
 * is why a chorus does not sound like one:
 *
 *   · DOPPLER — the source moves towards the mic and away from it, so the
 *     pitch rises and falls.  A modulated delay is exactly that: the delay is
 *     the time of flight, and a changing time of flight IS a Doppler shift.
 *   · AMPLITUDE — a horn is directional, so it is loud when it points at you
 *     and quiet when it points away.
 *   · TWO MICROPHONES at an angle to each other.  Everything stereo about a
 *     Leslie comes from here, and from nothing else: the cabinet is mono.
 *     When the horn faces mic A it is facing away from mic B, so their
 *     modulations are out of step by the angle between them.
 *   · and they are the SAME modulation.  A device that put an LFO on a delay
 *     and a different LFO on a gain would be two effects; here one rotation
 *     drives both, which is why the loudest moment is also the moment the
 *     pitch is not changing.
 *
 * The two microphones are two oscillators at one frequency with a fixed phase
 * between them, built as `PeriodicWave`s: cos(θ) for the first and
 * cos(θ + φ) = cos φ·cos θ − sin φ·sin θ for the second.  Both are started at
 * time 0 and always given the same rate, so they can never drift apart.
 */
interface Rotor {
  input: GainNode;
  output: GainNode;
  setRate: (hz: number, rampSec: number, when: number) => void;
  setDoppler: (seconds: number) => void;
  setThrob: (depth: number) => void;
  setAngle: (radians: number) => void;
  /** The fixed part of the delay, which is this rotor's latency. */
  baseSec: number;
}

function rotor(
  ctx: BaseAudioContext,
  opts: { rateHz: number; dopplerSec: number; throb: number; angle: number },
): Rotor {
  // A Leslie cabinet is MONO — everything stereo about it is the two
  // microphones — so the input is summed rather than carried through.
  const input = ctx.createGain();
  input.channelCount = 1;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  // Enough fixed delay that the modulation can never drive it negative.
  const baseSec = 0.004;

  const phase = (radians: number): PeriodicWave => ctx.createPeriodicWave(
    Float32Array.from([0, Math.cos(radians)]),
    Float32Array.from([0, -Math.sin(radians)]),
    { disableNormalization: true },
  );

  const mics = [0, opts.angle].map((radians) => {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(phase(radians));
    osc.frequency.value = opts.rateHz;
    osc.start(0);

    const dopplerDepth = ctx.createGain();
    dopplerDepth.gain.value = opts.dopplerSec;
    const throbDepth = ctx.createGain();
    throbDepth.gain.value = opts.throb;
    osc.connect(dopplerDepth);
    osc.connect(throbDepth);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = baseSec;
    dopplerDepth.connect(delay.delayTime);

    const amp = ctx.createGain();
    amp.gain.value = 1;
    throbDepth.connect(amp.gain);

    input.connect(delay).connect(amp);
    return { osc, delay, amp, dopplerDepth, throbDepth, radians };
  });

  const merger = ctx.createChannelMerger(2);
  mics[0]?.amp.connect(merger, 0, 0);
  mics[1]?.amp.connect(merger, 0, 1);
  const output = ctx.createGain();
  merger.connect(output);

  return {
    input,
    output,
    baseSec,
    setRate: (hz, rampSec, when) => {
      for (const m of mics) {
        if (rampSec <= 0.001) { m.osc.frequency.setValueAtTime(hz, when); continue; }
        // A real rotor has mass: the horn takes a couple of seconds to come
        // up to speed and longer to coast down, and that RAMP is half of what
        // people recognise about the effect.  One time constant is a third of
        // the stated time, so the ramp is about 95% done when it says it is.
        m.osc.frequency.cancelScheduledValues(when);
        m.osc.frequency.setValueAtTime(m.osc.frequency.value, when);
        m.osc.frequency.setTargetAtTime(hz, when, rampSec / 3);
      }
    },
    setDoppler: (seconds) => { for (const m of mics) m.dopplerDepth.gain.value = seconds; },
    setThrob: (depth) => { for (const m of mics) m.throbDepth.gain.value = depth; },
    setAngle: (radians) => {
      // Only the second microphone moves; the first defines zero.
      const m = mics[1];
      if (m) m.osc.setPeriodicWave(phase(radians));
    },
  };
}

/** Soft clip: tanh-ish above the ceiling, straight through below it. */
export function clipCurve(ceiling: number, hardness: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = 1 + hardness * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const scaled = x / Math.max(1e-4, ceiling);
    const shaped = Math.tanh(scaled * k) / Math.tanh(k);
    curve[i] = shaped * ceiling;
  }
  return curve;
}

/**
 * Envelope -> gain for the noise gate: open above the threshold, closed below.
 *
 * Exported because the plugin window draws this curve.  A picture built from a
 * second copy of the maths is a picture that can disagree with the sound.
 */
export function gateGainCurve(thresholdDb: number, rangeDb: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const thr = dbToGain(thresholdDb);
  const floor = dbToGain(-Math.max(0, rangeDb));
  for (let i = 0; i < n; i++) {
    const level = Math.abs((i / (n - 1)) * 2 - 1);
    // Open above the threshold, closed below, with a short ramp across it so a
    // signal sitting on the threshold does not chatter.
    const ratio = thr > 0 ? level / thr : 1;
    const openness = Math.max(0, Math.min(1, (ratio - 0.5) / 0.5));
    curve[i] = floor + (1 - floor) * openness;
  }
  return curve;
}

/** Quantise to `bits`, the way a converter would. */
export function bitCurve(bits: number): Float32Array<ArrayBuffer> {
  const n = 8192;
  const curve = new Float32Array(n);
  const levels = Math.max(2, Math.pow(2, Math.max(1, bits)) / 2);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

/**
 * Asymmetric drive — even harmonics, the way a tube stage leans.
 *
 * A symmetric shaper only makes odd harmonics, which is why pure tanh sounds
 * like a fuzz pedal and not like a preamp.
 */
/**
 * How much `tubeCurve` multiplies a QUIET signal by.
 *
 * The curve is normalised so that ±1 maps to ±1, which is the right thing for
 * a shaper sitting in the signal path — but it means the slope at zero is `k`,
 * and `k` reaches 25.  A quiet signal comes out nearly seven times louder at
 * the default drive.  In a straight line that is a level to compensate; inside
 * a FEEDBACK LOOP it is a loop gain above one, and a loop gain above one is an
 * oscillator.
 *
 * Derived rather than measured: d/dx of (tanh((x+b)k) − tanh(bk)) / tanh(k)
 * at x = 0 is k·sech²(bk)/tanh(k).  The self-test checks it against the curve
 * the function actually builds, so the two cannot drift apart.
 */
export function tubeSmallSignalGain(drive: number, bias: number): number {
  const k = 1 + drive * 24;
  const sech2 = 1 / Math.cosh(bias * k) ** 2;
  return (k * sech2) / Math.max(1e-6, Math.tanh(k));
}

export function tubeCurve(drive: number, bias: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = 1 + drive * 24;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const b = x + bias;
    const shaped = Math.tanh(b * k) - Math.tanh(bias * k);
    curve[i] = shaped / Math.max(1e-6, Math.tanh(k));
  }
  return curve;
}

/** Deterministic noise, for dither — a seeded buffer, identical every render. */
function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed LCG: a bounce must be reproducible, and Math.random is not.
  let seed = 0x2545f491;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < length; i++) {
    // TPDF: the sum of two rectangular sources, which is what dither wants.
    data[i] = (next() + next()) - 1;
  }
  return buffer;
}

// ── The devices ─────────────────────────────────────────────────────────────

/**
 * A guitar amplifier's gain stage: a filter, a gain, a curve, a filter.
 *
 * The order matters and is the whole reason a cascade of these sounds like an
 * amplifier where one big waveshaper does not.
 *
 *   · the filter BEFORE decides what gets distorted.  A real preamp's
 *     coupling capacitors cut the bass going into each valve, which is why a
 *     high-gain amp stays tight instead of turning to mud — distorting the
 *     low end is what makes mud.
 *   · the filter AFTER decides what survives.  Each stage rolls off the
 *     fizz it just created, so the harmonics the next stage works on are the
 *     ones a valve would have passed.
 *
 * ── What a cascade does, and what it does not ──────────────────────────────
 *
 * Measured on this implementation, a 220 Hz tone at the same input: one stage
 * gives 25.9% harmonic content, three give 36.3%, and the low end tightens
 * because each stage's high-pass takes more of the fundamental away before
 * distorting — three stages take over 6 dB off an 80 Hz note that one leaves
 * alone.  That is the reason to build it this way and it is what the selftest
 * checks.
 *
 * What it does NOT do, which is the thing textbooks say and this measurement
 * does not support: it does not reduce intermodulation.  Two tones at 220 and
 * 330 Hz came out with an intermodulation-to-harmonic ratio of 2.79 through
 * one stage and 2.68 through three — no difference worth the words.  The
 * filters here sit at 6 to 9 kHz and the difference tones land near the
 * fundamentals, so there is nothing between the stages to remove them.  A
 * cascade that reduced intermodulation would need its filters where the
 * products are, and this one's are not.
 */
/**
 * A valve stage's transfer curve, with the DRIVE baked into it.
 *
 * This is the fix for a fault that made the whole preamp pointless, and it is
 * worth writing down because the code that had it looked correct.
 *
 * A `WaveShaper`'s curve is defined over an input of −1 to 1 and CLAMPS
 * outside it.  Putting the drive in front as a gain therefore does not drive
 * a soft curve harder — past unity it drives it off the end, and every sample
 * lands on the same two endpoint values.  A tanh with a gain in front is a
 * hard clipper, and a hard clipper is symmetric whatever bias it was built
 * with.  Measured: the preamp's second harmonic sat at −50.6 dB against a
 * third at −6.9, which is to say the asymmetry the bias exists to create was
 * not there at all.
 *
 * With `a` inside the curve, the saturation is spread across the whole domain
 * and stays soft at any setting.
 *
 * ── The bias is a DC offset, not a squared term ────────────────────────────
 *
 * It was `x + b·x²/2` first, and that is asymmetric in the algebra and not in
 * the sound: the term is proportional to x², so on a signal well below full
 * scale it is a few per cent of the signal and the tanh flattens it away.
 * A valve's asymmetry is not that.  It is the GRID BIAS — the operating point
 * sits off centre, so one half of the wave reaches the top of the curve
 * before the other half reaches the bottom — which is a DC offset INSIDE the
 * tanh and does not shrink as the signal does.
 *
 * Measured with the squared term: second harmonic at −58 dB against a third
 * at −8, which is to say no asymmetry at all.
 *
 * And a note on where to look for it: at maximum gain BOTH halves are past
 * saturation and the output is a square wave either way, so an amplifier at
 * full gain makes mostly odd harmonics however it is biased.  The even ones
 * live at moderate drive, where one half is clipping and the other is not.
 * That is true of the real thing and the selftest measures it there.
 */
function valveCurve(drive: number, bias: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const a = Math.max(0.05, drive);
  const centre = Math.tanh(bias);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(a * x + bias) - centre;
  }
  return curve;
}

/**
 * The slope of `valveCurve` at the origin, which the bias changes.
 *
 * d/dx tanh(ax + b) at x = 0 is a·sech²(b).  Dividing it out is what keeps a
 * stage at unity when it is not being driven, whatever bias it carries.
 */
function valveSlope(drive: number, bias: number): number {
  const t = Math.tanh(bias);
  return Math.max(0.05, drive) * (1 - t * t);
}

interface AmpStage {
  input: BiquadFilterNode;
  output: BiquadFilterNode;
  setDrive: (amount: number) => void;
}

function ampStage(
  ctx: BaseAudioContext,
  opts: { cutHz: number; tiltHz: number; drive: number; bias: number },
): AmpStage {
  const cut = ctx.createBiquadFilter();
  cut.type = 'highpass';
  cut.frequency.value = opts.cutHz;
  cut.Q.value = 0.7;

  const post = ctx.createGain();
  const tilt = ctx.createBiquadFilter();
  tilt.type = 'lowpass';
  tilt.frequency.value = opts.tiltHz;
  tilt.Q.value = 0.5;
  post.connect(tilt);

  // The shaper is REPLACED when the drive changes rather than re-curved: a
  // `WaveShaper`'s curve cannot be assigned twice under the renderer the
  // offline suite uses, and the drive lives inside the curve.
  let shape = makeShaper(ctx, valveCurve(opts.drive, opts.bias), '4x');
  cut.connect(shape).connect(post);

  const setDrive = (amount: number): void => {
    const a = Math.max(0.05, amount);
    const next = makeShaper(ctx, valveCurve(a, opts.bias), '4x');
    cut.connect(next).connect(post);
    try { cut.disconnect(shape); shape.disconnect(); } catch { /* not connected */ }
    shape = next;
    // The curve's slope at the origin is `a`, so dividing by its square root
    // leaves a small-signal gain of √a: unity at zero drive, and louder as
    // it is driven, which is what an amplifier does — just nothing like
    // proportionally.
    post.gain.value = 1 / (Math.sqrt(a) * (valveSlope(a, opts.bias) / a));
  };
  post.gain.value = 1 / (Math.sqrt(Math.max(0.05, opts.drive))
    * (valveSlope(opts.drive, opts.bias) / Math.max(0.05, opts.drive)));

  return { input: cut, output: tilt, setDrive };
}

/**
 * A speaker cabinet, as filters rather than as a convolution.
 *
 * What a guitar cabinet does to a signal, in order of how much it matters:
 *
 *   · it stops around 4 kHz, hard.  This is most of the sound — the fizz a
 *     distorted preamp makes lives above there and a cabinet simply does not
 *     reproduce it.  Every "amp sim sounds like a wasp in a tin" is a missing
 *     cabinet.
 *   · it stops around 80 Hz at the bottom, because a 12-inch speaker in a
 *     box that size cannot go lower.
 *   · it has a cone resonance near 100 Hz and a presence peak near 2.5 kHz,
 *     and a dip between them where the cone breaks up.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not an impulse response, and an impulse response would be better.  A
 * real cabinet's fine structure — the comb from the baffle, the exact
 * breakup, the room — is dozens of features this cannot have with six
 * filters.  What six filters DO get is the four things above, which is the
 * difference between usable and unusable; the rest is the difference between
 * usable and convincing.  Loading an IR is a separate device and is worth
 * building.
 */
interface Cabinet {
  input: BiquadFilterNode;
  output: AudioNode;
  setKind: (kind: number) => void;
  setMic: (position: number) => void;
}

const CAB_KINDS = [
  // size, low corner, top corner, cone resonance, presence peak
  { name: '1×12', lowHz: 95, topHz: 4600, coneHz: 115, presenceHz: 2600 },
  { name: '2×12', lowHz: 85, topHz: 4200, coneHz: 100, presenceHz: 2300 },
  { name: '4×12', lowHz: 75, topHz: 3800, coneHz: 88, presenceHz: 2000 },
] as const;

function cabinet(ctx: BaseAudioContext, kind: number, mic: number): Cabinet {
  const low = ctx.createBiquadFilter();
  low.type = 'highpass';
  low.Q.value = 0.8;
  const cone = ctx.createBiquadFilter();
  cone.type = 'peaking';
  cone.Q.value = 1.4;
  cone.gain.value = 4;
  const dip = ctx.createBiquadFilter();
  dip.type = 'peaking';
  dip.frequency.value = 800;
  dip.Q.value = 1.1;
  dip.gain.value = -4;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.Q.value = 1.6;
  // Two lowpasses, not one.  A single two-pole roll-off at 4 kHz still
  // passes plenty at 8; a cabinet does not.
  // Two lowpasses at nearly the SAME corner, which is four poles together.
  // Spread apart — the first version put the second an octave and a half up —
  // they only reached 12 dB down at 8 kHz against 1 kHz, where a real
  // cabinet is past 24.  That shortfall is the entire "amp sim sounds like a
  // wasp in a tin" complaint, so it is worth the extra pole.
  const topA = ctx.createBiquadFilter();
  topA.type = 'lowpass';
  topA.Q.value = 0.7;
  const topB = ctx.createBiquadFilter();
  topB.type = 'lowpass';
  topB.Q.value = 0.9;

  low.connect(cone).connect(dip).connect(presence).connect(topA).connect(topB);

  const apply = (k: number, m: number): void => {
    const spec = CAB_KINDS[Math.max(0, Math.min(CAB_KINDS.length - 1, Math.round(k)))]
      ?? CAB_KINDS[0];
    low.frequency.value = spec.lowHz;
    cone.frequency.value = spec.coneHz;
    presence.frequency.value = spec.presenceHz;
    // The microphone position, as the one thing it really is: how far off the
    // centre of the cone it sits.  On axis is bright and edgy; off axis rolls
    // the top off and is where most recorded guitars actually are.
    const off = Math.max(0, Math.min(1, m));
    presence.gain.value = 6 - off * 9;
    topA.frequency.value = spec.topHz * (1 - off * 0.35);
    topB.frequency.value = spec.topHz * 0.86 * (1 - off * 0.35);
  };
  apply(kind, mic);

  return {
    input: low,
    output: topB,
    setKind: (k) => apply(k, mic),
    setMic: (m) => { mic = m; apply(kind, m); },
  };
}

export const EXTENDED_PLUGINS: PluginDescriptor[] = [
  // ── EQ ────────────────────────────────────────────────────────────────────
  {
    id: 'eq8',
    name: 'Parametric EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'hpfHz',  name: 'HPF',      min: 20,  max: 1000,  default: 20,   unit: 'Hz' },
      { id: 'lowDb',  name: 'Low',      min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'lowHz',  name: 'Low Freq', min: 40,  max: 400,   default: 120,  unit: 'Hz' },
      { id: 'b1Db',   name: 'Band 1',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b1Hz',   name: 'B1 Freq',  min: 60,  max: 2000,  default: 300,  unit: 'Hz' },
      { id: 'b1Q',    name: 'B1 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'b2Db',   name: 'Band 2',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b2Hz',   name: 'B2 Freq',  min: 200, max: 8000,  default: 1200, unit: 'Hz' },
      { id: 'b2Q',    name: 'B2 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'b3Db',   name: 'Band 3',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b3Hz',   name: 'B3 Freq',  min: 800, max: 16000, default: 4000, unit: 'Hz' },
      { id: 'b3Q',    name: 'B3 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'highDb', name: 'High',     min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'highHz', name: 'High Freq', min: 2000, max: 16000, default: 8000, unit: 'Hz' },
      { id: 'lpfHz',  name: 'LPF',      min: 2000, max: 20000, default: 20000, unit: 'Hz' },
    ],
    // Every one of these is exactly one BiquadFilter AudioParam, so the whole
    // EQ automates — filter sweeps included.
    automatableParams: [
      'hpfHz', 'lowDb', 'lowHz', 'b1Db', 'b1Hz', 'b1Q', 'b2Db', 'b2Hz', 'b2Q',
      'b3Db', 'b3Hz', 'b3Q', 'highDb', 'highHz', 'lpfHz',
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass';
      hpf.frequency.value = p(params, 'hpfHz', 20);
      const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
      low.frequency.value = p(params, 'lowHz', 120); low.gain.value = p(params, 'lowDb', 0);

      const bells = [1, 2, 3].map((n) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = p(params, `b${n}Hz`, [300, 1200, 4000][n - 1]!);
        f.gain.value = p(params, `b${n}Db`, 0);
        f.Q.value = p(params, `b${n}Q`, 1);
        return f;
      });

      const high = ctx.createBiquadFilter(); high.type = 'highshelf';
      high.frequency.value = p(params, 'highHz', 8000); high.gain.value = p(params, 'highDb', 0);
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass';
      lpf.frequency.value = p(params, 'lpfHz', 20000);

      let cursor: AudioNode = input;
      for (const node of [hpf, low, ...bells, high, lpf]) {
        cursor.connect(node);
        cursor = node;
      }
      cursor.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'hpfHz')  hpf.frequency.value = v;
          if (id === 'lpfHz')  lpf.frequency.value = v;
          if (id === 'lowDb')  low.gain.value = v;
          if (id === 'lowHz')  low.frequency.value = v;
          if (id === 'highDb') high.gain.value = v;
          if (id === 'highHz') high.frequency.value = v;
          const bell = /^b([123])(Db|Hz|Q)$/.exec(id);
          if (bell) {
            const node = bells[Number(bell[1]) - 1];
            if (!node) return;
            if (bell[2] === 'Db') node.gain.value = v;
            if (bell[2] === 'Hz') node.frequency.value = v;
            if (bell[2] === 'Q')  node.Q.value = Math.max(0.05, v);
          }
        },
        automatable: automatableFrom({
          hpfHz: hpf.frequency, lpfHz: lpf.frequency,
          lowDb: low.gain, lowHz: low.frequency,
          highDb: high.gain, highHz: high.frequency,
          b1Db: bells[0]!.gain, b1Hz: bells[0]!.frequency, b1Q: bells[0]!.Q,
          b2Db: bells[1]!.gain, b2Hz: bells[1]!.frequency, b2Q: bells[1]!.Q,
          b3Db: bells[2]!.gain, b3Hz: bells[2]!.frequency, b3Q: bells[2]!.Q,
        }),
      };
    }),
  },

  {
    id: 'tilt',
    name: 'Tilt EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'tiltDb',  name: 'Tilt',  min: -12, max: 12,    default: 0,    unit: 'dB' },
      { id: 'pivotHz', name: 'Pivot', min: 200, max: 5000,  default: 1000, unit: 'Hz' },
    ],
    // One knob, two shelves: the tilt writes equal and opposite gains, and the
    // pivot retunes both. Half a tilt is a shelf, not a tilt.
    automatableParams: [],
    latencyFor: () => 0,
    // One knob that darkens or brightens a whole mix without asking which
    // band — the fastest useful move there is on a master.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const lowShelf = ctx.createBiquadFilter(); lowShelf.type = 'lowshelf';
      const highShelf = ctx.createBiquadFilter(); highShelf.type = 'highshelf';
      const apply = (tilt: number, pivot: number): void => {
        lowShelf.frequency.value = pivot;
        highShelf.frequency.value = pivot;
        lowShelf.gain.value = -tilt;    // tilt up = bright: cut low, boost high
        highShelf.gain.value = tilt;
      };
      apply(p(params, 'tiltDb', 0), p(params, 'pivotHz', 1000));
      input.connect(lowShelf).connect(highShelf).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'tiltDb')  params['tiltDb'] = v;
          if (id === 'pivotHz') params['pivotHz'] = v;
          apply(p(params, 'tiltDb', 0), p(params, 'pivotHz', 1000));
        },
      };
    }),
  },

  {
    id: 'mseq',
    name: 'Mid/Side EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'midLowDb',  name: 'M Low',  min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'midHighDb', name: 'M High', min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'sideLowDb', name: 'S Low',  min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'sideHighDb', name: 'S High', min: -12, max: 12, default: 0, unit: 'dB' },
    ],
    automatableParams: ['midLowDb', 'midHighDb', 'sideLowDb', 'sideHighDb'],
    latencyFor: () => 0,
    // Brighten the sides without brightening the vocal; tighten the centre
    // without narrowing the record.  The one EQ a master often needs.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const ms = midSide(ctx);
      input.connect(ms.input);

      const shelf = (type: 'lowshelf' | 'highshelf', db: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = type === 'lowshelf' ? 200 : 6000;
        f.gain.value = db;
        return f;
      };
      const midLow = shelf('lowshelf', p(params, 'midLowDb', 0));
      const midHigh = shelf('highshelf', p(params, 'midHighDb', 0));
      const sideLow = shelf('lowshelf', p(params, 'sideLowDb', 0));
      const sideHigh = shelf('highshelf', p(params, 'sideHighDb', 0));

      ms.mid.connect(midLow).connect(midHigh).connect(ms.midReturn);
      ms.side.connect(sideLow).connect(sideHigh).connect(ms.sideReturn);
      ms.output.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'midLowDb')   midLow.gain.value = v;
          if (id === 'midHighDb')  midHigh.gain.value = v;
          if (id === 'sideLowDb')  sideLow.gain.value = v;
          if (id === 'sideHighDb') sideHigh.gain.value = v;
        },
        automatable: automatableFrom({
          midLowDb: midLow.gain,
          midHighDb: midHigh.gain,
          sideLowDb: sideLow.gain,
          sideHighDb: sideHigh.gain,
        }),
      };
    }),
  },

  // ── Dynamics ──────────────────────────────────────────────────────────────
  {
    id: 'gate',
    name: 'Noise Gate',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'thresholdDb', name: 'Threshold', min: -80, max: 0,    default: -45, unit: 'dB' },
      { id: 'rangeDb',     name: 'Range',     min: 0,   max: 60,   default: 40,  unit: 'dB' },
      { id: 'attackMs',    name: 'Attack',    min: 1,   max: 100,  default: 5,   unit: 'ms' },
      { id: 'releaseMs',   name: 'Release',   min: 20,  max: 2000, default: 200, unit: 'ms' },
    ],
    // Threshold and range rebuild the gate's transfer curve; attack and release
    // are the detector's two biquads.
    automatableParams: [],
    latencyFor: () => 0,
    // Between the toms, under the amp, behind the room mic.  A gate is the
    // most-used dynamics device in a real multitrack and the DAW had none.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const vca = ctx.createGain();
      vca.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, p(params, 'attackMs', 5));

      let curve = makeShaper(ctx, gateGainCurve(
        p(params, 'thresholdDb', -45), p(params, 'rangeDb', 40),
      ));
      input.connect(rect).connect(env.input);
      env.output.connect(curve);
      curve.connect(vca.gain);
      input.connect(vca).connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'attackMs' || id === 'releaseMs') env.setTimeMs(v);
          if (id === 'thresholdDb' || id === 'rangeDb') {
            const next = makeShaper(ctx, gateGainCurve(
              p(params, 'thresholdDb', -45), p(params, 'rangeDb', 40),
            ));
            env.output.disconnect();
            curve.disconnect();
            curve = next;
            env.output.connect(curve);
            curve.connect(vca.gain);
          }
        },
        dispose: () => { curve.disconnect(); },
      };
    }),
  },

  {
    id: 'mbcomp',
    name: 'Multiband Compressor',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'lowXHz',   name: 'Low X',   min: 60,  max: 500,  default: 180,  unit: 'Hz' },
      { id: 'highXHz',  name: 'High X',  min: 1500, max: 8000, default: 3000, unit: 'Hz' },
      { id: 'lowThrDb', name: 'Low Thr', min: -48, max: 0,    default: -20, unit: 'dB' },
      { id: 'lowRatio', name: 'Low R',   min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'midThrDb', name: 'Mid Thr', min: -48, max: 0,    default: -20, unit: 'dB' },
      { id: 'midRatio', name: 'Mid R',   min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'hiThrDb',  name: 'High Thr', min: -48, max: 0,   default: -20, unit: 'dB' },
      { id: 'hiRatio',  name: 'High R',  min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'makeupDb', name: 'Makeup',  min: -12, max: 12,   default: 0,   unit: 'dB' },
    ],
    automatableParams: ['lowThrDb', 'lowRatio', 'midThrDb', 'midRatio', 'hiThrDb', 'hiRatio', 'makeupDb'],
    latencyFor: () => 0,
    // Control the bass without dulling the cymbals.  A single band across a
    // whole mix cannot do that, which is why every master chain has one.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const lowX = p(params, 'lowXHz', 180);
      const highX = p(params, 'highXHz', 3000);

      const band = (
        filters: BiquadFilterNode[], thresholdDb: number, ratio: number,
      ): { entry: AudioNode; comp: DynamicsCompressorNode } => {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = thresholdDb;
        comp.ratio.value = Math.max(1, ratio);
        comp.knee.value = 6;
        comp.attack.value = 0.01;
        comp.release.value = 0.15;
        let cursor: AudioNode = filters[0]!;
        for (let i = 1; i < filters.length; i++) { cursor.connect(filters[i]!); cursor = filters[i]!; }
        cursor.connect(comp);
        return { entry: filters[0]!, comp };
      };

      const lp = (hz: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; return f;
      };
      const hp = (hz: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; return f;
      };

      // Two poles per crossover edge so the bands do not bleed into each
      // other; a single pole leaves a band audibly present an octave away.
      const lowFilters = [lp(lowX), lp(lowX)];
      const midFilters = [hp(lowX), hp(lowX), lp(highX), lp(highX)];
      const highFilters = [hp(highX), hp(highX)];

      const low = band(lowFilters, p(params, 'lowThrDb', -20), p(params, 'lowRatio', 3));
      const mid = band(midFilters, p(params, 'midThrDb', -20), p(params, 'midRatio', 3));
      const high = band(highFilters, p(params, 'hiThrDb', -20), p(params, 'hiRatio', 3));

      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(p(params, 'makeupDb', 0));
      for (const b of [low, mid, high]) {
        input.connect(b.entry);
        b.comp.connect(makeup);
      }
      makeup.connect(output);

      const setCrossover = (): void => {
        const lx = p(params, 'lowXHz', 180);
        const hx = Math.max(lx * 2, p(params, 'highXHz', 3000));
        for (const f of lowFilters) f.frequency.value = lx;
        midFilters[0]!.frequency.value = lx; midFilters[1]!.frequency.value = lx;
        midFilters[2]!.frequency.value = hx; midFilters[3]!.frequency.value = hx;
        for (const f of highFilters) f.frequency.value = hx;
      };

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'lowXHz' || id === 'highXHz') setCrossover();
          if (id === 'lowThrDb') low.comp.threshold.value = v;
          if (id === 'lowRatio') low.comp.ratio.value = Math.max(1, v);
          if (id === 'midThrDb') mid.comp.threshold.value = v;
          if (id === 'midRatio') mid.comp.ratio.value = Math.max(1, v);
          if (id === 'hiThrDb')  high.comp.threshold.value = v;
          if (id === 'hiRatio')  high.comp.ratio.value = Math.max(1, v);
          if (id === 'makeupDb') makeup.gain.value = dbToGain(v);
        },
        // The crossover frequencies are not offered: each one retunes a
        // matched pair of filters, and moving half of a Linkwitz-Riley pair
        // is a hole in the response, not a sweep.
        automatable: automatableFrom({
          lowThrDb: low.comp.threshold,
          lowRatio: { param: low.comp.ratio, map: (v) => Math.max(1, v) },
          midThrDb: mid.comp.threshold,
          midRatio: { param: mid.comp.ratio, map: (v) => Math.max(1, v) },
          hiThrDb: high.comp.threshold,
          hiRatio: { param: high.comp.ratio, map: (v) => Math.max(1, v) },
          makeupDb: { param: makeup.gain, map: dbToGain },
        }),
        reduction: () => Math.min(low.comp.reduction, mid.comp.reduction, high.comp.reduction),
      };
    }),
  },

  {
    id: 'clipper',
    name: 'Soft Clipper',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'driveDb',   name: 'Drive',    min: 0,   max: 24, default: 0,  unit: 'dB' },
      { id: 'ceilingDb', name: 'Ceiling',  min: -12, max: 0,  default: -1, unit: 'dB' },
      { id: 'hardness',  name: 'Hardness', min: 0,   max: 1,  default: 0.5, unit: '' },
    ],
    automatableParams: ['driveDb'],
    latencyFor: () => 0,
    // Shaves the two dB of drum transient that would otherwise cost the whole
    // master three dB of limiting.  Instant, no detector, no pumping.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const drive = ctx.createGain();
      drive.gain.value = dbToGain(p(params, 'driveDb', 0));
      let shaper = makeShaper(
        ctx, clipCurve(dbToGain(p(params, 'ceilingDb', -1)), p(params, 'hardness', 0.5)),
      );
      // Oversampled: clipping generates harmonics above Nyquist, and without
      // this they fold back down as aliasing that sounds like grit low in the
      // spectrum where no grit belongs.
      shaper.oversample = '4x';

      // Oversampling costs something: the resampling filter rings, so the
      // output overshoots the curve by a dB or so.  A clipper whose ceiling is
      // a suggestion is not a clipper, so a hard, un-oversampled stage after
      // it makes the ceiling true.
      let guard = makeShaper(ctx, clipCurve(dbToGain(p(params, 'ceilingDb', -1)), 1));
      drive.connect(shaper);
      shaper.connect(guard);
      guard.connect(output);
      input.connect(drive);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'driveDb') { drive.gain.value = dbToGain(v); return; }
          // ceilingDb and hardness fall through to the curve rebuild below.
          const ceiling = dbToGain(p(params, 'ceilingDb', -1));
          const next = makeShaper(ctx, clipCurve(ceiling, p(params, 'hardness', 0.5)));
          next.oversample = '4x';
          const nextGuard = makeShaper(ctx, clipCurve(ceiling, 1));
          drive.disconnect();
          shaper.disconnect();
          guard.disconnect();
          shaper = next;
          guard = nextGuard;
          drive.connect(shaper);
          shaper.connect(guard);
          guard.connect(output);
        },
        automatable: automatableFrom({ driveDb: { param: drive.gain, map: dbToGain } }),
        dispose: () => { shaper.disconnect(); guard.disconnect(); },
      };
    }),
  },

  // ── Saturation and character ──────────────────────────────────────────────
  {
    id: 'tube',
    name: 'Tube Drive',
    category: 'saturation',
    hasSidechain: false,
    params: [
      { id: 'drive',   name: 'Drive',  min: 0,   max: 1,  default: 0.3, unit: '' },
      { id: 'bias',    name: 'Bias',   min: 0,   max: 0.5, default: 0.15, unit: '' },
      { id: 'toneHz',  name: 'Tone',   min: 1000, max: 16000, default: 8000, unit: 'Hz' },
      { id: 'mix',     name: 'Mix',    min: 0,   max: 100, default: 100, unit: '%' },
      { id: 'outDb',   name: 'Output', min: -24, max: 12, default: 0,  unit: 'dB' },
    ],
    automatableParams: ['toneHz', 'mix', 'outDb'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Asymmetric on purpose: a symmetric curve makes only odd harmonics and
      // sounds like a fuzz pedal.  The bias is what makes it a preamp.
      let shaper = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.3), p(params, 'bias', 0.15)));
      shaper.oversample = '4x';
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      tone.frequency.value = p(params, 'toneHz', 8000);
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const out = ctx.createGain();
      out.gain.value = dbToGain(p(params, 'outDb', 0));

      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 100));

      input.connect(shaper);
      shaper.connect(tone).connect(wet).connect(out);
      input.connect(dry).connect(out);
      out.connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'toneHz') tone.frequency.value = v;
          if (id === 'mix')    setMix(v);
          if (id === 'outDb')  out.gain.value = dbToGain(v);
          if (id === 'drive' || id === 'bias') {
            const next = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.3), p(params, 'bias', 0.15)));
            next.oversample = '4x';
            input.disconnect(shaper);
            shaper.disconnect();
            shaper = next;
            input.connect(shaper);
            shaper.connect(tone);
          }
        },
        // `drive` and `bias` rebuild the tube curve together, so neither is
        // a parameter a lane can ride.
        automatable: automatableFrom({
          toneHz: tone.frequency,
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
          outDb: { param: out.gain, map: dbToGain },
        }),
        dispose: () => { blend.dispose(); shaper.disconnect(); },
      };
    }),
  },

  {
    id: 'bitcrush',
    name: 'Bit Crusher',
    category: 'saturation',
    hasSidechain: false,
    params: [
      { id: 'bits', name: 'Bits', min: 2,  max: 16,  default: 8,  unit: '' },
      { id: 'mix',  name: 'Mix',  min: 0,  max: 100, default: 100, unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      let shaper = makeShaper(ctx, bitCurve(p(params, 'bits', 8)));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 100));
      input.connect(shaper).connect(wet).connect(output);
      input.connect(dry).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'mix') { setMix(v); return; }
          if (id !== 'bits') return;
          const next = makeShaper(ctx, bitCurve(v));
          input.disconnect(shaper);
          shaper.disconnect();
          shaper = next;
          input.connect(shaper).connect(wet);
        },
        // `bits` rebuilds the quantising curve — there is no parameter to ramp.
        automatable: automatableFrom({
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); shaper.disconnect(); },
      };
    }),
  },

  // ── Modulation ────────────────────────────────────────────────────────────
  // Every device below runs a free-running LFO.  Its phase is tied to when the
  // audio context was created, not to the song position, so a bounce will not
  // land on the same phase as what you were monitoring.  That is true of
  // unsynced modulation in every DAW; it is flagged here rather than quietly
  // being a difference between what you approved and what you exported.
  {
    id: 'chorus',
    name: 'Chorus',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',  name: 'Rate',  min: 0.05, max: 8,   default: 0.6, unit: 'Hz' },
      { id: 'depthMs', name: 'Depth', min: 0.5,  max: 12,  default: 4,   unit: 'ms' },
      { id: 'delayMs', name: 'Delay', min: 5,    max: 40,  default: 18,  unit: 'ms' },
      { id: 'mix',     name: 'Mix',   min: 0,    max: 100, default: 40,  unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Two voices in opposite phase: one alone is a vibrato, two are a
      // chorus, and putting them on opposite sides is what makes it wide.
      // `drySlope: 0.5` keeps this device's own blend law: a fully wet
      // chorus still carries half the original, or the body drops out.
      const blend = wetDry(ctx, 0, { drySlope: 0.5 });
      const wet = blend.wet;
      const dry = blend.dry;
      const voices = [0, 1].map((i) => {
        const delay = ctx.createDelay(0.2);
        delay.delayTime.value = p(params, 'delayMs', 18) / 1000;
        const mod = lfo(ctx, p(params, 'rateHz', 0.6), p(params, 'depthMs', 4) / 1000);
        if (i === 1) mod.osc.type = 'triangle';
        mod.depth.connect(delay.delayTime);
        const pan = ctx.createStereoPanner();
        pan.pan.value = i === 0 ? -0.7 : 0.7;
        input.connect(delay).connect(pan).connect(wet);
        return { delay, mod };
      });

      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 40));
      wet.connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'mix') setMix(v);
          for (const [i, voice] of voices.entries()) {
            if (id === 'rateHz')  voice.mod.setRate(v * (i === 1 ? 1.17 : 1));
            if (id === 'depthMs') voice.mod.setDepth(v / 1000);
            if (id === 'delayMs') voice.delay.delayTime.value = v / 1000;
          }
        },
        // Rate, depth and delay each move BOTH voices — and the second voice
        // runs at 1.17× the rate, so there is no single parameter behind any
        // of them.  That detune is what makes it a chorus rather than two
        // flangers, so it is not worth collapsing to win a lane.
        automatable: automatableFrom({
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); for (const v of voices) v.mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'flanger',
    name: 'Flanger',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',   name: 'Rate',     min: 0.05, max: 5,   default: 0.3, unit: 'Hz' },
      { id: 'depthMs',  name: 'Depth',    min: 0.1,  max: 5,   default: 2,   unit: 'ms' },
      { id: 'delayMs',  name: 'Delay',    min: 0.5,  max: 10,  default: 3,   unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,    max: 0.95, default: 0.5, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,    max: 100, default: 50,  unit: '%' },
    ],
    automatableParams: ['rateHz', 'depthMs', 'delayMs', 'feedback', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = p(params, 'delayMs', 3) / 1000;
      const mod = lfo(ctx, p(params, 'rateHz', 0.3), p(params, 'depthMs', 2) / 1000);
      mod.depth.connect(delay.delayTime);

      // Feedback is what turns a comb filter into a jet; it is clamped below
      // unity because at 1.0 it is not an effect, it is an oscillator.
      const feedback = ctx.createGain();
      feedback.gain.value = Math.min(0.95, p(params, 'feedback', 0.5));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 50));

      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'rateHz')   mod.setRate(v);
          if (id === 'depthMs')  mod.setDepth(v / 1000);
          if (id === 'delayMs')  delay.delayTime.value = v / 1000;
          if (id === 'feedback') feedback.gain.value = Math.min(0.95, v);
          if (id === 'mix')      setMix(v);
        },
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          depthMs: { param: mod.depth.gain, map: (v) => v / 1000 },
          delayMs: { param: delay.delayTime, map: (v) => v / 1000 },
          feedback: { param: feedback.gain, map: (v) => Math.min(0.95, v) },
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'phaser',
    name: 'Phaser',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',   name: 'Rate',     min: 0.05, max: 8,    default: 0.4, unit: 'Hz' },
      { id: 'depth',    name: 'Depth',    min: 0,    max: 1,    default: 0.7, unit: '' },
      { id: 'centreHz', name: 'Centre',   min: 200,  max: 4000, default: 900, unit: 'Hz' },
      { id: 'feedback', name: 'Feedback', min: 0,    max: 0.9,  default: 0.4, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,    max: 100,  default: 50,  unit: '%' },
    ],
    automatableParams: ['rateHz', 'feedback', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Four allpass stages: they leave the magnitude alone and rotate phase,
      // so the notches appear only where the wet meets the dry.  That is what
      // separates a phaser from a flanger.
      const stages = [0, 1, 2, 3].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'allpass';
        f.frequency.value = p(params, 'centreHz', 900);
        f.Q.value = 0.7;
        return f;
      });
      const mod = lfo(ctx, p(params, 'rateHz', 0.4), p(params, 'centreHz', 900) * p(params, 'depth', 0.7));
      for (const stage of stages) mod.depth.connect(stage.frequency);

      const feedback = ctx.createGain();
      feedback.gain.value = Math.min(0.9, p(params, 'feedback', 0.4));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 50));

      let cursor: AudioNode = input;
      for (const stage of stages) { cursor.connect(stage); cursor = stage; }

      // One sample of delay inside the feedback loop.
      //
      // Web Audio mutes any cycle that does not contain a DelayNode, and
      // without this the ENTIRE allpass chain renders silence — the device
      // was audible only as the dry path being turned down.  A single sample
      // is the shortest legal loop and is inaudible as a delay; what it does
      // is make the resonance exist at all.
      const loopDelay = ctx.createDelay(0.05);
      loopDelay.delayTime.value = 1 / ctx.sampleRate;
      cursor.connect(loopDelay).connect(feedback).connect(stages[0]!);

      cursor.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'rateHz')   mod.setRate(v);
          if (id === 'feedback') feedback.gain.value = Math.min(0.9, v);
          if (id === 'mix')      setMix(v);
          if (id === 'centreHz' || id === 'depth') {
            const centre = p(params, 'centreHz', 900);
            for (const stage of stages) stage.frequency.value = centre;
            mod.setDepth(centre * p(params, 'depth', 0.7));
          }
        },
        // `centreHz` retunes every all-pass stage and `depth` is scaled BY it,
        // so the two are one control in two knobs — neither is offered.
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          feedback: { param: feedback.gain, map: (v) => Math.min(0.9, v) },
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'tremolo',
    name: 'Tremolo',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz', name: 'Rate',  min: 0.1, max: 20,  default: 5,  unit: 'Hz' },
      { id: 'depth',  name: 'Depth', min: 0,   max: 1,   default: 0.5, unit: '' },
      { id: 'shape',  name: 'Shape', min: 0,   max: 1,   default: 0,  unit: '' },
    ],
    automatableParams: ['rateHz'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const vca = ctx.createGain();
      const depth = p(params, 'depth', 0.5);
      // Centre the modulation so full depth reaches silence and no depth is
      // unity — a tremolo that changes the average level is a volume knob.
      vca.gain.value = 1 - depth / 2;
      const mod = lfo(ctx, p(params, 'rateHz', 5), depth / 2);
      mod.depth.connect(vca.gain);
      input.connect(vca).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'rateHz') mod.setRate(v);
          if (id === 'depth')  { vca.gain.value = 1 - v / 2; mod.setDepth(v / 2); }
          if (id === 'shape')  mod.osc.type = v >= 0.5 ? 'square' : 'sine';
        },
        // `depth` sets the LFO's swing AND re-centres the VCA around it, so
        // the two have to move together; `shape` swaps a waveform, which is
        // not a ramp at all.
        automatable: automatableFrom({ rateHz: mod.osc.frequency }),
        dispose: () => { mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'autopan',
    name: 'Auto Pan',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz', name: 'Rate',  min: 0.05, max: 10, default: 0.5, unit: 'Hz' },
      { id: 'depth',  name: 'Depth', min: 0,    max: 1,  default: 0.7, unit: '' },
    ],
    automatableParams: ['rateHz', 'depth'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      const mod = lfo(ctx, p(params, 'rateHz', 0.5), p(params, 'depth', 0.7));
      mod.depth.connect(panner.pan);
      input.connect(panner).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'rateHz') mod.setRate(v);
          if (id === 'depth')  mod.setDepth(v);
        },
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          depth: mod.depth.gain,
        }),
        dispose: () => { mod.osc.stop(); },
      };
    }),
  },


  {
    id: 'amp',
    name: 'Guitar Amp',
    category: 'saturation',
    hasSidechain: false,
    params: [
      { id: 'gain',     name: 'Gain',     min: 0, max: 100, default: 45, unit: '%' },
      { id: 'stages',   name: 'Stages',   min: 1, max: 3,   default: 2,  unit: '' },
      { id: 'bass',     name: 'Bass',     min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'mid',      name: 'Mid',      min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'treble',   name: 'Treble',   min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'stack',    name: 'Stack',    min: 0, max: 1,   default: 0,  unit: '' },
      { id: 'presence', name: 'Presence', min: -6, max: 12, default: 3,  unit: 'dB' },
      { id: 'master',   name: 'Master',   min: 0, max: 100, default: 40, unit: '%' },
      { id: 'sag',      name: 'Sag',      min: 0, max: 100, default: 35, unit: '%' },
      { id: 'cab',      name: 'Cabinet',  min: 0, max: 3,   default: 1,  unit: '' },
      { id: 'mic',      name: 'Mic',      min: 0, max: 100, default: 45, unit: '%' },
      { id: 'level',    name: 'Level',    min: -24, max: 12, default: 0, unit: 'dB' },
    ],
    // The tone controls and Level are AudioParams all the way down.  Gain,
    // Stages and Cabinet rebuild or re-route nodes, so they are knobs rather
    // than lanes and are declared as driven instead.
    automatableParams: ['bass', 'mid', 'treble', 'presence', 'master', 'level'],
    drivenParams: ['gain'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // ── The preamp ──────────────────────────────────────────────────────
      //
      // Three stages, and how many are IN CIRCUIT is the knob rather than
      // how hard one is driven.  That is how an amplifier is actually built:
      // a clean channel is one valve, a crunch channel is two, a lead
      // channel is three, and the difference between them is not volume.
      //
      // The corners get tighter and the bias more asymmetric as the signal
      // goes deeper, which is what stops a three-stage setting from being
      // mud: each stage cuts more bass than the last before distorting.
      const gain01 = Math.max(0, Math.min(1, p(params, 'gain', 45) / 100));
      const driveOf = (i: number): number => 1 + gain01 * (i === 0 ? 14 : (i === 1 ? 10 : 8));
      const stages = [
        ampStage(ctx, { cutHz: 45, tiltHz: 9000, drive: driveOf(0), bias: 0.55 }),
        ampStage(ctx, { cutHz: 120, tiltHz: 7000, drive: driveOf(1), bias: 0.7 }),
        ampStage(ctx, { cutHz: 220, tiltHz: 6000, drive: driveOf(2), bias: 0.3 }),
      ];

      // ── The tone stack ──────────────────────────────────────────────────
      //
      // Three filters shaped like a passive tone stack, and NOT a simulation
      // of one.  A real stack's three controls interact through one network —
      // turning the bass up moves where the mid sits — and these do not.
      // What they do reproduce is the part that decides the sound: where the
      // bands are, and the scoop between them that a passive stack always has
      // even with everything at noon.  The two stacks differ in exactly that,
      // which is most of what "American" and "British" mean.
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      const scoop = ctx.createBiquadFilter();
      scoop.type = 'peaking';

      const applyStack = (which: number): void => {
        const british = which > 0.5;
        bass.frequency.value = british ? 120 : 90;
        mid.frequency.value = british ? 650 : 480;
        mid.Q.value = british ? 0.8 : 0.6;
        treble.frequency.value = british ? 2600 : 3400;
        // The scoop: fixed, because it is the network and not a control.
        scoop.frequency.value = british ? 480 : 380;
        scoop.Q.value = 0.9;
        scoop.gain.value = british ? -3 : -5;
      };
      applyStack(p(params, 'stack', 0));
      bass.gain.value = p(params, 'bass', 0);
      mid.gain.value = p(params, 'mid', 0);
      treble.gain.value = p(params, 'treble', 0);

      // ── The power amp ───────────────────────────────────────────────────
      //
      // Two things, and the second is the one people mean by "feel".
      //
      // The clip is symmetric where the preamp's is not, because a push-pull
      // output stage is two valves taking a half each — so it makes odd
      // harmonics where the preamp made even ones, and the two together are
      // the full series.
      //
      // The SAG is the power supply running out.  A loud chord pulls the rail
      // down, everything gets quieter for a moment and springs back as the
      // capacitors recover, and that is why a cranked amp breathes.  It is a
      // compressor with a slow attack and a slow release and almost no ratio,
      // which is exactly what a sagging rail is.
      const powerIn = ctx.createGain();
      const powerBack = ctx.createGain();
      let powerShape = makeShaper(ctx, valveCurve(1, 0), '4x');
      powerIn.connect(powerShape).connect(powerBack);
      const setMaster = (percent: number): void => {
        const amount = 1 + (Math.max(0, Math.min(100, percent)) / 100) * 9;
        const next = makeShaper(ctx, valveCurve(amount, 0), '4x');
        powerIn.connect(next).connect(powerBack);
        try { powerIn.disconnect(powerShape); powerShape.disconnect(); } catch { /* not connected */ }
        powerShape = next;
        powerBack.gain.value = 1 / Math.sqrt(amount);
      };
      setMaster(p(params, 'master', 40));

      const sag = ctx.createDynamicsCompressor();
      sag.knee.value = 30;
      sag.ratio.value = 2.4;
      // Slow, because a rail sagging is slow.  Twenty milliseconds was fast
      // enough that the attack was already compressed by the time anybody
      // could hear it as an attack — which is a compressor rather than a
      // sag.  Forty-five in, half a second back.
      sag.attack.value = 0.045;
      sag.release.value = 0.5;
      const setSag = (percent: number): void => {
        const amount = Math.max(0, Math.min(100, percent)) / 100;
        // At 0 the threshold is out of reach and the node is a wire.
        sag.threshold.value = amount <= 0.001 ? 0 : -6 - amount * 24;
      };
      setSag(p(params, 'sag', 35));

      const presence = ctx.createBiquadFilter();
      presence.type = 'highshelf';
      presence.frequency.value = 2200;
      presence.gain.value = p(params, 'presence', 3);

      // ── The cabinet ─────────────────────────────────────────────────────
      const cab = cabinet(ctx, p(params, 'cab', 1), p(params, 'mic', 45) / 100);
      const cabBypass = ctx.createGain();
      const cabWet = ctx.createGain();
      const setCab = (value: number): void => {
        // The last position is OFF, for going into a real cabinet or an
        // impulse response afterwards.  A device that could not be turned off
        // would force its own speaker on anybody who has a better one.
        const off = Math.round(value) >= CAB_KINDS.length;
        cabWet.gain.value = off ? 0 : 1;
        cabBypass.gain.value = off ? 1 : 0;
        if (!off) cab.setKind(value);
      };

      const out = ctx.createGain();
      out.gain.value = dbToGain(p(params, 'level', 0));

      // Wiring.  The stage count decides where the preamp ends.
      const preOut = ctx.createGain();
      const wireStages = (count: number): void => {
        for (const s of stages) { try { s.output.disconnect(); } catch { /* not connected */ } }
        try { input.disconnect(); } catch { /* not connected */ }
        const n = Math.max(1, Math.min(stages.length, Math.round(count)));
        input.connect(stages[0]!.input);
        for (let i = 0; i < n - 1; i++) stages[i]!.output.connect(stages[i + 1]!.input);
        stages[n - 1]!.output.connect(preOut);
      };
      wireStages(p(params, 'stages', 2));

      preOut.connect(bass).connect(mid).connect(treble).connect(scoop)
        .connect(powerIn);
      powerBack.connect(sag).connect(presence);
      presence.connect(cab.input);
      presence.connect(cabBypass);
      cab.output.connect(cabWet);
      cabWet.connect(out);
      cabBypass.connect(out);
      setCab(p(params, 'cab', 1));
      out.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'gain') {
            const g = Math.max(0, Math.min(1, v / 100));
            stages.forEach((s, i) => s.setDrive(1 + g * (i === 0 ? 14 : (i === 1 ? 10 : 8))));
          }
          if (id === 'stages') wireStages(v);
          if (id === 'bass') bass.gain.value = v;
          if (id === 'mid') mid.gain.value = v;
          if (id === 'treble') treble.gain.value = v;
          if (id === 'stack') applyStack(v);
          if (id === 'presence') presence.gain.value = v;
          if (id === 'master') setMaster(v);
          if (id === 'sag') setSag(v);
          if (id === 'cab') setCab(v);
          if (id === 'mic') cab.setMic(v / 100);
          if (id === 'level') out.gain.value = dbToGain(v);
        },
        automatable: automatableFrom({
          bass: { param: bass.gain },
          mid: { param: mid.gain },
          treble: { param: treble.gain },
          presence: { param: presence.gain },
          // Master drives a curve rather than a gain, so the automatable
          // handle is the make-up on the far side of it.  Moving that alone
          // changes the level without changing the saturation, which is what
          // an automation lane on a Master knob is usually reaching for.
          master: { param: powerBack.gain, map: (v) => 1 / Math.sqrt(1 + Math.max(0, Math.min(100, v)) / 100 * 9) },
          level: { param: out.gain, map: dbToGain },
        }),
      };
    }),
  },

  {
    id: 'rotary',
    name: 'Rotary Speaker',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',   name: 'Rate',      min: 0.1, max: 8,    default: 0.8, unit: 'Hz' },
      { id: 'accelSec', name: 'Accel',     min: 0,   max: 4,    default: 1.2, unit: 's' },
      { id: 'xoverHz',  name: 'Crossover', min: 300, max: 1600, default: 800, unit: 'Hz' },
      { id: 'doppler',  name: 'Doppler',   min: 0,   max: 200,  default: 100, unit: '%' },
      { id: 'throb',    name: 'Throb',     min: 0,   max: 100,  default: 55,  unit: '%' },
      { id: 'micAngle', name: 'Mic Angle', min: 0,   max: 180,  default: 90,  unit: '°' },
      { id: 'balance',  name: 'Horn/Drum', min: -100, max: 100, default: 0,   unit: '' },
      { id: 'drive',    name: 'Drive',     min: 0,   max: 100,  default: 20,  unit: '%' },
      { id: 'mix',      name: 'Mix',       min: 0,   max: 100,  default: 100, unit: '%' },
    ],
    // Mix only.  The RATE is deliberately not automatable: setting it goes
    // through a spin-up ramp with a time constant, and an AudioParam
    // automation would write the frequency directly and skip the very thing
    // that makes a speed change sound like a rotor rather than a switch.
    automatableParams: ['mix'],
    // The rotors carry a fixed 4 ms of delay so their modulation can never go
    // negative, and the chain has to know about it or a bypassed channel
    // arrives 4 ms early.
    latencyFor: (_params, sampleRate) => Math.round(0.004 * sampleRate),
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // A Leslie is two speakers in one box, pointed at two rotating things,
      // and they are NOT the same thing rotating.  The treble horn is small
      // and light and spins fast; the bass drum is a heavy drum with a slot
      // in it and spins slower, and its lower frequencies barely Doppler at
      // all.  Crossing over and treating them differently is the whole
      // reason this is not just a chorus with a tremolo on it.
      const rate = p(params, 'rateHz', 0.8);
      const angle = (p(params, 'micAngle', 90) * Math.PI) / 180;
      const doppler = p(params, 'doppler', 100) / 100;
      const throb = p(params, 'throb', 55) / 100;

      // A horn 18 cm from the axis sweeps 0.18 m of path, and sound covers
      // that in 0.18/343 = 0.52 ms.  The drum's slot is nearer the axis and
      // its band is an octave lower, so it swings less and is heard less.
      const HORN_DOPPLER = 0.00052;
      const DRUM_DOPPLER = 0.00021;

      const horn = rotor(ctx, {
        rateHz: rate,
        dopplerSec: HORN_DOPPLER * doppler,
        throb: throb * 0.75,
        angle,
      });
      const drum = rotor(ctx, {
        // Not locked to the horn and slower than it.  On the real cabinet
        // they are separate motors and the beat between them wandering is
        // part of the sound; here it is a fixed ratio, which keeps the bounce
        // identical to the preview and is said rather than hidden.
        rateHz: rate * 0.78,
        dopplerSec: DRUM_DOPPLER * doppler,
        throb: throb * 0.45,
        angle,
      });

      // Drive as a PRE-GAIN into a fixed curve, rather than by rebuilding the
      // curve.  Two reasons and both are practical: a `WaveShaper`'s curve
      // cannot be assigned twice under `node-web-audio-api`, which is what the
      // offline suite renders on, and a gain is an AudioParam while a curve is
      // an allocation.  The post-gain puts full scale back where it was, so
      // the knob changes the harmonics and not the level.
      const drivePre = ctx.createGain();
      const driveShape = makeShaper(ctx, tanhCurve(0), '2x');
      const drivePost = ctx.createGain();
      drivePre.connect(driveShape).connect(drivePost);
      const setDrive = (percent: number): void => {
        const amount = 1 + (Math.max(0, Math.min(100, percent)) / 100) * 7;
        drivePre.gain.value = amount;
        drivePost.gain.value = Math.tanh(1.6) / Math.tanh(1.6 * amount);
      };
      setDrive(p(params, 'drive', 20));

      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = p(params, 'xoverHz', 800);
      const high = ctx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = p(params, 'xoverHz', 800);

      const hornGain = ctx.createGain();
      const drumGain = ctx.createGain();
      const setBalance = (value: number): void => {
        // −100 is all drum, +100 all horn, 0 is both at full.  A tilt rather
        // than a crossfade, because at the middle you want the whole speaker
        // and not half of each half.
        const b = Math.max(-100, Math.min(100, value)) / 100;
        hornGain.gain.value = b < 0 ? 1 + b : 1;
        drumGain.gain.value = b > 0 ? 1 - b : 1;
      };
      setBalance(p(params, 'balance', 0));

      const blend = wetDry(ctx, 1);
      input.connect(drivePre);
      drivePost.connect(high).connect(horn.input);
      drivePost.connect(low).connect(drum.input);
      horn.output.connect(hornGain).connect(blend.wet);
      drum.output.connect(drumGain).connect(blend.wet);
      blend.wet.connect(output);

      // The dry path has to carry the rotors' fixed delay, or turning Mix
      // down moves the signal 4 ms earlier and the blend comb-filters.
      //
      // TWO delay nodes, not one shared with the bypass.  `withBypass` makes
      // its own `input → bypassDelay` connection, and connecting the same
      // pair again here is a duplicate the spec says to ignore and the
      // renderer this suite uses does NOT: measured, a bypassed rotary came
      // out +6.02 dB, which is exactly twice.
      const dryDelay = ctx.createDelay(0.05);
      dryDelay.delayTime.value = horn.baseSec;
      input.connect(dryDelay).connect(blend.dry).connect(output);

      const bypassDelay = ctx.createDelay(0.05);
      bypassDelay.delayTime.value = horn.baseSec;

      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 100));

      return {
        setParam: (id, v) => {
          if (id === 'rateHz') {
            const when = ctx.currentTime;
            const ramp = p(params, 'accelSec', 1.2);
            horn.setRate(v, ramp, when);
            // The drum is heavier, so it takes longer to come up to speed —
            // which is why the two swirl apart for a few seconds after a
            // speed change and then settle.  That transition is the sound
            // everybody actually reaches for the switch to hear.
            drum.setRate(v * 0.78, ramp * 1.8, when);
          }
          if (id === 'accelSec') params['accelSec'] = v;
          if (id === 'xoverHz') { low.frequency.value = v; high.frequency.value = v; }
          if (id === 'doppler') {
            horn.setDoppler(HORN_DOPPLER * (v / 100));
            drum.setDoppler(DRUM_DOPPLER * (v / 100));
          }
          if (id === 'throb') {
            horn.setThrob((v / 100) * 0.75);
            drum.setThrob((v / 100) * 0.45);
          }
          if (id === 'micAngle') {
            const radians = (v * Math.PI) / 180;
            horn.setAngle(radians);
            drum.setAngle(radians);
          }
          if (id === 'balance') setBalance(v);
          if (id === 'drive') setDrive(v);
          if (id === 'mix') setMix(v);
        },
        automatable: automatableFrom({
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        latencySamples: Math.round(horn.baseSec * ctx.sampleRate),
        bypassDelay,
      };
    }),
  },

  // ── Delay ─────────────────────────────────────────────────────────────────
  {
    id: 'pingpong',
    name: 'Ping-Pong Delay',
    category: 'delay',
    hasSidechain: false,
    params: [
      { id: 'timeMs',   name: 'Time',     min: 20,  max: 1500, default: 350, unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,   max: 0.9,  default: 0.4, unit: '' },
      { id: 'toneHz',   name: 'Tone',     min: 800, max: 16000, default: 6000, unit: 'Hz' },
      { id: 'mix',      name: 'Mix',      min: 0,   max: 100,  default: 28,  unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Two delays that feed each OTHER, each panned hard: that cross-feed is
      // the whole trick, and it is why the repeats alternate sides.
      const left = ctx.createDelay(2);
      const right = ctx.createDelay(2);
      const time = p(params, 'timeMs', 350) / 1000;
      left.delayTime.value = time;
      right.delayTime.value = time;

      const fbL = ctx.createGain();
      const fbR = ctx.createGain();
      const fb = Math.min(0.9, p(params, 'feedback', 0.4));
      fbL.gain.value = fb;
      fbR.gain.value = fb;

      // Repeats get darker as they go, the way a real space does.
      const toneL = ctx.createBiquadFilter(); toneL.type = 'lowpass';
      const toneR = ctx.createBiquadFilter(); toneR.type = 'lowpass';
      toneL.frequency.value = p(params, 'toneHz', 6000);
      toneR.frequency.value = p(params, 'toneHz', 6000);

      const panL = ctx.createStereoPanner(); panL.pan.value = -1;
      const panR = ctx.createStereoPanner(); panR.pan.value = 1;

      input.connect(left);
      left.connect(toneL).connect(fbL).connect(right);
      right.connect(toneR).connect(fbR).connect(left);

      const wet = ctx.createGain();
      const dry = ctx.createGain();
      left.connect(panL).connect(wet);
      right.connect(panR).connect(wet);
      const setMix = (percent: number): void => {
        wet.gain.value = Math.max(0, Math.min(1, percent / 100));
        dry.gain.value = 1;                       // a send-style effect: dry stays put
      };
      setMix(p(params, 'mix', 28));
      wet.connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'timeMs')   { left.delayTime.value = v / 1000; right.delayTime.value = v / 1000; }
          if (id === 'feedback') { const g = Math.min(0.9, v); fbL.gain.value = g; fbR.gain.value = g; }
          if (id === 'toneHz')   { toneL.frequency.value = v; toneR.frequency.value = v; }
          if (id === 'mix')      setMix(v);
        },
        // Time, feedback and tone each set a matched left/right pair — one
        // knob, two AudioParams, and ramping half a ping-pong is a stereo
        // image tearing itself apart.  The mix is a send-style wet gain, so
        // it is a single parameter as it stands.
        automatable: automatableFrom({
          mix: { param: wet.gain, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
      };
    }),
  },

  {
    id: 'tapedelay',
    name: 'Tape Delay',
    category: 'delay',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'timeMs',   name: 'Time',     min: 40,  max: 1500, default: 400, unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,   max: 0.95, default: 0.45, unit: '' },
      { id: 'toneHz',   name: 'Tone',     min: 600, max: 12000, default: 3500, unit: 'Hz' },
      { id: 'wowMs',    name: 'Wow',      min: 0,   max: 3,    default: 0.6, unit: 'ms' },
      { id: 'drive',    name: 'Drive',    min: 0,   max: 1,    default: 0.25, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,   max: 100,  default: 25,  unit: '%' },
    ],
    automatableParams: ['timeMs', 'feedback', 'toneHz', 'wowMs', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // What makes a tape delay a tape delay is what happens INSIDE the
      // feedback loop: each pass gets darker, softer and slightly detuned.
      // A clean delay with a filter after it does not do that.
      const delay = ctx.createDelay(2);
      delay.delayTime.value = p(params, 'timeMs', 400) / 1000;
      const wow = lfo(ctx, 0.7, p(params, 'wowMs', 0.6) / 1000);
      wow.depth.connect(delay.delayTime);

      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      tone.frequency.value = p(params, 'toneHz', 3500);
      const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass';
      lowCut.frequency.value = 120;                 // tape has no deep bottom
      let sat = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.25), 0.05));
      // The saturator amplifies quiet signals — see `tubeSmallSignalGain`.
      // Left uncompensated the loop gain at the factory settings is 3.07 and
      // the delay screams instead of repeating; it was audible only once
      // something rendered a long tail through it.  Normalising HERE, before
      // the signal splits to the feedback path and to the wet output, also
      // stops Drive from doubling as a volume knob.
      const norm = ctx.createGain();
      const setDriveNorm = (drive: number): void => {
        norm.gain.value = 1 / Math.max(1, tubeSmallSignalGain(drive, 0.05));
      };
      setDriveNorm(p(params, 'drive', 0.25));
      const fb = ctx.createGain();
      fb.gain.value = Math.min(0.95, p(params, 'feedback', 0.45));

      const wet = ctx.createGain();
      const setMix = (percent: number): void => {
        wet.gain.value = Math.max(0, Math.min(1, percent / 100));
      };
      setMix(p(params, 'mix', 25));

      input.connect(delay);
      delay.connect(tone).connect(lowCut).connect(sat);
      sat.connect(norm);
      norm.connect(fb).connect(delay);
      norm.connect(wet).connect(output);
      input.connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'timeMs')   delay.delayTime.value = v / 1000;
          if (id === 'feedback') fb.gain.value = Math.min(0.95, v);
          if (id === 'toneHz')   tone.frequency.value = v;
          if (id === 'wowMs')    wow.setDepth(v / 1000);
          if (id === 'mix')      setMix(v);
          if (id === 'drive') {
            const next = makeShaper(ctx, tubeCurve(v, 0.05));
            lowCut.disconnect();
            sat.disconnect();
            sat = next;
            lowCut.connect(sat);
            sat.connect(norm);
            setDriveNorm(v);
          }
        },
        // `drive` rebuilds the saturation curve inside the feedback loop.
        automatable: automatableFrom({
          timeMs: { param: delay.delayTime, map: (v) => v / 1000 },
          feedback: { param: fb.gain, map: (v) => Math.min(0.95, v) },
          toneHz: tone.frequency,
          wowMs: { param: wow.depth.gain, map: (v) => v / 1000 },
          mix: { param: wet.gain, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { wow.osc.stop(); sat.disconnect(); },
      };
    }),
  },

  // ── Imaging ───────────────────────────────────────────────────────────────
  {
    id: 'monomaker',
    name: 'Mono Maker',
    category: 'imaging',
    hasSidechain: false,
    params: [
      { id: 'freqHz', name: 'Below',  min: 20, max: 400, default: 120, unit: 'Hz' },
      { id: 'widthPct', name: 'Width', min: 0, max: 200, default: 100, unit: '%' },
    ],
    automatableParams: ['widthPct'],
    latencyFor: () => 0,
    // Bass that is out of phase between the channels disappears the moment
    // anything sums to mono — a club system, a phone, a laptop.  Collapsing
    // only the bottom keeps the record wide and keeps the low end.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const ms = midSide(ctx);
      input.connect(ms.input);

      // Only the side channel is filtered: kill the side below the corner and
      // the bottom is mono while the mid keeps every bit of its energy.
      //
      // Four poles, not two.  A gentle slope leaves an octave of side energy
      // under the corner — bass that still reads on the meters and still
      // disappears in mono, which is the exact problem the device is for.
      const sideHp = [0, 1].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = p(params, 'freqHz', 120);
        f.Q.value = 0.707;
        return f;
      });
      const width = ctx.createGain();
      width.gain.value = Math.max(0, p(params, 'widthPct', 100) / 100);

      ms.mid.connect(ms.midReturn);
      ms.side.connect(sideHp[0]!).connect(sideHp[1]!).connect(width).connect(ms.sideReturn);
      ms.output.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'freqHz')   for (const f of sideHp) f.frequency.value = v;
          if (id === 'widthPct') width.gain.value = Math.max(0, v / 100);
        },
        // `freqHz` retunes a cascade of high-passes, not one filter.
        automatable: automatableFrom({
          widthPct: { param: width.gain, map: (v) => Math.max(0, v / 100) },
        }),
      };
    }),
  },

  {
    id: 'haas',
    name: 'Haas Widener',
    category: 'imaging',
    hasSidechain: false,
    params: [
      { id: 'delayMs', name: 'Delay',  min: 0, max: 40,  default: 12, unit: 'ms' },
      { id: 'amount',  name: 'Amount', min: 0, max: 1,   default: 0.5, unit: '' },
    ],
    automatableParams: ['delayMs', 'amount'],
    latencyFor: () => 0,
    // A few milliseconds on one side reads as width, not as an echo.  Mono
    // compatibility is the price, which is why Amount exists and why this is
    // not something to put on a bass.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = p(params, 'delayMs', 12) / 1000;
      // `amount` is a wet/dry blend on the right channel under another name,
      // so it gets the same single-parameter treatment.
      const blend = wetDry(ctx, p(params, 'amount', 0.5));
      const wet = blend.wet;
      const dryR = blend.dry;
      const setAmount = (a: number): void => blend.setMix(a);

      input.connect(splitter);
      splitter.connect(merger, 0, 0);                 // left straight through
      splitter.connect(delay, 1);
      delay.connect(wet).connect(merger, 0, 1);
      splitter.connect(dryR, 1);
      dryR.connect(merger, 0, 1);
      merger.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'delayMs') delay.delayTime.value = v / 1000;
          if (id === 'amount')  setAmount(v);
        },
        automatable: automatableFrom({
          delayMs: { param: delay.delayTime, map: (v) => v / 1000 },
          amount: blend.mix,
        }),
        dispose: () => blend.dispose(),
      };
    }),
  },

  // ── Utility ───────────────────────────────────────────────────────────────
  {
    id: 'phase',
    name: 'Phase / Mono',
    category: 'utility',
    hasSidechain: false,
    params: [
      { id: 'invertL', name: 'Invert L', min: 0, max: 1, default: 0, unit: '' },
      { id: 'invertR', name: 'Invert R', min: 0, max: 1, default: 0, unit: '' },
      { id: 'swap',    name: 'Swap L/R', min: 0, max: 1, default: 0, unit: '' },
      { id: 'mono',    name: 'Mono',     min: 0, max: 1, default: 0, unit: '' },
    ],
    // Four switches, not knobs: each one re-wires a matrix of six gains, and
    // ramping through 'half swapped' is not a state this device has.
    automatableParams: [],
    latencyFor: () => 0,
    // The first thing to reach for when a snare has two mics and the pair
    // sounds thin, and the check every mix needs before it leaves.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const lGain = ctx.createGain();
      const rGain = ctx.createGain();
      const lToL = ctx.createGain();
      const lToR = ctx.createGain();
      const rToL = ctx.createGain();
      const rToR = ctx.createGain();

      const wire = (): void => {
        const swap = p(params, 'swap', 0) >= 0.5;
        const mono = p(params, 'mono', 0) >= 0.5;
        lGain.gain.value = p(params, 'invertL', 0) >= 0.5 ? -1 : 1;
        rGain.gain.value = p(params, 'invertR', 0) >= 0.5 ? -1 : 1;
        if (mono) {
          lToL.gain.value = 0.5; rToL.gain.value = 0.5;
          lToR.gain.value = 0.5; rToR.gain.value = 0.5;
        } else if (swap) {
          lToL.gain.value = 0; rToL.gain.value = 1;
          lToR.gain.value = 1; rToR.gain.value = 0;
        } else {
          lToL.gain.value = 1; rToL.gain.value = 0;
          lToR.gain.value = 0; rToR.gain.value = 1;
        }
      };
      wire();

      input.connect(splitter);
      splitter.connect(lGain, 0);
      splitter.connect(rGain, 1);
      lGain.connect(lToL); lGain.connect(lToR);
      rGain.connect(rToL); rGain.connect(rToR);
      lToL.connect(merger, 0, 0); rToL.connect(merger, 0, 0);
      lToR.connect(merger, 0, 1); rToR.connect(merger, 0, 1);
      merger.connect(output);

      return {
        setParam: (id, v) => { params[id] = v; wire(); },
      };
    }),
  },

  {
    id: 'dcblock',
    name: 'DC Blocker',
    category: 'utility',
    hasSidechain: false,
    params: [],
    // One job, no parameters.
    automatableParams: [],
    latencyFor: () => 0,
    // A DC offset costs headroom without making a sound: the waveform sits
    // off-centre and the limiter sees peaks that are not music.
    create: (ctx) => withBypass(ctx, (input, output) => {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5;
      hp.Q.value = 0.707;
      input.connect(hp).connect(output);
      return { setParam: () => { /* nothing to set — it is one job */ } };
    }),
  },

  // ── Master chain ──────────────────────────────────────────────────────────
  {
    id: 'dither',
    name: 'Dither',
    category: 'master',
    hasSidechain: false,
    params: [
      { id: 'bits',     name: 'Bits',  min: 8,  max: 24, default: 16, unit: '' },
      { id: 'amount',   name: 'Amount', min: 0, max: 2,  default: 1,  unit: '' },
    ],
    // The noise level is a function of BOTH knobs (an LSB from the bit depth,
    // scaled by the amount), so neither is a parameter on its own.
    automatableParams: [],
    latencyFor: () => 0,
    // The last device in the chain and nowhere else.  Truncating 24-bit to
    // 16 without dither turns quiet tails into gritty steps; a bit of noise
    // below the last bit trades that for hiss nobody can hear.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(ctx);
      source.loop = true;
      const level = ctx.createGain();
      const setLevel = (bits: number, amount: number): void => {
        // One LSB of the target word length, scaled by taste.
        const lsb = Math.pow(2, -(Math.max(2, bits) - 1));
        level.gain.value = lsb * Math.max(0, amount);
      };
      setLevel(p(params, 'bits', 16), p(params, 'amount', 1));
      source.connect(level).connect(output);
      source.start(0);
      input.connect(output);
      return {
        setParam: (id, v) => {
          params[id] = v;
          setLevel(p(params, 'bits', 16), p(params, 'amount', 1));
        },
        dispose: () => { try { source.stop(); } catch { /* never started */ } },
      };
    }),
  },

  {
    id: 'hum',
    name: 'Hum Remover',
    category: 'restore',
    hasSidechain: false,
    params: [
      { id: 'baseHz',   name: 'Base',     min: 40, max: 70, default: 60, unit: 'Hz' },
      { id: 'harmonics', name: 'Harmonics', min: 1, max: 8, default: 4,  unit: '' },
      { id: 'q',        name: 'Q',        min: 5,  max: 60, default: 30, unit: '' },
    ],
    // Every knob retunes the whole notch cascade — up to eight filters — and
    // the harmonic count switches notches in and out entirely.
    automatableParams: [],
    latencyFor: () => 0,
    // Mains hum is not one tone, it is a comb: 50 or 60 Hz and everything
    // above it.  Notching only the fundamental leaves the buzz behind.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const MAX = 8;
      const notches = Array.from({ length: MAX }, () => {
        const f = ctx.createBiquadFilter();
        f.type = 'notch';
        f.Q.value = p(params, 'q', 30);
        return f;
      });
      const tune = (): void => {
        const base = p(params, 'baseHz', 60);
        const count = Math.round(p(params, 'harmonics', 4));
        const q = p(params, 'q', 30);
        notches.forEach((f, i) => {
          const hz = base * (i + 1);
          // Filters past the requested count are parked out of the way rather
          // than rewired, so changing the count never rebuilds the graph.
          f.frequency.value = i < count && hz < ctx.sampleRate / 2 ? hz : 20_000;
          f.Q.value = q;
        });
      };
      tune();
      let cursor: AudioNode = input;
      for (const f of notches) { cursor.connect(f); cursor = f; }
      cursor.connect(output);
      return {
        setParam: (id, v) => { params[id] = v; tune(); },
      };
    }),
  },

  {
    id: 'loudness',
    name: 'Loudness Meter',
    category: 'master',
    hasSidechain: false,
    params: [
      { id: 'targetLufs', name: 'Target', min: -24, max: -6, default: -14, unit: 'LUFS' },
    ],
    // A meter. Its one knob is the target it reports against; it changes
    // nothing in the signal path, so there is nothing for a lane to move.
    automatableParams: [],
    latencyFor: () => 0,
    // A master is finished against a number, not a feeling.  This is the only
    // device here that changes nothing: the audio passes through untouched and
    // a tap off the side is K-weighted per BS.1770-4 so what the window shows
    // is the same measurement the delivery target is written in.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      input.connect(output);

      // BS.1770-4 K-weighting: a +3.99 dB high shelf at 1681.97 Hz followed by
      // an RLB high-pass at 38.135 Hz.  Both are ordinary biquads, so the
      // measurement runs in the graph rather than on the main thread.
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1681.974450955533;
      shelf.gain.value = 3.999843853973347;
      shelf.Q.value = 0.7071752369554196;

      const rlb = ctx.createBiquadFilter();
      rlb.type = 'highpass';
      rlb.frequency.value = 38.13547087602444;
      // Web Audio reads a high-pass Q in decibels; 0.5003 as a cookbook Q is
      // -6.02 dB here.  Passing the raw number would measure a filter nobody
      // specified.
      rlb.Q.value = 20 * Math.log10(0.5003270373238773);

      const weighted = ctx.createAnalyser();
      weighted.fftSize = 2048;
      weighted.smoothingTimeConstant = 0;
      const raw = ctx.createAnalyser();
      raw.fftSize = 2048;
      raw.smoothingTimeConstant = 0;

      input.connect(shelf).connect(rlb).connect(weighted);
      input.connect(raw);

      const block = new Float32Array(weighted.fftSize);
      const rawBlock = new Float32Array(raw.fftSize);

      return {
        setParam: (id, v) => { params[id] = v; },
        analyse: () => {
          weighted.getFloatTimeDomainData(block);
          raw.getFloatTimeDomainData(rawBlock);
          let sum = 0;
          for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
          const meanSquare = sum / block.length;
          let peak = 0;
          for (let i = 0; i < rawBlock.length; i++) {
            const a = Math.abs(rawBlock[i]!);
            if (a > peak) peak = a;
          }
          return {
            // The -0.691 offset is the standard's, not a fudge.
            lufs: meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -70,
            peakDb: peak > 0 ? 20 * Math.log10(peak) : -70,
          };
        },
      };
    }),
  },

  {
    id: 'tape',
    name: 'Tape Machine',
    category: 'saturation',
    hasSidechain: false,
    // Wow and flutter are a transport turning, and a transport does not stop
    // and restart when a clip does — so the modulation is free-running, like
    // the other LFO devices here.
    freeRunning: true,
    params: [
      // A picker rather than a knob: three positions on a 0-to-2 slider read
      // as a number nobody can act on, and the whole point of the control is
      // that each position is a different machine.
      {
        id: 'speed', name: 'Speed', min: 0, max: TAPE_SPEEDS.length - 1, default: 1, unit: '',
        choices: TAPE_SPEED_NAMES, choiceNotes: TAPE_SPEED_NOTES,
      },
      { id: 'drive',     name: 'Level',    min: -12, max: 18, default: 3, unit: 'dB' },
      { id: 'bias',      name: 'Bias',     min: 0, max: 1, default: 0.5, unit: '' },
      { id: 'bump',      name: 'Head Bump', min: 0, max: 8, default: 3, unit: 'dB' },
      { id: 'wow',       name: 'Wow',      min: 0, max: 1, default: 0.25, unit: '' },
      { id: 'flutter',   name: 'Flutter',  min: 0, max: 1, default: 0.25, unit: '' },
      { id: 'hiss',      name: 'Hiss',     min: 0, max: 1, default: 0, unit: '' },
      { id: 'crosstalk', name: 'Crosstalk', min: 0, max: 1, default: 0.2, unit: '' },
      { id: 'mix',       name: 'Mix',      min: 0, max: 1, default: 1, unit: '' },
      { id: 'out',       name: 'Out',      min: -18, max: 12, default: 0, unit: 'dB' },
    ],
    // Level and Out are gains; Mix is the blend.  Speed and Bias rebuild
    // filters and a curve, so they are knobs rather than lanes.
    automatableParams: ['drive', 'mix', 'out'],
    drivenParams: ['bias'],
    // The transport's three milliseconds plus what the oversampled shaper
    // costs.  Declared, because a device that says zero puts its whole track
    // behind the others and the delay compensation believes it — which is a
    // mix error rather than a tape effect.
    latencyFor: (_params, sampleRate) =>
      Math.round(TAPE_BASE_SEC * sampleRate) + OVERSAMPLE_LATENCY_SAMPLES,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // ── Why the saturation sits BETWEEN two EQs ────────────────────────
      //
      // This is the structural fact almost every "tape saturation" plugin
      // leaves out, and it is the reason tape sounds like tape rather than
      // like a soft clipper.
      //
      // A tape machine boosts the high end on the way ON to the tape and cuts
      // it by the same amount on the way OFF.  End to end that is flat, so it
      // is invisible in a frequency response and easy to dismiss as a wash.
      // It is not a wash, because the TAPE IS IN THE MIDDLE: the top arrives
      // at the magnetic nonlinearity ten decibels hotter than the bottom, so
      // it runs out of tape first.  Tape compresses cymbals before it
      // compresses a kick, at the same meter reading, and that is why.
      //
      // It also gives this device frequency-dependent distortion out of two
      // shelves and one curve, where the usual trick is to split into bands
      // and saturate each — which needs a crossover whose phase is then in
      // the signal whether it distorts or not.
      const speed = tapeSpeedAt(p(params, 'speed', 1));

      const record = ctx.createBiquadFilter();
      record.type = 'highshelf';
      record.Q.value = 0.707;
      const play = ctx.createBiquadFilter();
      play.type = 'highshelf';
      play.Q.value = 0.707;

      // ── The transport ─────────────────────────────────────────────────
      //
      // Wow and flutter are two different mechanisms and get two oscillators.
      // Wow is the reel and the capstan being slightly out of round: once per
      // revolution, so a couple of hertz.  Flutter is bearings and the tape
      // scraping over the heads and guides: tens of hertz.  One LFO at one
      // rate is a chorus, and a chorus is not what a transport does.
      //
      // Their rates are deliberately not related by a whole number.  Two
      // modulations that share a period sound like one deeper modulation;
      // a real machine's do not, and neither do these.
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = TAPE_BASE_SEC;

      const wowOsc = ctx.createOscillator();
      wowOsc.type = 'sine';
      wowOsc.frequency.value = 1.7;
      const wowDepth = ctx.createGain();
      wowOsc.connect(wowDepth).connect(delay.delayTime);
      wowOsc.start(0);

      const flutterOsc = ctx.createOscillator();
      flutterOsc.type = 'sine';
      flutterOsc.frequency.value = 23.3;
      const flutterDepth = ctx.createGain();
      flutterOsc.connect(flutterDepth).connect(delay.delayTime);
      flutterOsc.start(0);

      // The depths are set against what a real transport does, measured in
      // cents rather than chosen by ear:
      //
      //   · a serviced studio machine is under 0.05 % wow and flutter, which
      //     is about 0.9 cents peak to peak — below where anyone hears it as
      //     pitch and just above where a piano stops sounding solid
      //   · a tired one is 0.2 %, about 3.5 cents, which is the sound people
      //     mean by "tape"
      //   · past about ten cents it reads as a fault rather than a character,
      //     which is a thing people want on purpose and so is where the knob
      //     ends rather than somewhere it cannot reach
      //
      // The knob's middle is therefore the tired machine and its top is the
      // broken one.  An earlier version put the broken one at a quarter turn,
      // which made every default sound like a fault.
      const setWow = (amount: number): void => {
        // Deeper at slower speeds: the same eccentricity in the same reel is
        // a larger fraction of a slower tape's travel.
        wowDepth.gain.value = 0.00017 * Math.max(0, Math.min(1, amount)) * (15 / speed.ips);
      };
      const setFlutter = (amount: number): void => {
        flutterDepth.gain.value = 0.0000135 * Math.max(0, Math.min(1, amount)) * (15 / speed.ips);
      };
      setWow(p(params, 'wow', 0.25));
      setFlutter(p(params, 'flutter', 0.25));

      // ── The magnetics ─────────────────────────────────────────────────
      //
      // A curve, and what a curve cannot be: real tape has HYSTERESIS, so the
      // magnetisation depends on where the material has already been and not
      // only on the signal in front of it.  That needs a sample of memory and
      // this rack is native nodes by design — a `WaveShaper` has none — so
      // what is here is the loop's midline and not the loop.
      //
      // Said rather than hidden, with what it costs: no minor-loop asymmetry,
      // so a decaying note's distortion does not fall behind its level the
      // way a real machine's does, and no remanence, so there is nothing to
      // print through.  What survives is the shape of the curve and the fact
      // that the top of the band reaches it first, which is most of what
      // people reach for tape to get.
      const drivePre = ctx.createGain();
      let shape = makeShaper(ctx, tapeCurve(tapeKink(p(params, 'bias', 0.5))), '4x');
      const drivePost = ctx.createGain();
      drivePre.connect(shape).connect(drivePost);

      const setMagnetics = (biasValue: number): void => {
        // The shaper is REPLACED rather than re-curved: a `WaveShaper`'s curve
        // cannot be assigned twice under the renderer the offline suite uses,
        // and the bias lives inside the curve.
        const next = makeShaper(ctx, tapeCurve(tapeKink(biasValue)), '4x');
        drivePre.connect(next).connect(drivePost);
        try { drivePre.disconnect(shape); shape.disconnect(); } catch { /* not connected */ }
        shape = next;
      };

      // ── The head ──────────────────────────────────────────────────────
      const bump = ctx.createBiquadFilter();
      bump.type = 'peaking';
      bump.Q.value = 1.1;
      // Below the bump the response falls away, and it falls away from a
      // higher place the faster the tape runs.  That, and not the bump alone,
      // is why thirty inches a second has less weight than fifteen.
      const subCut = ctx.createBiquadFilter();
      subCut.type = 'highpass';
      subCut.Q.value = BUTTERWORTH_Q;
      const top = ctx.createBiquadFilter();
      top.type = 'lowpass';
      // Flat, and it has to be: this corner IS the claim the Speed knob makes,
      // and a Q written as 0.707 would put a +1.5 dB peak an octave inside the
      // stopband of a device whose whole point is where its top ends.  See
      // `BUTTERWORTH_Q` — the number is in decibels.
      top.Q.value = BUTTERWORTH_Q;

      const applySpeed = (): void => {
        record.frequency.value = speed.preHz;
        record.gain.value = speed.preDb;
        play.frequency.value = speed.preHz;
        play.gain.value = -speed.preDb;
        bump.frequency.value = speed.bumpHz;
        subCut.frequency.value = speed.bumpHz * 0.45;
        top.frequency.value = Math.min(ctx.sampleRate * 0.45,
          tapeTopHz(speed, p(params, 'bias', 0.5)));
      };
      bump.gain.value = p(params, 'bump', 3);
      applySpeed();

      // ── Hiss ──────────────────────────────────────────────────────────
      //
      // A looping buffer of seeded noise rather than anything random: an
      // offline bounce has to be the same file every time, and a machine that
      // hisses differently on each render would break that for the sake of a
      // noise floor.  The loop is long enough not to be heard as a loop.
      const hissBuffer = ctx.createBuffer(2, Math.round(ctx.sampleRate * 2.5), ctx.sampleRate);
      let seed = 0x9e3779b9;
      for (let c = 0; c < 2; c++) {
        const data = hissBuffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
          data[i] = ((seed >>> 8) / 8388608) - 1;
        }
      }
      const hissSource = ctx.createBufferSource();
      hissSource.buffer = hissBuffer;
      hissSource.loop = true;
      // Tape hiss is not white — the playback EQ tilts it up, which is why it
      // reads as hiss and not as rumble.
      const hissTilt = ctx.createBiquadFilter();
      hissTilt.type = 'highshelf';
      hissTilt.frequency.value = 2000;
      hissTilt.gain.value = 6;
      const hissGain = ctx.createGain();
      const setHiss = (amount: number): void => {
        const a = Math.max(0, Math.min(1, amount));
        hissGain.gain.value = a <= 0 ? 0 : dbToGain(speed.hissDb + 20 * Math.log10(a));
      };
      setHiss(p(params, 'hiss', 0));
      hissSource.connect(hissTilt).connect(hissGain);
      hissSource.start(0);

      // ── Crosstalk ─────────────────────────────────────────────────────
      //
      // Two tracks on one piece of tape, a few thousandths of an inch apart,
      // with no shield between them.  What leaks is the other channel, and
      // what that does to a mix is pull the sides toward the middle — which
      // is a narrowing, not a widening, and is part of why tape "glues".
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const leakLtoR = ctx.createGain();
      const leakRtoL = ctx.createGain();
      const directL = ctx.createGain();
      const directR = ctx.createGain();
      directL.gain.value = 1;
      directR.gain.value = 1;
      const setCrosstalk = (amount: number): void => {
        const a = Math.max(0, Math.min(1, amount));
        // −55 dB at the knob's top for fifteen ips, quieter the faster the
        // tape: the leak is a fixed distance on the tape and running it past
        // the head faster does not change that, but the wanted signal is
        // stronger, so the ratio improves.
        const db = (speed.hissDb + 30) + 20 * Math.log10(Math.max(1e-4, a));
        const g = a <= 0 ? 0 : dbToGain(db);
        leakLtoR.gain.value = g;
        leakRtoL.gain.value = g;
      };
      setCrosstalk(p(params, 'crosstalk', 0.2));

      // ── Wiring ────────────────────────────────────────────────────────
      const inGain = ctx.createGain();
      inGain.gain.value = dbToGain(p(params, 'drive', 3));
      const outGain = ctx.createGain();
      outGain.gain.value = dbToGain(p(params, 'out', 0));

      // ── The dry path, delayed to meet the wet one ─────────────────────
      //
      // A tape machine has no dry path — the whole signal goes through the
      // transport — so Mix is a modern convenience, and the two sides have to
      // arrive together or it is a comb filter with a percentage on it.
      // Measured, the wet side is late by the transport's three milliseconds
      // plus the oversampled shaper's own; unaligned, fifty per cent wet read
      // 5.5 dB DOWN at 1 kHz.
      //
      // Exact only while the transport is still, and that is not a bug to
      // apologise for: wow and flutter move the wet side's arrival, and a
      // steady signal blended with a pitch-modulated copy of itself is a
      // flanger whatever anybody intends.  Which is one more reason a real
      // machine does not offer the blend.
      const blend = wetDry(ctx, p(params, 'mix', 1));
      const dryAlign = ctx.createDelay(0.05);
      dryAlign.delayTime.value = TAPE_BASE_SEC + OVERSAMPLE_LATENCY_SAMPLES / ctx.sampleRate;
      input.connect(dryAlign).connect(blend.dry).connect(output);

      input.connect(inGain).connect(delay).connect(record).connect(drivePre);
      drivePost.connect(play).connect(subCut).connect(bump).connect(top);
      top.connect(split);
      split.connect(directL, 0);
      split.connect(directR, 1);
      split.connect(leakRtoL, 1);
      split.connect(leakLtoR, 0);
      directL.connect(merge, 0, 0);
      leakRtoL.connect(merge, 0, 0);
      directR.connect(merge, 0, 1);
      leakLtoR.connect(merge, 0, 1);
      merge.connect(outGain);
      hissGain.connect(outGain);
      outGain.connect(blend.wet).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'drive') inGain.gain.value = dbToGain(v);
          if (id === 'out') outGain.gain.value = dbToGain(v);
          if (id === 'mix') blend.setMix(v);
          if (id === 'bump') bump.gain.value = v;
          if (id === 'wow') setWow(v);
          if (id === 'flutter') setFlutter(v);
          if (id === 'hiss') setHiss(v);
          if (id === 'crosstalk') setCrosstalk(v);
          if (id === 'bias') { params['bias'] = v; setMagnetics(v); applySpeed(); }
          if (id === 'speed') { params['speed'] = v; }
        },
        automatable: automatableFrom({
          // Level and Out are in decibels at the knob and gains in the graph,
          // so a lane riding them has to be told the mapping or it would
          // automate a number that is not the one on the panel.
          drive: { param: inGain.gain, map: dbToGain },
          out: { param: outGain.gain, map: dbToGain },
          mix: { param: blend.mix },
        }),
        // Bypass has to keep the same alignment the device reports, or
        // switching it in and out moves the track.
        bypassDelay: (() => {
          const d = ctx.createDelay(0.05);
          d.delayTime.value = TAPE_BASE_SEC + OVERSAMPLE_LATENCY_SAMPLES / ctx.sampleRate;
          return d;
        })(),
        dispose: () => {
          try { wowOsc.stop(); flutterOsc.stop(); hissSource.stop(); } catch { /* stopped */ }
          blend.dispose();
        },
      };
    }),
  },
];
