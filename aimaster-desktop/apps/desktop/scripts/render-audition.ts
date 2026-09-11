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
 *   Rendered under node, not under Chromium, so the poly synth and the kit
 *   sit about a decibel from where the app puts them (see instrument-level.ts
 *   — the two renderers disagree about oscillators).  Fine for judging TONE,
 *   which is what these files are for; not evidence about level.
 *
 *   ONE GAIN for every file, not one per file.  Normalising each to −3 dBFS
 *   was right while the instruments were 16 LU apart — it stopped a level
 *   difference reading as a timbre difference.  Now that they are calibrated
 *   (see instrument-level.ts) per-file normalising would DESTROY the thing
 *   worth hearing, so every file gets the same +20 dB and the differences
 *   left are real ones.  The measured loudness is printed beside each.
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
import { getLoudnessMetrics } from '../src/renderer/audio/loudnessCore.js';
import {
  REFERENCE_BEAT_SECONDS, REFERENCE_PHRASE_SECONDS, REFERENCE_ROOT,
  referenceBeat, referencePhrase, type LevelEvent,
} from '../src/renderer/daw/engine/instrument-level.js';

const SR = 44100;
const OUT = process.argv[2] ?? '.';


async function render(
  instrumentId: string, events: readonly LevelEvent[], seconds: number,
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

/** Where the loudest single sample in the whole set is put. */
const AUDITION_CEILING_DBFS = -1;

interface Rendered { name: string; ch: Float32Array[]; lufs: number; peak: number }
const rendered: Rendered[] = [];

/**
 * Render now, write later.
 *
 * The gain has to be ONE number across the whole set — that is the only way
 * the files still say to each other what the instruments say — and it has to
 * be a number that cannot clip.  A constant is not: picking +20 dB by eye
 * clipped the acoustic guitar by 14 dB the first time, because its phrase
 * peaks 20 dB above its own loudness, and the next revoicing would have done
 * it again silently.  So the set is rendered first and the gain is measured
 * off the loudest sample in it.
 */
function collect(name: string, ch: Float32Array[]): void {
  const l = ch[0] ?? new Float32Array(0);
  const r = ch[1] ?? l;
  const m = getLoudnessMetrics({
    sampleRate: SR, length: l.length, numberOfChannels: 2,
    getChannelData: (c: number) => (c === 0 ? l : r),
  });
  rendered.push({ name, ch, lufs: m.integratedLufs, peak: m.truePeakDbtp });
  // What is printed is the instrument's OWN level — what a track in a session
  // sits at.  The file on disk is that plus the shared gain, reported at the
  // end once every file has been measured.
  console.log(`  ${name.padEnd(28)} ${m.integratedLufs.toFixed(1).padStart(6)} LUFS  `
    + `${m.truePeakDbtp.toFixed(1).padStart(5)} dBTP`);
}

function writeAll(): void {
  let peak = 0;
  for (const f of rendered) for (const c of f.ch) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const ceiling = Math.pow(10, AUDITION_CEILING_DBFS / 20);
  const g = peak > 0 ? Math.min(1e6, ceiling / peak) : 1;
  for (const f of rendered) {
    writeWav24(`${OUT}/${f.name}.wav`, f.ch.map((c) => Float32Array.from(c, (v) => v * g)), SR);
  }
  const loudest = rendered.reduce((a, b) => (a.peak > b.peak ? a : b));
  console.log(`\n${rendered.length}개 파일, 전부 같은 +${(20 * Math.log10(g)).toFixed(1)} dB.  `
    + `가장 센 건 ${loudest.name} (${loudest.peak.toFixed(1)} dBTP), 파일에서 ${AUDITION_CEILING_DBFS} dBFS.`);
}

async function main(): Promise<void> {
  console.log(`같은 프레이즈 / 같은 비트, 기본 파라미터.  아래 숫자는 트랙에서의 실제 레벨이고,`);
  console.log('파일은 전부 똑같은 양만큼 올려서 씁니다 — 서로의 차이는 그대로 남습니다.\n');
  console.log('멜로디 악기:');
  for (const id of ['polysynth', 'epiano', 'agtr', 'egtr']) {
    const root = REFERENCE_ROOT[id] ?? 48;
    collect(`inst-${id}`, await render(id, referencePhrase(root), REFERENCE_PHRASE_SECONDS));
  }

  console.log('\n드럼 킷 (같은 2마디 비트):');
  collect('kit-00-builtin', await render('drumkit', referenceBeat(), REFERENCE_BEAT_SECONDS, { kit: 0 }));
  for (let i = 0; i < GENRE_ORDER.length; i++) {
    const g = GENRE_ORDER[i]!;
    collect(`kit-${String(i + 1).padStart(2, '0')}-${g}`,
      await render('drumkit', referenceBeat(), REFERENCE_BEAT_SECONDS, { kit: i + 1 }));
    console.log(`      ${GENRE_LABEL[g]} — ${DRUM_GENRE_PRESETS[g].note}`);
  }

  writeAll();
}
void main();
