/**
 * render-audition — every instrument and every drum kit, as audio.
 *
 * A parameter table is not a sound.  Judging whether the Rhodes is too barky
 * or the lofi kit too dull means HEARING them, and the only way to hear them
 * outside the app is to render them.
 *
 * Two rules make the files comparable:
 *
 *   ONE PHRASE for every melodic instrument, and one two-bar beat for every
 *   kit.  A patch that sounds better on its own demo is not a finding.
 *
 *   NORMALISED to −3 dBFS.  Without it the level differences below read as
 *   timbre differences, and they are not the same thing — the RAW peak is
 *   printed beside each file instead, which is where the level problem shows.
 *
 * Run:  pnpm --filter @aimaster/desktop render:audition -- <출력 폴더>
 */
import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { DRUM_GENRE_PRESETS } from '../src/renderer/daw/engine/drum-presets.js';
import { GENRE_ORDER, GENRE_LABEL } from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { writeWav24 } from './lib/wav-codec.js';

const SR = 44100;
const OUT = process.argv[2] ?? '.';
const BPM = 92;
const BEAT = 60 / BPM;

interface Ev { pitch: number; at: number; dur: number; vel: number }

async function render(
  instrumentId: string, events: readonly Ev[], seconds: number,
  params: Record<string, number> = {},
): Promise<Float32Array[]> {
  const inst = findInstrument(instrumentId)!;
  const p = { ...defaultInstrumentParams(instrumentId), ...params };
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  for (const e of events) {
    inst.playNote({
      ctx: ctx as unknown as BaseAudioContext,
      destination: ctx.destination as unknown as AudioNode,
      note: createNote({ pitch: e.pitch, velocity: e.vel, startBeat: 0, durationBeat: 1 }),
      config: DEFAULT_MIDI_CONFIG, when: e.at, durationSec: e.dur, params: p,
    });
  }
  const buf = await ctx.startRendering();
  return [Float32Array.from(buf.getChannelData(0)), Float32Array.from(buf.getChannelData(1))];
}

/** Normalise to −3 dBFS so quiet and loud patches compare fairly by ear. */
function normalise(ch: Float32Array[]): Float32Array[] {
  let peak = 0;
  for (const c of ch) for (const v of c) peak = Math.max(peak, Math.abs(v));
  if (peak <= 0) return ch;
  const g = 0.708 / peak;
  return ch.map((c) => Float32Array.from(c, (v) => v * g));
}

function save(name: string, ch: Float32Array[]): void {
  writeWav24(`${OUT}/${name}.wav`, normalise(ch), SR);
  let peak = 0;
  for (const c of ch) for (const v of c) peak = Math.max(peak, Math.abs(v));
  console.log(`  ${name.padEnd(28)} ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS raw`);
}

// ── Melodic phrase: a chord, then a line, then the chord again ──────────────
function phrase(root: number): Ev[] {
  const chord = [0, 4, 7, 11].map((i) => root + i);
  const line = [12, 11, 9, 7, 4, 7, 9, 11];
  const out: Ev[] = [];
  for (const p of chord) out.push({ pitch: p, at: 0, dur: BEAT * 2.2, vel: 0.62 });
  line.forEach((s, i) => out.push({
    pitch: root + s, at: BEAT * (2.2 + i * 0.5), dur: BEAT * 0.45, vel: 0.7 - (i % 2) * 0.12,
  }));
  for (const p of chord) out.push({ pitch: p + 5, at: BEAT * 6.4, dur: BEAT * 2.6, vel: 0.7 });
  return out;
}

// ── Two bars of a beat, so a kit is heard as a kit ──────────────────────────
const KICK = 36, SNARE = 38, HAT = 42, HAT_OPEN = 46, CRASH = 49, RIDE = 51;
function beat(): Ev[] {
  const out: Ev[] = [];
  const hit = (pitch: number, beatPos: number, vel: number): void => {
    out.push({ pitch, at: beatPos * BEAT, dur: 0.3, vel });
  };
  hit(CRASH, 0, 0.8);
  for (const b of [0, 2.5, 4, 6.5]) hit(KICK, b, 0.95);
  for (const b of [1, 3, 5, 7]) hit(SNARE, b, 0.85);
  for (let i = 0; i < 16; i++) {
    hit(i % 8 === 7 ? HAT_OPEN : HAT, i * 0.5, i % 2 === 0 ? 0.55 : 0.38);
  }
  for (const b of [4.25, 5.75]) hit(RIDE, b, 0.5);
  return out;
}

async function main(): Promise<void> {
  console.log('멜로디 악기 (기본 파라미터, 같은 프레이즈):');
  for (const [id, root] of [['polysynth', 48], ['epiano', 48], ['agtr', 52], ['egtr', 52]] as const) {
    save(`inst-${id}`, await render(id, phrase(root), 9.5));
  }

  console.log('\n드럼 킷 (같은 2마디 비트):');
  save('kit-00-builtin', await render('drumkit', beat(), 6, { kit: 0 }));
  for (let i = 0; i < GENRE_ORDER.length; i++) {
    const g = GENRE_ORDER[i]!;
    const label = GENRE_LABEL[g];
    save(`kit-${String(i + 1).padStart(2, '0')}-${g}`, await render('drumkit', beat(), 6, { kit: i + 1 }));
    console.log(`      ${label} — ${DRUM_GENRE_PRESETS[g].note}`);
  }
}
void main();
