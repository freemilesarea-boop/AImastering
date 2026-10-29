// Instrument starting points.
//
// The genre set in `plugin-presets-genre.ts` is organised by RECORD: you know
// what the song is supposed to sound like before you know what is on track 7.
// These are the other axis.  You have a bass on track 7 and it is too big in
// the low mids; that is a fact about a bass, and it is the same fact whether
// the record is 재즈 or EDM.
//
// Both menus are on every device, because both questions are real and they do
// not answer each other.  Pick the instrument to get the device into the right
// postcode, then the genre — or your ears — for the rest.
//
// ── What an instrument profile is ────────────────────────────────────────────
//
// One paragraph of what the source actually IS, in frequencies and time, that
// every device below has to agree with.  Written down so it can be argued
// with: if you think an acoustic guitar's body boom is at 120 Hz rather than
// 200, that is a claim about a number in a table.
//
//   보컬        A close-mic'd lead, which is three problems at once and one
//               of them is not about frequency.  The fundamental sits at
//               100–250 Hz for most singers and the proximity effect piles
//               more underneath it, so the high-pass is at 85 — high enough
//               to lose the rumble and the plosive, low enough to leave a
//               male chest voice intact.  Intelligibility is 2–4 kHz and it
//               is the band to ADD in; the band to watch is 6–9 kHz, where
//               sibilance lives, which is why the de-esser on this source is
//               the deepest in the file.  The dynamic range of a sung
//               performance is wider than anything else here — a whisper and
//               a belt in the same line — so the compression is the heaviest
//               of the melodic sources and the attack has to be fast enough
//               to catch a consonant (6 ms) without eating it.  And it stays
//               in the CENTRE: width on a lead vocal is how a mix loses its
//               singer on a phone speaker.
//
//   백킹 보컬    The same voice doing a different job: it is not the one you
//               follow.  So everything that makes the LEAD clear is done the
//               other way round — the high-pass is higher (140, because the
//               lead owns the chest), 1.8 kHz is CUT rather than lifted
//               because that is the lead's intelligibility band, the
//               compression is harder and faster so the stack sits still,
//               and it is the one vocal source that gets widened: the lead
//               is the centre, so the backing is the sides.  Stacked takes
//               stack their sibilance too, which is why the de-esser here is
//               second only to the lead's.
//
//   드럼 루프    A finished stereo kit, not one drum.  So the transient is the
//               whole point and anything with a fast attack eats it: attacks
//               stay slow (10–30 ms) and releases fast, which is the opposite
//               of how you would treat a single kick.  Kick fundamental
//               50–60 Hz, so the high-pass has to stay under it.  Snap lives
//               at 2–5 kHz, cymbal air at 10 kHz+.  Gating a LOOP is a
//               different job from gating a close mic — there is bleed you
//               want to keep — so gate ranges here are shallow.
//
//   퍼커션      One hit, not a kit — shaker, tambourine, conga, a tail that
//               is already short.  Nothing it does lives under 200 Hz, so
//               the high-pass is the highest in the file and nothing is lost
//               by it.  The information is the attack and the 5–10 kHz, so
//               the transient designer is the device this source exists for
//               and the compressor's release has to be short enough to be
//               out of the way before the next hit.  Unlike a loop, an
//               overdubbed percussion track has no bleed worth keeping, so
//               it can be gated twice as deep.
//
//   베이스      Mono, always, and the one instrument where that is not a
//               stylistic choice: a wide low end cancels on any mono system.
//               Fundamental 40–120 Hz, the note you actually HEAR on a phone
//               is the 700–900 Hz harmonic, and finger/string noise is at
//               2–3 kHz.  High-pass only to lose rumble (~30 Hz) — cutting at
//               80 like a guitar removes the instrument.  Compression is
//               heavy and slow to attack, so the pluck survives and the
//               sustain does not.  Saturation is not an effect here; it is how
//               the part stays audible on a speaker with no low end at all.
//
//   일렉 기타    Already band-limited by the amp and cabinet: effectively
//               nothing under 80 Hz or over 6 kHz.  So the high-pass sits at
//               80–100 and treble boosts above 6 kHz only lift hiss.  The
//               problem frequency is the 800 Hz–1 kHz honk; the good one is
//               2.5–4 kHz presence.  Spring reverb and slapback are native to
//               this instrument rather than effects on it.
//
//   어쿠스틱 기타 (통기타)  A wide-range source pretending to be a narrow one.
//               The body boom at 150–250 Hz is what makes a recording sound
//               amateur, and the pick and string detail at 4–8 kHz is the
//               character.  Air matters to 15 kHz, so unlike the electric it
//               is a full-range instrument.  Light compression — it is a
//               dynamic instrument and squashing it makes it plastic.  Plate
//               or room, never spring.
//
//   피아노      The widest range here: fundamentals from 27 Hz to 4 kHz and
//               harmonics past 15 kHz, so almost every band does something.
//               Mud at 200–400 Hz, hammer and attack at 2–5 kHz.  Compression
//               is the biggest risk on this instrument, because the dynamics
//               ARE the performance — ratios stay near 2:1 and often the
//               right answer is not to.  Naturally stereo; widening it
//               usually just moves the phase around.
//
//   스트링      An ensemble with no transient at all: bows start notes over
//               tens of milliseconds, so a fast attack finds nothing to catch
//               and a slow one is inaudible.  Body 200–400 Hz, and rosin and
//               bow noise at 6–10 kHz, which is the harshness people reach
//               for an EQ about.  Long halls are normal rather than an
//               effect.  Very light compression; wide.
//
//   브라스      Loud, directional, and the one family that gets harsh exactly
//               where it is loudest: 2–5 kHz.  A trombone's fundamental is
//               near 150 Hz and a trumpet's near 500, so the high-pass stays
//               low (75) and the work is a 3.2 kHz dip with a 10 kHz lift —
//               take out the sting, give back the shine.  Compression is
//               restrained on purpose: a section squeezed hard stops
//               sounding like players and starts sounding like a synth
//               patch.  Saturation is the exception — brass already has the
//               harmonics, so adding more sounds like more brass.
//
//   목관        Breath is part of the sound and the microphone hears all of
//               it, so the band to control is the 4–8 kHz of the breath, not
//               the note.  The transients are soft — there is nothing to
//               catch — which is why the attacks here are the slowest of
//               any wind or string source and the gate is barely armed;
//               gating a flute is how you lose the start of every phrase.
//               A smaller room than the strings, always: woodwinds that sit
//               as far back as the violins disappear behind them.
//
//   신스        The one source that can be anything, so the presets aim at
//               what synths actually get WRONG rather than at a sound: too
//               much sub fighting the bass, too wide to survive mono, too
//               static to sit in a mix, and harsh at 3–6 kHz on anything
//               saw-based.  Treated as the thing you have to make room for.
//
//   FX          Not an instrument: risers, impacts, whooshes, reverse
//               cymbals.  Nothing here is corrective, so every device is set
//               the way you would set it to be HEARD — the widest, the
//               longest, the most saturated numbers in the file are all in
//               this column.  The one discipline is the bottom: the
//               high-pass is at 160 and the mono maker at 240, because an FX
//               that fights the kick is an FX that has to be turned down.
//
// ── What is NOT here, and why ────────────────────────────────────────────────
//
// Five devices get no instrument presets.  Four of them have no instrument
// preset for the same reason they have no genre preset, and the fifth is new:
//
//   dcblock   has no parameters at all.
//   phase     is invert / swap / mono — a wiring decision, not a sound.
//   trim      is one gain.  A preset for it would be a number with a name.
//   dither    belongs to the file being written, not to what is on the track.
//   loudness  is an integrated-LUFS target, which is a fact about a RECORD.
//             A bass track does not have a target loudness; the song does.
//             The genre set has one because a genre really does; giving an
//             instrument one would be inventing a number to fill a column.

import type { PluginPreset } from './plugin-presets.js';
import { spaceIndex } from './reverb-spaces.js';

const S = spaceIndex;

export type InstrumentId =
  | 'vocal' | 'backing' | 'drumloop' | 'perc' | 'bass' | 'egtr' | 'agtr'
  | 'piano' | 'strings' | 'brass' | 'winds' | 'synth' | 'fx';

/**
 * The order the thirteen appear in every device's menu.
 *
 * 보컬 first, and it was absent entirely until it was added: a menu of seven
 * sources in an app whose first mixing category is the vocal, where the one
 * thing almost every session has was the one thing with no starting point.
 */
export const INSTRUMENT_ORDER: readonly InstrumentId[] = [
  'vocal', 'backing', 'drumloop', 'perc', 'bass', 'egtr', 'agtr',
  'piano', 'strings', 'brass', 'winds', 'synth', 'fx',
];

export const INSTRUMENT_LABEL: Record<InstrumentId, string> = {
  vocal:    '보컬',
  backing:  '백킹 보컬',
  drumloop: '드럼 루프',
  perc:     '퍼커션',
  bass:     '베이스',
  egtr:     '일렉 기타',
  agtr:     '어쿠스틱 기타',
  piano:    '피아노',
  strings:  '스트링',
  brass:    '브라스',
  winds:    '목관',
  synth:    '신스',
  fx:       'FX',
};

/** The group these appear under in every plugin window. */
export const INSTRUMENT_GROUP = '악기';

/**
 * Devices with no instrument presets, and why — listed rather than inferred,
 * so adding a device without them fails the coverage test instead of quietly
 * shrinking the set.
 */
export const NO_INSTRUMENT_PRESETS: Readonly<Record<string, string>> = {
  dcblock:  '파라미터가 없습니다',
  phase:    '반전 · 교체 · 모노 — 배선 결정이지 소리가 아닙니다',
  trim:     '게인 하나입니다. 프리셋은 이름 붙인 숫자일 뿐입니다',
  dither:   '쓰는 파일에 대한 것이지 트랙에 뭐가 있는지와 무관합니다',
  loudness: 'LUFS 목표는 곡의 사실입니다. 베이스 트랙에는 목표 라우드니스가 없습니다',
  matcheq:  '매치 EQ 의 설정은 특정 레퍼런스를 잰 결과 그 자체입니다. 프리셋 커브는 아무도 재지 않은 커브입니다',
  analyzer: '오디오를 건드리지 않습니다. 이 기기의 설정은 소리가 아니라 그림입니다',
};

/**
 * Devices where the instrument legitimately moves ONE parameter, and why.
 *
 * The differentiation test normally insists two presets differ in at least
 * two parameters, because on most devices a pair that moves one knob is a
 * paste somebody forgot to finish.  Here it is the truth about the device:
 * `pitchcorrect` has `amount` and `formant`, and formant is a semitone shift
 * with no per-instrument answer.  Filling that column with seven invented
 * numbers to satisfy a test is precisely what the header above says this file
 * does not do — so the exemption is declared, in the source, next to the data
 * it excuses.
 */
export const SINGLE_AXIS_DEVICES: Readonly<Record<string, string>> = {
  pitchcorrect: 'formant 는 악기마다 답이 없습니다. amount 하나만 움직입니다',
};

/**
 * Pairs where two instruments honestly want the SAME answer on a device.
 *
 * The differentiation test exists because two presets that are the same
 * preset mean the menu is claiming a choice it does not have.  That is the
 * usual case and it is a copy-paste.  This is the other case: a device whose
 * setting is not a fact about the instrument at all.
 *
 *   `hum` is set by the building's wiring, not by what is in front of the
 *   microphone.  The eight that differ do so by how many harmonics of the
 *   buzz the source hides — so sources recorded the same way share an answer
 *   rather than having thirteen invented ones.
 *
 *   `pitchcorrect` tracks ONE pitched note.  A shaker has no pitch, a brass
 *   or woodwind section is a chord, and an FX riser is neither.  Giving each
 *   of them its own correction amount would be four numbers that mean
 *   nothing, chosen so a test would pass.
 *
 * Declared here, in the source, beside the data — the same rule the header
 * sets for every other exemption in this file.
 */
export const SHARED_INSTRUMENT_ANSWERS: Readonly<Record<string,
  Partial<Record<InstrumentId, InstrumentId>>>> = {
  hum: {
    backing: 'vocal',
    perc: 'drumloop',
    brass: 'strings',
    winds: 'strings',
    fx: 'synth',
  },
  pitchcorrect: {
    perc: 'drumloop',
    brass: 'strings',
    winds: 'strings',
    fx: 'drumloop',
  },
};

/**
 * Which instrument's answer this one borrows on this device, or null.
 *
 * Read twice: the plugin window says it on the chip ("드럼 루프와 같은 설정"),
 * because a preset that is deliberately not its own is worth knowing before
 * you spend time turning its knobs; and the selftest reads it to tell a
 * declared share from a copy-paste.
 */
export function sharedInstrumentSource(
  pluginId: string, id: InstrumentId,
): InstrumentId | null {
  return SHARED_INSTRUMENT_ANSWERS[pluginId]?.[id] ?? null;
}

interface InstrumentEntry { note: string; params: Record<string, number> }

/**
 * Seven presets for one device.
 *
 * The `Record<InstrumentId, …>` is doing real work: leaving an instrument out
 * is a type error, so "I did five and got bored" cannot reach the repository.
 */
function inst(
  pluginId: string, entries: Record<InstrumentId, InstrumentEntry>,
): PluginPreset[] {
  return INSTRUMENT_ORDER.map((id) => ({
    id: `inst-${pluginId}-${id}`,
    pluginId,
    name: INSTRUMENT_LABEL[id],
    group: INSTRUMENT_GROUP,
    note: entries[id].note,
    params: entries[id].params,
  }));
}

/**
 * Pull the instrument group out of a device's preset groups.
 *
 * Same reasoning as `partitionGenre`: a closed set of seven that you know the
 * name of before opening the menu is a row of chips, not a dropdown entry to
 * scroll past.
 */
export function partitionInstrument(
  groups: ReadonlyArray<{ group: string; presets: PluginPreset[] }>,
): { instrument: PluginPreset[]; rest: Array<{ group: string; presets: PluginPreset[] }> } {
  const found = groups.find((g) => g.group === INSTRUMENT_GROUP);
  return {
    instrument: INSTRUMENT_ORDER
      .map((id) => found?.presets.find((p) => p.name === INSTRUMENT_LABEL[id]))
      .filter((p): p is PluginPreset => p !== undefined),
    rest: groups.filter((g) => g.group !== INSTRUMENT_GROUP),
  };
}

export const INSTRUMENT_PRESETS: readonly PluginPreset[] = [

  // ══ EQ ═════════════════════════════════════════════════════════════════════

  ...inst('eq3', {
    backing:  { note: '리드가 설 자리를 비웁니다 — 1.8 kHz 를 깎는 것이 백킹의 핵심입니다',
                params: { hpfHz: 140, lowDb: -3, midDb: -3, midHz: 1800, highDb: 3 } },
    perc:     { note: '200 Hz 아래에는 아무것도 없습니다. 5 kHz 가 퍼커션의 정보입니다',
                params: { hpfHz: 200, lowDb: -4, midDb: 1, midHz: 5000, highDb: 3.5 } },
    brass:    { note: '3.2 kHz 가 금관이 쏘는 자리입니다. 거기만 덜고 몸통은 남깁니다',
                params: { hpfHz: 75, lowDb: 0.5, midDb: -3, midHz: 3200, highDb: 2 } },
    winds:    { note: '1.5 kHz 를 올려 목관을 앞으로. 스트링 사이에서 사라지는 대역입니다',
                params: { hpfHz: 120, lowDb: -1, midDb: 1, midHz: 1500, highDb: 1 } },
    fx:       { note: '효과음에 저역은 리듬 파트와 부딪히기만 합니다. 위만 남깁니다',
                params: { hpfHz: 160, lowDb: -5, midDb: 0, midHz: 1200, highDb: 4.5 } },
    vocal:    { note: '밴드가 셋뿐이면 보컬에서는 명료도를 씁니다 — 2.8 kHz 를 올려 가사를 앞으로',
                params: { hpfHz: 90, lowDb: -2, midDb: 1.5, midHz: 2800, highDb: 2.5 } },
    drumloop: { note: '킥이 50 Hz 에 있으니 하이패스는 그 아래로. 2.5 kHz 스냅을 올립니다',
                params: { hpfHz: 35, lowDb: 2, midDb: 2, midHz: 2500, highDb: 2.5 } },
    bass:     { note: '30 Hz 만 걷어냅니다. 800 Hz 를 올려야 폰에서 음이 들립니다',
                params: { hpfHz: 30, lowDb: 2.5, midDb: 2, midHz: 800, highDb: -2 } },
    egtr:     { note: '앰프가 이미 잘라놨습니다. 900 Hz 헝크를 깎고 고역은 건드리지 않습니다',
                params: { hpfHz: 90, lowDb: -1, midDb: -3, midHz: 900, highDb: 0.5 } },
    agtr:     { note: '200 Hz 통울림을 깎고 피크 소리를 올립니다. 통기타의 성격은 고역에 있습니다',
                params: { hpfHz: 80, lowDb: -2.5, midDb: -2, midHz: 220, highDb: 3.5 } },
    piano:    { note: '300 Hz 머드만 덜어냅니다. 피아노는 대체로 EQ 를 적게 받는 쪽이 낫습니다',
                params: { hpfHz: 40, lowDb: 0.5, midDb: -2, midHz: 300, highDb: 1.5 } },
    strings:  { note: '7 kHz 활 소리가 쏩니다. 고역을 내리고 몸통을 살짝 올립니다',
                params: { hpfHz: 60, lowDb: 1, midDb: -1.5, midHz: 320, highDb: -2 } },
    synth:    { note: '베이스와 겹치는 저역을 잘라 자리를 비웁니다. 신스는 대개 너무 꽉 찹니다',
                params: { hpfHz: 120, lowDb: -2, midDb: -1.5, midHz: 450, highDb: 1 } },
  }),

  ...inst('eq8', {
    backing:  { note: '450 Hz 를 더 깎고 1.8 kHz 를 비웁니다 — 리드의 명료도 대역입니다',
                params: { hpfHz: 140, lowDb: -3, lowHz: 220, b1Db: -4, b1Hz: 450, b1Q: 1.3,
                          b2Db: -2, b2Hz: 1800, b2Q: 1, b3Db: 1, b3Hz: 7000, b3Q: 1,
                          highDb: 3, highHz: 12000, lpfHz: 20000 } },
    perc:     { note: '6 kHz 의 손과 13 kHz 의 공기. 그 아래는 거의 전부 버립니다',
                params: { hpfHz: 200, lowDb: -4, lowHz: 250, b1Db: -2, b1Hz: 500, b1Q: 1.2,
                          b2Db: 1, b2Hz: 2000, b2Q: 0.9, b3Db: 3, b3Hz: 6000, b3Q: 0.9,
                          highDb: 3.5, highHz: 13000, lpfHz: 20000 } },
    brass:    { note: '3.2 kHz −3 dB 에 10 kHz +2 dB — 쏘는 곳만 덜고 광택은 돌려줍니다',
                params: { hpfHz: 75, lowDb: 1, lowHz: 180, b1Db: -2, b1Hz: 450, b1Q: 1.1,
                          b2Db: -3, b2Hz: 3200, b2Q: 1.2, b3Db: 1, b3Hz: 6000, b3Q: 1,
                          highDb: 2, highHz: 10000, lpfHz: 18000 } },
    winds:    { note: '6.5 kHz 는 음이 아니라 숨소리입니다. 그것만 내리고 1.5 kHz 를 올립니다',
                params: { hpfHz: 120, lowDb: -1, lowHz: 200, b1Db: -2, b1Hz: 320, b1Q: 1,
                          b2Db: 1.5, b2Hz: 1500, b2Q: 0.8, b3Db: -2, b3Hz: 6500, b3Q: 1.4,
                          highDb: 1.5, highHz: 12000, lpfHz: 19000 } },
    fx:       { note: '저역을 비우고 14 kHz 를 올립니다. 효과음은 위에서 들립니다',
                params: { hpfHz: 160, lowDb: -5, lowHz: 200, b1Db: 0, b1Hz: 600, b1Q: 1,
                          b2Db: -1, b2Hz: 1500, b2Q: 0.8, b3Db: 2, b3Hz: 5000, b3Q: 0.9,
                          highDb: 4, highHz: 14000, lpfHz: 20000 } },
    vocal:    { note: '400 Hz 박스를 덜고 2.8 kHz 명료도를 올립니다. 6.5 kHz 는 디에서 앞에서 미리 눌러둡니다',
                params: { hpfHz: 85, lowDb: -2, lowHz: 200, b1Db: -3, b1Hz: 400, b1Q: 1.2,
                          b2Db: 1.5, b2Hz: 2800, b2Q: 0.8, b3Db: -2.5, b3Hz: 6500, b3Q: 1.6,
                          highDb: 2.5, highHz: 11000, lpfHz: 20000 } },
    drumloop: { note: '60 Hz 킥, 250 Hz 박스 컷, 3.5 kHz 스냅, 11 kHz 심벌 공기',
                params: { hpfHz: 32, lowDb: 2.5, lowHz: 60, b1Db: -3, b1Hz: 250, b1Q: 1.2,
                          b2Db: 1, b2Hz: 900, b2Q: 0.8, b3Db: 3, b3Hz: 3500, b3Q: 0.9,
                          highDb: 2.5, highHz: 11000, lpfHz: 20000 } },
    bass:     { note: '70 Hz 몸통, 250 Hz 머드 컷, 850 Hz 음정, 2.5 kHz 핑거 노이즈. 위는 버립니다',
                params: { hpfHz: 28, lowDb: 3, lowHz: 70, b1Db: -3.5, b1Hz: 250, b1Q: 1.4,
                          b2Db: 2.5, b2Hz: 850, b2Q: 1, b3Db: 1.5, b3Hz: 2500, b3Q: 1.2,
                          highDb: -4, highHz: 8000, lpfHz: 12000 } },
    egtr:     { note: '앰프 대역만 남깁니다 — 100 Hz 아래와 7 kHz 위는 하울과 히스뿐입니다',
                params: { hpfHz: 100, lowDb: -1.5, lowHz: 160, b1Db: -4, b1Hz: 900, b1Q: 1.6,
                          b2Db: 2, b2Hz: 2800, b2Q: 0.9, b3Db: 1, b3Hz: 4500, b3Q: 1.1,
                          highDb: -2, highHz: 9000, lpfHz: 7500 } },
    agtr:     { note: '180 Hz 붐을 깎고 5 kHz 피크와 13 kHz 에어를 올립니다. 풀레인지 악기입니다',
                params: { hpfHz: 85, lowDb: -3, lowHz: 180, b1Db: -2, b1Hz: 380, b1Q: 1.1,
                          b2Db: 1.5, b2Hz: 1800, b2Q: 0.8, b3Db: 3, b3Hz: 5000, b3Q: 0.9,
                          highDb: 3, highHz: 13000, lpfHz: 20000 } },
    piano:    { note: '거의 손대지 않습니다. 320 Hz 만 덜고 해머와 공기를 조금 올립니다',
                params: { hpfHz: 38, lowDb: 1, lowHz: 90, b1Db: -2.5, b1Hz: 320, b1Q: 1,
                          b2Db: 0.5, b2Hz: 1500, b2Q: 0.7, b3Db: 1.5, b3Hz: 3500, b3Q: 0.8,
                          highDb: 2, highHz: 12000, lpfHz: 20000 } },
    strings:  { note: '8 kHz 로진 노이즈를 −3 dB. 스트링에서 거슬리는 건 거의 항상 여기입니다',
                params: { hpfHz: 65, lowDb: 1.5, lowHz: 140, b1Db: 1, b1Hz: 300, b1Q: 0.7,
                          b2Db: -2, b2Hz: 1200, b2Q: 1, b3Db: -3, b3Hz: 8000, b3Q: 1.3,
                          highDb: 1, highHz: 14000, lpfHz: 18000 } },
    synth:    { note: '150 Hz 아래를 비우고 4 kHz 톱니 거슬림을 깎습니다. 자리를 만드는 EQ 입니다',
                params: { hpfHz: 130, lowDb: -2, lowHz: 200, b1Db: -1.5, b1Hz: 500, b1Q: 0.9,
                          b2Db: 1, b2Hz: 1600, b2Q: 0.8, b3Db: -3, b3Hz: 4200, b3Q: 1.4,
                          highDb: 2, highHz: 10000, lpfHz: 20000 } },
  }),

  ...inst('tilt', {
    backing:  { note: '리드보다 밝게 기울입니다 — 뒤에 있어도 또렷하게',
                params: { tiltDb: 2.8, pivotHz: 350 } },
    perc:     { note: '퍼커션은 거의 고역만 남기는 쪽이 맞습니다',
                params: { tiltDb: 4, pivotHz: 2500 } },
    brass:    { note: '금관은 이미 밝습니다. 살짝 아래로 기울입니다',
                params: { tiltDb: -1, pivotHz: 1800 } },
    winds:    { note: '2.2 kHz 를 축으로 조금만 위로',
                params: { tiltDb: 1, pivotHz: 2200 } },
    fx:       { note: '3 kHz 위를 크게 올려 공중에 띄웁니다',
                params: { tiltDb: 3.5, pivotHz: 3000 } },
    vocal:    { note: '300 Hz 를 축으로 위를 올립니다 — 몸통을 줄이고 명료도를 올리는 한 손잡이',
                params: { tiltDb: 1.5, pivotHz: 300 } },
    drumloop: { note: '1.2 kHz 를 축으로 살짝 밝게. 루프 전체 성격을 한 손잡이로 바꿉니다',
                params: { tiltDb: 2, pivotHz: 1200 } },
    bass:     { note: '아래로 기울입니다. 베이스에서 고역은 대개 방해입니다',
                params: { tiltDb: -3.5, pivotHz: 700 } },
    egtr:     { note: '앰프 대역 한가운데를 축으로 아주 살짝만',
                params: { tiltDb: -1.5, pivotHz: 900 } },
    agtr:     { note: '위로 기울여 통울림을 상대적으로 낮춥니다',
                params: { tiltDb: 3, pivotHz: 600 } },
    piano:    { note: '거의 평평하게. 피아노는 기울이면 바로 티가 납니다',
                params: { tiltDb: 0.5, pivotHz: 1000 } },
    strings:  { note: '아래로 — 활 소리를 낮추면 스트링은 대체로 좋아집니다',
                params: { tiltDb: -2.5, pivotHz: 2000 } },
    synth:    { note: '위로 밝게. 신스는 밝아야 다른 악기 위에 얹힙니다',
                params: { tiltDb: 2.5, pivotHz: 1500 } },
  }),

  ...inst('mseq', {
    backing:  { note: '사이드의 고역을 올립니다 — 백킹은 가장자리에 있어야 합니다',
                params: { midLowDb: -2, midHighDb: 0.5, sideLowDb: -3, sideHighDb: 3 } },
    perc:     { note: '가운데는 거의 비우고 좌우로 펼칩니다',
                params: { midLowDb: -1.5, midHighDb: 2.5, sideLowDb: -1, sideHighDb: 3.5 } },
    brass:    { note: '섹션은 가운데에 모여 있어야 한 덩어리로 들립니다',
                params: { midLowDb: 0.5, midHighDb: -1, sideLowDb: -1.5, sideHighDb: 1 } },
    winds:    { note: '사이드를 조금만 — 목관은 넓히면 가늘어집니다',
                params: { midLowDb: -0.5, midHighDb: 1.5, sideLowDb: -4, sideHighDb: 2.5 } },
    fx:       { note: '가운데를 비우고 사이드를 올립니다. 효과음의 자리는 바깥입니다',
                params: { midLowDb: -3, midHighDb: 1.5, sideLowDb: 0, sideHighDb: 4 } },
    vocal:    { note: '리드 보컬은 가운데 것입니다. 사이드 저역을 크게 깎아 가운데를 비웁니다',
                params: { midLowDb: -1.5, midHighDb: 1.5, sideLowDb: -6, sideHighDb: 1 } },
    drumloop: { note: '가운데 저역은 킥, 옆 고역은 오버헤드. 그 둘만 올립니다',
                params: { midLowDb: 2, midHighDb: 0, sideLowDb: -4, sideHighDb: 3 } },
    bass:     { note: '옆을 전부 내립니다. 베이스의 스테레오 저역은 모노에서 사라집니다',
                params: { midLowDb: 2.5, midHighDb: 0.5, sideLowDb: -12, sideHighDb: -6 } },
    egtr:     { note: '더블 트랙 기타의 옆 고역만 올려서 벌립니다',
                params: { midLowDb: -1, midHighDb: -1, sideLowDb: -3, sideHighDb: 3.5 } },
    agtr:     { note: '옆 고역을 크게 — 통기타는 넓을수록 좋고 저역은 좁을수록 좋습니다',
                params: { midLowDb: -1.5, midHighDb: 0, sideLowDb: -5, sideHighDb: 4.5 } },
    piano:    { note: '자연 스테레오를 존중합니다. 가운데를 아주 살짝만 정리',
                params: { midLowDb: -1, midHighDb: 0.5, sideLowDb: -2, sideHighDb: 1.5 } },
    strings:  { note: '섹션은 옆이 넓어야 섹션으로 들립니다',
                params: { midLowDb: 0.5, midHighDb: -1.5, sideLowDb: -2.5, sideHighDb: 2.5 } },
    synth:    { note: '옆 저역을 크게 깎습니다. 신스 패드의 저역이 모노를 무너뜨립니다',
                params: { midLowDb: -2, midHighDb: 1, sideLowDb: -9, sideHighDb: 4 } },
  }),

  ...inst('dyneq', {
    backing:  { note: '겹쳐 부를수록 2.5 kHz 가 쌓입니다. 쌓일 때만 내립니다',
                params: { freqHz: 2500, q: 2, thresholdDb: -28, rangeDb: -4 } },
    perc:     { note: '탬버린의 6 kHz 가 한 번씩 찌릅니다',
                params: { freqHz: 6000, q: 2.5, thresholdDb: -20, rangeDb: -6 } },
    brass:    { note: '세게 불 때만 3 kHz 가 쏩니다 — 정확히 그때만',
                params: { freqHz: 3000, q: 1.4, thresholdDb: -18, rangeDb: -6 } },
    winds:    { note: '숨소리 5.5 kHz 를 들릴 때만 누릅니다',
                params: { freqHz: 5500, q: 2.2, thresholdDb: -24, rangeDb: -4 } },
    fx:       { note: '임팩트의 180 Hz 가 킥을 밀어냅니다',
                params: { freqHz: 180, q: 1, thresholdDb: -30, rangeDb: -8 } },
    vocal:    { note: '낮은 음을 세게 부를 때만 350 Hz 가 부풉니다. 그때만 내립니다',
                params: { freqHz: 350, q: 1.8, thresholdDb: -26, rangeDb: -5 } },
    drumloop: { note: '350 Hz 가 세게 칠 때만 눌러줍니다. 루프의 박스 울림',
                params: { freqHz: 350, q: 1.4, thresholdDb: -22, rangeDb: -5 } },
    bass:     { note: '90 Hz 저음 노트만 튀는 걸 잡습니다. 고정 EQ 로는 못 하는 일입니다',
                params: { freqHz: 90, q: 1.8, thresholdDb: -18, rangeDb: -6 } },
    egtr:     { note: '900 Hz 헝크가 세게 칠 때만 깎습니다. 늘 깎으면 얇아집니다',
                params: { freqHz: 900, q: 2.2, thresholdDb: -24, rangeDb: -5.5 } },
    agtr:     { note: '200 Hz 붐은 세게 칠 때만 나옵니다. 다이내믹 EQ 가 정답인 대표 사례',
                params: { freqHz: 200, q: 2, thresholdDb: -26, rangeDb: -7 } },
    piano:    { note: '250 Hz 저음 화음에서만 눌러줍니다. 고역은 그대로 둡니다',
                params: { freqHz: 250, q: 1.6, thresholdDb: -24, rangeDb: -4 } },
    strings:  { note: '7.5 kHz 활 소리가 세질 때만. 스트링 디에서라고 봐도 됩니다',
                params: { freqHz: 7500, q: 2.4, thresholdDb: -30, rangeDb: -6 } },
    synth:    { note: '4.5 kHz 톱니 거슬림이 튈 때만 잡습니다',
                params: { freqHz: 4500, q: 2, thresholdDb: -26, rangeDb: -6.5 } },
  }),

  ...inst('exciter', {
    backing:  { note: '10 kHz 공기만. 백킹에 중역 배음을 더하면 리드와 싸웁니다',
                params: { amount: 0.22, freqHz: 10000, mix: 0.2 } },
    perc:     { note: '7 kHz 를 만들어 작은 스피커에서도 셰이커가 들리게 합니다',
                params: { amount: 0.35, freqHz: 7000, mix: 0.3 } },
    brass:    { note: '금관은 배음이 이미 많습니다. 아주 조금만',
                params: { amount: 0.18, freqHz: 6000, mix: 0.15 } },
    winds:    { note: '8.5 kHz 를 살짝 — 숨소리 대역은 피합니다',
                params: { amount: 0.2, freqHz: 8500, mix: 0.12 } },
    fx:       { note: '5 kHz 를 세게. 효과음에서는 과한 쪽이 맞습니다',
                params: { amount: 0.45, freqHz: 5000, mix: 0.4 } },
    vocal:    { note: '9 kHz 를 만들어 냅니다. 테이프 시대의 보컬 광택이 여기서 나옵니다',
                params: { amount: 0.3, freqHz: 9000, mix: 0.22 } },
    drumloop: { note: '6 kHz 에 살짝. 심벌이 이미 밝으니 많이 넣으면 지저분해집니다',
                params: { amount: 0.3, freqHz: 6000, mix: 0.25 } },
    bass:     { note: '2 kHz 하모닉스를 만들어 작은 스피커에서 들리게 합니다. 베이스에서 제일 쓸모 있는 장치',
                params: { amount: 0.5, freqHz: 2000, mix: 0.35 } },
    egtr:     { note: '4 kHz 프레즌스. 앰프 위쪽은 어차피 비어 있으니 조금만',
                params: { amount: 0.35, freqHz: 4000, mix: 0.22 } },
    agtr:     { note: '9 kHz — 통기타는 여기가 성격입니다. 가장 많이 넣어도 되는 악기',
                params: { amount: 0.55, freqHz: 9000, mix: 0.4 } },
    piano:    { note: '8 kHz 아주 조금. 피아노는 이미 배음이 많습니다',
                params: { amount: 0.25, freqHz: 8000, mix: 0.18 } },
    strings:  { note: '거의 넣지 않습니다 — 스트링에 고역을 더하면 활 소리만 커집니다',
                params: { amount: 0.15, freqHz: 10000, mix: 0.12 } },
    synth:    { note: '3 kHz. 신스는 이미 밝은 경우가 많아 낮은 쪽에 넣습니다',
                params: { amount: 0.3, freqHz: 3000, mix: 0.2 } },
  }),

  // ══ Dynamics ═══════════════════════════════════════════════════════════════

  ...inst('comp', {
    backing:  { note: '리드보다 세게, 더 빠르게 — 백킹은 고르게 깔려 있어야 합니다',
                params: { thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 80, makeupDb: 6 } },
    perc:     { note: '한 번씩 튀는 타격만. 릴리즈를 짧게 둬야 다음 타가 살아납니다',
                params: { thresholdDb: -16, ratio: 3.5, kneeDb: 3, attackMs: 2, releaseMs: 60, makeupDb: 3 } },
    brass:    { note: '금관은 눌릴수록 기계처럼 들립니다. 피크만 잡습니다',
                params: { thresholdDb: -18, ratio: 2.8, kneeDb: 10, attackMs: 18, releaseMs: 180, makeupDb: 3 } },
    winds:    { note: '여리게 부는 구간을 들리게 하는 정도. 어택은 느리게',
                params: { thresholdDb: -24, ratio: 2.4, kneeDb: 12, attackMs: 25, releaseMs: 220, makeupDb: 2.5 } },
    fx:       { note: '효과음은 압축하는 것이 아닙니다. 안전장치 수준으로만',
                params: { thresholdDb: -12, ratio: 2, kneeDb: 8, attackMs: 30, releaseMs: 400, makeupDb: 1 } },
    vocal:    { note: '속삭임과 벨팅이 한 줄에 있습니다. 자음을 잡을 만큼 빠르게(6 ms), 먹지 않을 만큼만',
                params: { thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 6, releaseMs: 90, makeupDb: 5 } },
    drumloop: { note: '어택 25 ms — 그보다 빠르면 스틱 소리를 먹습니다. 릴리스는 다음 박 전에 풀리게',
                params: { thresholdDb: -18, ratio: 4, kneeDb: 4, attackMs: 25, releaseMs: 90, makeupDb: 4 } },
    bass:     { note: '느린 어택으로 픽을 살리고 긴 릴리스로 서스테인을 고릅니다. 세게 걸어도 되는 악기',
                params: { thresholdDb: -22, ratio: 6, kneeDb: 6, attackMs: 35, releaseMs: 260, makeupDb: 6 } },
    egtr:     { note: '앰프가 이미 압축합니다. 여기서는 정리만',
                params: { thresholdDb: -16, ratio: 3, kneeDb: 8, attackMs: 15, releaseMs: 150, makeupDb: 3 } },
    agtr:     { note: '가볍게 — 통기타를 세게 누르면 플라스틱이 됩니다',
                params: { thresholdDb: -14, ratio: 2.5, kneeDb: 10, attackMs: 20, releaseMs: 180, makeupDb: 2.5 } },
    piano:    { note: '2:1. 피아노는 다이내믹이 연주 자체라 안 거는 것도 정답입니다',
                params: { thresholdDb: -12, ratio: 2, kneeDb: 12, attackMs: 30, releaseMs: 300, makeupDb: 2 } },
    strings:  { note: '활은 수십 ms 에 걸쳐 시작합니다. 어택을 빠르게 해도 잡을 트랜지언트가 없습니다',
                params: { thresholdDb: -15, ratio: 2.5, kneeDb: 12, attackMs: 60, releaseMs: 400, makeupDb: 2.5 } },
    synth:    { note: '신스는 레벨이 이미 일정합니다. 압축은 붙임성을 위한 것이지 레벨을 위한 게 아닙니다',
                params: { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 12, releaseMs: 120, makeupDb: 3.5 } },
  }),

  ...inst('ducker', {
    backing:  { note: '리드가 들어오면 비켜줍니다 — 이 장치의 교과서적 용도입니다',
                params: { thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 220, makeupDb: 0 } },
    perc:     { note: '킥에 맞춰 살짝 물러납니다',
                params: { thresholdDb: -20, ratio: 3.5, attackMs: 9, releaseMs: 150, makeupDb: 0 } },
    brass:    { note: '섹션이 보컬을 덮지 않게, 느리게 들어가고 느리게 풀립니다',
                params: { thresholdDb: -21, ratio: 3.2, attackMs: 30, releaseMs: 240, makeupDb: 0 } },
    winds:    { note: '가장 느리게 — 목관이 급하게 물러나면 들립니다',
                params: { thresholdDb: -27, ratio: 2.6, attackMs: 40, releaseMs: 420, makeupDb: 0 } },
    fx:       { note: '보컬이 들어오면 크게 비킵니다. 효과음은 양보해도 됩니다',
                params: { thresholdDb: -18, ratio: 6, attackMs: 9, releaseMs: 400, makeupDb: 0 } },
    vocal:    { note: '보통은 보컬이 키가 되어 다른 트랙을 누릅니다. 보컬 자신을 누를 때는 얕게',
                params: { thresholdDb: -28, ratio: 2.5, attackMs: 15, releaseMs: 300, makeupDb: 0 } },
    drumloop: { note: '루프 자체를 덕킹할 일은 드뭅니다. 보컬에 살짝 자리를 내주는 정도',
                params: { thresholdDb: -26, ratio: 3, attackMs: 15, releaseMs: 180, makeupDb: 0 } },
    bass:     { note: '킥에 눌리게 하는 고전적 용법. 릴리스를 템포에 맞추세요',
                params: { thresholdDb: -30, ratio: 8, attackMs: 9, releaseMs: 140, makeupDb: 2 } },
    egtr:     { note: '보컬 들어올 때만 물러납니다. 기타 레이어가 두꺼울 때',
                params: { thresholdDb: -28, ratio: 4, attackMs: 20, releaseMs: 260, makeupDb: 0 } },
    agtr:     { note: '아주 약하게 — 티 나면 실패입니다',
                params: { thresholdDb: -24, ratio: 2.5, attackMs: 25, releaseMs: 300, makeupDb: 0 } },
    piano:    { note: '보컬 구간에서만 살짝 내려갑니다. 피아노 반주의 기본 처리',
                params: { thresholdDb: -26, ratio: 3, attackMs: 30, releaseMs: 350, makeupDb: 0 } },
    strings:  { note: '느리게 들어가고 느리게 나옵니다. 패드성 소스는 급하게 움직이면 들킵니다',
                params: { thresholdDb: -30, ratio: 3.5, attackMs: 60, releaseMs: 500, makeupDb: 0 } },
    synth:    { note: 'EDM 펌핑. 킥마다 크게 눌리고 빠르게 돌아옵니다',
                params: { thresholdDb: -34, ratio: 10, attackMs: 9, releaseMs: 110, makeupDb: 2 } },
  }),

  ...inst('limiter', {
    backing:  { note: '스택 전체의 피크를 한 번에 잡습니다',
                params: { ceilingDb: -1.5, lookaheadMs: 2, releaseMs: 55 } },
    perc:     { note: '타격은 룩어헤드를 짧게 둬야 둔해지지 않습니다',
                params: { ceilingDb: -2, lookaheadMs: 1, releaseMs: 35 } },
    brass:    { note: '금관의 피크는 깁니다. 룩어헤드를 길게',
                params: { ceilingDb: -1.5, lookaheadMs: 5, releaseMs: 120 } },
    winds:    { note: '가장 느리게 — 목관에서 리미터가 들리면 실패입니다',
                params: { ceilingDb: -2.5, lookaheadMs: 7, releaseMs: 180 } },
    fx:       { note: '임팩트의 천장만 정합니다',
                params: { ceilingDb: -0.5, lookaheadMs: 4, releaseMs: 260 } },
    vocal:    { note: '컴프 뒤에 남은 한두 개의 피크만. 보컬에 리미터는 안전장치입니다',
                params: { ceilingDb: -1, lookaheadMs: 3, releaseMs: 80 } },
    drumloop: { note: '룩어헤드를 길게 — 드럼 피크는 리미터가 미리 봐야 잡힙니다',
                params: { ceilingDb: -1, lookaheadMs: 5, releaseMs: 60 } },
    bass:     { note: '릴리스를 길게. 짧으면 저음에서 펌핑이 들립니다',
                params: { ceilingDb: -1.5, lookaheadMs: 3, releaseMs: 220 } },
    egtr:     { note: '트랙 안전장치로만. 기타는 이미 압축돼 들어옵니다',
                params: { ceilingDb: -1, lookaheadMs: 2, releaseMs: 100 } },
    agtr:     { note: '피크만 막습니다. 통기타에 리미터가 들리면 너무 건 겁니다',
                params: { ceilingDb: -2, lookaheadMs: 4, releaseMs: 150 } },
    piano:    { note: '−3 dB 로 여유를 크게. 포르티시모만 막는 용도',
                params: { ceilingDb: -3, lookaheadMs: 6, releaseMs: 200 } },
    strings:  { note: '긴 릴리스. 스트링에서 빠른 릴리스는 활 소리를 흔듭니다',
                params: { ceilingDb: -2, lookaheadMs: 5, releaseMs: 300 } },
    synth:    { note: '짧은 릴리스로 밀도를 올립니다. 신스는 펌핑이 잘 안 들립니다',
                params: { ceilingDb: -1, lookaheadMs: 1.5, releaseMs: 45 } },
  }),

  ...inst('gate', {
    backing:  { note: '구절 사이를 리드보다 조금 더 닫습니다',
                params: { thresholdDb: -46, rangeDb: 16, attackMs: 9, releaseMs: 200 } },
    perc:     { note: '오버더빙한 퍼커션은 블리드가 없습니다. 깊게 닫아도 됩니다',
                params: { thresholdDb: -34, rangeDb: 24, attackMs: 9, releaseMs: 85 } },
    brass:    { note: '섹션 사이의 숨과 키 노이즈만',
                params: { thresholdDb: -44, rangeDb: 10, attackMs: 12, releaseMs: 300 } },
    winds:    { note: '목관을 게이트하는 건 대개 실수입니다. 아주 얕게',
                params: { thresholdDb: -50, rangeDb: 8, attackMs: 15, releaseMs: 400 } },
    fx:       { note: '꼬리를 자르지 않도록 가장 길게 엽니다',
                params: { thresholdDb: -60, rangeDb: 4, attackMs: 20, releaseMs: 800 } },
    vocal:    { note: '숨소리를 지우면 사람이 아니게 됩니다. 12 dB 만 내립니다',
                params: { thresholdDb: -48, rangeDb: 12, attackMs: 9, releaseMs: 250 } },
    drumloop: { note: '루프는 붙어 있는 소리라 얕게만. 레인지를 깊게 주면 리듬이 끊깁니다',
                params: { thresholdDb: -40, rangeDb: 12, attackMs: 9, releaseMs: 120 } },
    bass:     { note: '연주 사이 앰프 험만 잡습니다. 릴리스를 길게 해야 음이 안 잘립니다',
                params: { thresholdDb: -52, rangeDb: 18, attackMs: 9, releaseMs: 400 } },
    egtr:     { note: '하이게인 기타의 노이즈 게이트. 이 악기에서 가장 자주 쓰입니다',
                params: { thresholdDb: -46, rangeDb: 35, attackMs: 9, releaseMs: 180 } },
    agtr:     { note: '거의 쓰지 않습니다 — 통기타의 여운을 자르면 바로 티가 납니다',
                params: { thresholdDb: -60, rangeDb: 8, attackMs: 9, releaseMs: 700 } },
    piano:    { note: '페달 여운이 있으니 아주 낮게, 아주 얕게',
                params: { thresholdDb: -64, rangeDb: 6, attackMs: 10, releaseMs: 900 } },
    strings:  { note: '스트링에 게이트는 대체로 오답입니다. 무대 노이즈만 겨우 잡는 값',
                params: { thresholdDb: -68, rangeDb: 5, attackMs: 20, releaseMs: 1200 } },
    synth:    { note: '리듬 게이트로 씁니다. 깊고 빠르게 — 신스는 잘라도 자연스러움을 잃지 않습니다',
                params: { thresholdDb: -34, rangeDb: 45, attackMs: 9, releaseMs: 60 } },
  }),

  ...inst('mbcomp', {
    backing:  { note: '치찰음 대역을 따로 더 세게 — 겹쳐 부르면 그것도 겹칩니다',
                params: { lowXHz: 220, highXHz: 4500, lowThrDb: -22, lowRatio: 3, midThrDb: -20, midRatio: 3.5,
                          hiThrDb: -22, hiRatio: 4, makeupDb: 4 } },
    perc:     { note: '고역만 눌러 찌르는 타격을 고릅니다',
                params: { lowXHz: 250, highXHz: 5000, lowThrDb: -16, lowRatio: 2, midThrDb: -16, midRatio: 2.5,
                          hiThrDb: -18, hiRatio: 3, makeupDb: 2.5 } },
    brass:    { note: '3.5 kHz 위만 — 금관의 거친 곳은 언제나 거기입니다',
                params: { lowXHz: 200, highXHz: 3500, lowThrDb: -18, lowRatio: 2.2, midThrDb: -16, midRatio: 2.5,
                          hiThrDb: -18, hiRatio: 3, makeupDb: 2 } },
    winds:    { note: '전 대역을 얕게. 목관은 대역마다 다르게 다루면 부자연스럽습니다',
                params: { lowXHz: 180, highXHz: 4000, lowThrDb: -20, lowRatio: 2, midThrDb: -18, midRatio: 2.2,
                          hiThrDb: -20, hiRatio: 2.6, makeupDb: 2 } },
    fx:       { note: '거의 걸지 않습니다. 효과음의 다이내믹이 곧 효과입니다',
                params: { lowXHz: 150, highXHz: 3000, lowThrDb: -14, lowRatio: 1.8, midThrDb: -14, midRatio: 2,
                          hiThrDb: -14, hiRatio: 2.2, makeupDb: 1 } },
    vocal:    { note: '치찰음 대역만 더 세게. 4 kHz 위를 따로 누르는 것이 보컬에서 멀티밴드를 쓰는 이유입니다',
                params: { lowXHz: 200, highXHz: 4000, lowThrDb: -20, lowRatio: 2.5, midThrDb: -18, midRatio: 3,
                          hiThrDb: -20, hiRatio: 3.5, makeupDb: 3 } },
    drumloop: { note: '저역만 세게 — 킥을 고르고 심벌은 거의 두 손 들고 놔둡니다',
                params: { lowXHz: 140, highXHz: 3500, lowThrDb: -24, lowRatio: 4,
                          midThrDb: -18, midRatio: 2.5, hiThrDb: -14, hiRatio: 2, makeupDb: 3 } },
    bass:     { note: '크로스오버를 낮게 잡고 저역을 강하게. 고역은 손댈 게 없습니다',
                params: { lowXHz: 110, highXHz: 2000, lowThrDb: -28, lowRatio: 6,
                          midThrDb: -22, midRatio: 3.5, hiThrDb: -12, hiRatio: 1.5, makeupDb: 4 } },
    egtr:     { note: '중역 위주. 앰프 대역이 곧 중역입니다',
                params: { lowXHz: 200, highXHz: 3000, lowThrDb: -10, lowRatio: 1.5,
                          midThrDb: -20, midRatio: 3.5, hiThrDb: -16, hiRatio: 2, makeupDb: 2.5 } },
    agtr:     { note: '저역 붐만 눌러주고 나머지는 거의 통과',
                params: { lowXHz: 250, highXHz: 4000, lowThrDb: -26, lowRatio: 3.5,
                          midThrDb: -12, midRatio: 1.8, hiThrDb: -14, hiRatio: 2, makeupDb: 2 } },
    piano:    { note: '세 대역 모두 아주 약하게. 멀티밴드가 피아노를 망치는 건 순식간입니다',
                params: { lowXHz: 180, highXHz: 3000, lowThrDb: -18, lowRatio: 2,
                          midThrDb: -14, midRatio: 1.8, hiThrDb: -12, hiRatio: 1.8, makeupDb: 1.5 } },
    strings:  { note: '고역만 눌러 활 소리를 다스립니다. 사실상 광대역 디에서',
                params: { lowXHz: 160, highXHz: 5000, lowThrDb: -10, lowRatio: 1.5,
                          midThrDb: -12, midRatio: 1.8, hiThrDb: -26, hiRatio: 4, makeupDb: 1.5 } },
    synth:    { note: '저역을 묶어 베이스 자리를 지키고 고역을 조여 밀도를 올립니다',
                params: { lowXHz: 200, highXHz: 3200, lowThrDb: -26, lowRatio: 5,
                          midThrDb: -20, midRatio: 3, hiThrDb: -20, hiRatio: 3, makeupDb: 3.5 } },
  }),

  ...inst('clipper', {
    backing:  { note: '스택의 뾰족한 몇 샘플만',
                params: { driveDb: 2, ceilingDb: -1.5, hardness: 0.38 } },
    perc:     { note: '타격의 머리를 둥글려 리미터가 일하지 않게 합니다',
                params: { driveDb: 1.9, ceilingDb: -1.4, hardness: 0.58 } },
    brass:    { note: '금관의 피크는 클리퍼가 가장 깔끔합니다',
                params: { driveDb: 3.6, ceilingDb: -2.6, hardness: 0.34 } },
    winds:    { note: '클리퍼는 스트링과 목관에서 거의 쓸 일이 없습니다',
                params: { driveDb: 0.4, ceilingDb: -4, hardness: 0.08 } },
    fx:       { note: '임팩트는 잘려도 됩니다. 오히려 더 큽니다',
                params: { driveDb: 3.5, ceilingDb: -0.5, hardness: 0.6 } },
    vocal:    { note: '자음 끝의 뾰족한 몇 샘플만 둥글립니다. 들리면 너무 많이 넣은 것입니다',
                params: { driveDb: 1.2, ceilingDb: -1, hardness: 0.25 } },
    drumloop: { note: '가장 단단하게 — 드럼 피크를 깎아 리미터 부담을 덜어줍니다',
                params: { driveDb: 4.5, ceilingDb: -1, hardness: 0.8 } },
    bass:     { note: '부드럽게 — 베이스를 하드 클립하면 저역이 지저분해집니다',
                params: { driveDb: 3.5, ceilingDb: -1.5, hardness: 0.4 } },
    egtr:     { note: '앰프의 연장선. 부드럽게 걸면 게인이 늘어난 것처럼 들립니다',
                params: { driveDb: 6, ceilingDb: -1, hardness: 0.5 } },
    agtr:     { note: '피크 안전장치로만. 스트럼 피크는 조금 깎아도 견딥니다',
                params: { driveDb: 2, ceilingDb: -2, hardness: 0.3 } },
    piano:    { note: '여기서 가장 약하게 — 해머 어택을 클립하면 피아노가 뭉갭니다',
                params: { driveDb: 0.8, ceilingDb: -3, hardness: 0.18 } },
    strings:  { note: '스트링에는 사실상 필요 없습니다. 최소값에 가깝게 둡니다',
                params: { driveDb: 0.5, ceilingDb: -2, hardness: 0.12 } },
    synth:    { note: '가장 세게. 신스 리드는 클리핑이 곧 성격이 됩니다',
                params: { driveDb: 7.5, ceilingDb: -1, hardness: 0.7 } },
  }),

  ...inst('mbwidth', {
    backing:  { note: '고역만 넓게. 몸통이 넓어지면 리드와 섞입니다',
                params: { lowXHz: 220, highXHz: 4000, lowWidth: 0.3, midWidth: 1.4, hiWidth: 1.6 } },
    perc:     { note: '중고역을 펼칩니다. 퍼커션은 넓을수록 리듬이 커집니다',
                params: { lowXHz: 250, highXHz: 5000, lowWidth: 0.5, midWidth: 1.2, hiWidth: 1.45 } },
    brass:    { note: '섹션은 한 덩어리로 — 거의 넓히지 않습니다',
                params: { lowXHz: 200, highXHz: 3500, lowWidth: 0.6, midWidth: 1.1, hiWidth: 1.2 } },
    winds:    { note: '아주 조금만. 목관은 넓히면 실체가 사라집니다',
                params: { lowXHz: 180, highXHz: 4000, lowWidth: 0.7, midWidth: 1.15, hiWidth: 1.25 } },
    fx:       { note: '전 대역을 넓게. 여기서만큼은 과한 것이 맞습니다',
                params: { lowXHz: 150, highXHz: 3000, lowWidth: 0.9, midWidth: 1.6, hiWidth: 1.8 } },
    vocal:    { note: '몸통은 모노, 공기만 넓게. 리드 보컬을 넓히면 폰 스피커에서 가수가 사라집니다',
                params: { lowXHz: 200, highXHz: 5000, lowWidth: 0, midWidth: 1, hiWidth: 1.2 } },
    drumloop: { note: '킥은 가운데, 오버헤드는 넓게 — 한 스테레오 루프에서 둘을 나눕니다',
                params: { lowXHz: 200, highXHz: 3000, lowWidth: 0, midWidth: 1, hiWidth: 1.5 } },
    bass:     { note: '베이스는 전부 가운데입니다. 이 장치로 할 일은 그것을 확인하는 것뿐',
                params: { lowXHz: 300, highXHz: 2000, lowWidth: 0, midWidth: 0.5, hiWidth: 0.8 } },
    egtr:     { note: '더블 트랙을 더 벌립니다. 몸통은 가운데 남겨두고',
                params: { lowXHz: 160, highXHz: 2500, lowWidth: 0.4, midWidth: 1.15, hiWidth: 1.5 } },
    agtr:     { note: '통울림은 가운데, 줄 소리만 넓게',
                params: { lowXHz: 140, highXHz: 3500, lowWidth: 0.3, midWidth: 1.1, hiWidth: 1.4 } },
    piano:    { note: '피아노는 넓게 녹음됩니다 — 낮은 현만 모아줍니다',
                params: { lowXHz: 180, highXHz: 4000, lowWidth: 0.2, midWidth: 1, hiWidth: 1.15 } },
    strings:  { note: '섹션은 넓을수록 섹션처럼 들립니다. 콘트라베이스 자리만 붙잡고',
                params: { lowXHz: 120, highXHz: 2200, lowWidth: 0.25, midWidth: 1.25, hiWidth: 1.6 } },
    synth:    { note: '유니즌 신스는 이미 넓습니다 — 저역을 모아 자리를 되찾습니다',
                params: { lowXHz: 220, highXHz: 3000, lowWidth: 0, midWidth: 1, hiWidth: 1.2 } },
  }),

  ...inst('upward', {
    backing:  { note: '작은 화음까지 들리게 올립니다',
                params: { thresholdDb: -36, ratio: 2.4, depthDb: 7, floorDb: -58, attackMs: 90, releaseMs: 650 } },
    perc:     { note: '약하게 친 타격을 올립니다 — 퍼커션의 생명은 고른 셈여림입니다',
                params: { thresholdDb: -32, ratio: 2.6, depthDb: 5, floorDb: -50, attackMs: 40, releaseMs: 300 } },
    brass:    { note: '여린 구간만 올립니다. 금관은 아래에서 올리는 쪽이 자연스럽습니다',
                params: { thresholdDb: -30, ratio: 2, depthDb: 5, floorDb: -52, attackMs: 120, releaseMs: 800 } },
    winds:    { note: '가장 느리게 올립니다 — 목관의 셈여림은 음악입니다',
                params: { thresholdDb: -34, ratio: 2.2, depthDb: 8, floorDb: -56, attackMs: 160, releaseMs: 900 } },
    fx:       { note: '꼬리를 끌어올려 길게 들리게 합니다',
                params: { thresholdDb: -28, ratio: 3, depthDb: 10, floorDb: -60, attackMs: 200, releaseMs: 1200 } },
    vocal:    { note: '작은 자음을 올립니다. 아래에서 올리는 쪽이 위를 누르는 것보다 가사에 낫습니다',
                params: { thresholdDb: -34, ratio: 2.2, depthDb: 6, floorDb: -55, attackMs: 100, releaseMs: 700 } },
    drumloop: { note: '고스트 노트를 들어올립니다. 어택을 늦춰 메인 히트는 건드리지 않게',
                params: { thresholdDb: -30, ratio: 2.4, depthDb: 6, floorDb: -58,
                          attackMs: 60, releaseMs: 200 } },
    bass:     { note: '느리게 5 dB — 음과 음 사이가 꺼지지 않으면 베이스는 그것만으로 커집니다',
                params: { thresholdDb: -24, ratio: 2, depthDb: 5, floorDb: -54,
                          attackMs: 120, releaseMs: 600 } },
    egtr:     { note: '코드 꼬리를 받칩니다. 플로어는 픽업 험 위에',
                params: { thresholdDb: -26, ratio: 2.2, depthDb: 5, floorDb: -50,
                          attackMs: 70, releaseMs: 450 } },
    agtr:     { note: '핑거피킹의 약한 음만. 플로어를 −48 dB 로 올려 프렛 잡음을 두고 갑니다',
                params: { thresholdDb: -28, ratio: 2, depthDb: 4, floorDb: -48,
                          attackMs: 50, releaseMs: 400 } },
    piano:    { note: '이 장치가 가장 잘 하는 일 — 해머가 지나간 뒤의 감쇠를 붙잡습니다',
                params: { thresholdDb: -30, ratio: 2.8, depthDb: 8, floorDb: -60,
                          attackMs: 140, releaseMs: 900 } },
    strings:  { note: '아주 느리게. 활이 바뀌는 지점이 메워집니다',
                params: { thresholdDb: -32, ratio: 2.2, depthDb: 6, floorDb: -58,
                          attackMs: 200, releaseMs: 1100 } },
    synth:    { note: '가장 적게. 신스는 이미 엔벨로프가 시킨 대로 울립니다',
                params: { thresholdDb: -24, ratio: 1.6, depthDb: 2.5, floorDb: -52,
                          attackMs: 80, releaseMs: 500 } },
  }),

  ...inst('transient', {
    backing:  { note: '자음의 머리를 깎아 리드의 자음과 겹치지 않게 합니다',
                params: { attack: -0.1, sustain: 0.15, mix: 0.5 } },
    perc:     { note: '이 장치가 가장 잘 맞는 소스입니다. 손이 닿는 순간을 세웁니다',
                params: { attack: 0.65, sustain: -0.5, mix: 1 } },
    brass:    { note: '혀를 치는 순간만 살짝',
                params: { attack: 0.4, sustain: -0.25, mix: 0.85 } },
    winds:    { note: '목관에는 세울 트랜지언트가 거의 없습니다. 서스테인만 조금',
                params: { attack: 0.1, sustain: 0.2, mix: 0.6 } },
    fx:       { note: '머리를 죽이고 꼬리를 키웁니다 — 라이저가 되는 방향입니다',
                params: { attack: -0.3, sustain: 0.5, mix: 0.9 } },
    vocal:    { note: '파열음의 머리를 살짝 깎고 꼬리를 남깁니다. 보컬에서는 어택을 키우는 장치가 아닙니다',
                params: { attack: -0.15, sustain: 0.1, mix: 0.6 } },
    drumloop: { note: '어택을 올리고 서스테인을 줄이면 루프가 방에서 나옵니다',
                params: { attack: 0.45, sustain: -0.3, mix: 1 } },
    bass:     { note: '서스테인을 올려 길이를 만듭니다. 어택은 건드리지 않습니다',
                params: { attack: 0.1, sustain: 0.35, mix: 1 } },
    egtr:     { note: '피킹만 살짝 올립니다 — 앰프가 이미 트랜지언트를 눌러놓았습니다',
                params: { attack: 0.25, sustain: -0.1, mix: 1 } },
    agtr:     { note: '피크 소리를 살리고 통울림 꼬리를 줄입니다',
                params: { attack: 0.35, sustain: -0.25, mix: 1 } },
    piano:    { note: '해머를 살짝. 피아노는 서스테인이 곧 페달이라 건드리지 않습니다',
                params: { attack: 0.2, sustain: 0, mix: 0.8 } },
    strings:  { note: '어택을 오히려 낮춰 더 부드럽게. 스트링에서 어택을 올리면 거칠어집니다',
                params: { attack: -0.2, sustain: 0.25, mix: 0.7 } },
    synth:    { note: '어택을 올려 엔벨로프에 각을 세웁니다',
                params: { attack: 0.4, sustain: -0.15, mix: 1 } },
  }),

  ...inst('deesser', {
    backing:  { note: '네 겹으로 부르면 치찰음도 네 겹입니다 — 리드 다음으로 깊게',
                params: { freqHz: 7200, thresholdDb: -32, amount: 0.48 } },
    perc:     { note: '탬버린과 셰이커의 9 kHz 를 얕게 눌러줍니다',
                params: { freqHz: 9500, thresholdDb: -26, amount: 0.18 } },
    brass:    { note: '4 kHz 의 쏘는 소리를 디에서로 잡는 것이 EQ 보다 자연스럽습니다',
                params: { freqHz: 4200, thresholdDb: -18, amount: 0.12 } },
    winds:    { note: '숨소리 5.5 kHz 만 — 음을 건드리면 안 됩니다',
                params: { freqHz: 5500, thresholdDb: -22, amount: 0.25 } },
    fx:       { note: '거의 쓰지 않습니다. 쓰더라도 아주 얕게',
                params: { freqHz: 8000, thresholdDb: -18, amount: 0.1 } },
    vocal:    { note: '이 장치가 존재하는 이유가 보컬입니다. 7 kHz, 이 파일에서 가장 깊게',
                params: { freqHz: 7000, thresholdDb: -28, amount: 0.5 } },
    drumloop: { note: '하이햇이 쏠 때. 8 kHz 에서 가볍게',
                params: { freqHz: 8000, thresholdDb: -22, amount: 0.3 } },
    bass:     { note: '베이스에 디에서는 거의 필요 없습니다. 픽 노이즈용 최소값',
                params: { freqHz: 3000, thresholdDb: -16, amount: 0.15 } },
    egtr:     { note: '픽 어택이 쏠 때 4 kHz 에서',
                params: { freqHz: 4000, thresholdDb: -20, amount: 0.25 } },
    agtr:     { note: '핑거 스퀵과 피크 노이즈. 통기타에서 실제로 쓸모 있습니다',
                params: { freqHz: 6000, thresholdDb: -26, amount: 0.4 } },
    piano:    { note: '5 kHz 해머 노이즈가 거슬릴 때만',
                params: { freqHz: 5000, thresholdDb: -22, amount: 0.22 } },
    strings:  { note: '로진 노이즈를 겨냥합니다. 스트링의 디에서는 7.5 kHz 입니다',
                params: { freqHz: 7500, thresholdDb: -28, amount: 0.45 } },
    synth:    { note: '9 kHz 하이엔드가 쏠 때. 신스는 대역이 넓어 높게 잡습니다',
                params: { freqHz: 9000, thresholdDb: -24, amount: 0.3 } },
  }),

  // ══ Saturation ═════════════════════════════════════════════════════════════

  ...inst('saturation', {
    backing:  { note: '리드와 같은 질감을 주되 더 얕게',
                params: { driveDb: 3, mix: 0.36, bias: 0 } },
    perc:     { note: '배음을 더해 작은 스피커에서 퍼커션이 사라지지 않게 합니다',
                params: { driveDb: 4.4, mix: 0.46, bias: 0.05 } },
    brass:    { note: '금관은 새추레이션과 가장 잘 맞는 소스입니다',
                params: { driveDb: 7, mix: 0.42, bias: 0.12 } },
    winds:    { note: '아주 조금만 — 목관의 배음은 이미 복잡합니다',
                params: { driveDb: 1.8, mix: 0.22, bias: 0 } },
    fx:       { note: '많이. 효과음에서 일그러짐은 재료입니다',
                params: { driveDb: 11, mix: 0.6, bias: 0.35 } },
    vocal:    { note: '드라이브는 낮게, 믹스는 높게 — 배음을 더하되 자음은 원본을 남깁니다',
                params: { driveDb: 4, mix: 0.3, bias: 0 } },
    drumloop: { note: '병렬로 살짝. 루프에 직렬 새츄레이션을 세게 걸면 트랜지언트가 죽습니다',
                params: { driveDb: 6, mix: 0.35, bias: 0 } },
    bass:     { note: '가장 중요한 장치입니다. 하모닉스가 있어야 폰 스피커에서 베이스가 들립니다',
                params: { driveDb: 10, mix: 0.6, bias: 0.15 } },
    egtr:     { note: '앰프 뒤에 또 거는 것이므로 조금만',
                params: { driveDb: 5, mix: 0.4, bias: 0 } },
    agtr:     { note: '아주 약하게. 통기타는 깨끗한 게 성격입니다',
                params: { driveDb: 3.5, mix: 0.24, bias: 0 } },
    piano:    { note: '거의 들리지 않을 만큼. 배음을 더하는 게 아니라 모서리만 둥글립니다',
                params: { driveDb: 2.2, mix: 0.16, bias: 0 } },
    strings:  { note: '여기서 가장 적게. 스트링은 왜곡이 붙으면 바로 싸구려가 됩니다',
                params: { driveDb: 1.2, mix: 0.08, bias: 0 } },
    synth:    { note: '세게 — 디지털 신스에 아날로그 성격을 붙이는 가장 빠른 방법',
                params: { driveDb: 8, mix: 0.5, bias: 0.25 } },
  }),

  ...inst('tube', {
    backing:  { note: '리드보다 얕게, 더 밝게',
                params: { drive: 0.2, bias: 0.08, toneHz: 11000, mix: 32, outDb: -0.5 } },
    perc:     { note: '튜브로 타격의 모서리를 둥글립니다',
                params: { drive: 0.3, bias: 0.12, toneHz: 9000, mix: 30, outDb: 0 } },
    brass:    { note: '놋쇠의 배음을 더합니다 — 이 장치가 금관에 쓰이는 이유입니다',
                params: { drive: 0.45, bias: 0.2, toneHz: 7000, mix: 55, outDb: -1 } },
    winds:    { note: '거의 들리지 않을 만큼만',
                params: { drive: 0.15, bias: 0.06, toneHz: 12000, mix: 25, outDb: 0 } },
    fx:       { note: '세게. 튜브가 효과음을 두껍게 만듭니다',
                params: { drive: 0.6, bias: 0.3, toneHz: 5000, mix: 70, outDb: -2 } },
    vocal:    { note: '10 kHz 로 튜브 광택만. 드라이브를 올리면 자음이 지저분해집니다',
                params: { drive: 0.25, bias: 0.1, toneHz: 10000, mix: 40, outDb: -0.5 } },
    drumloop: { note: '드라이브는 낮게, 톤은 열어둡니다. 루프의 고역을 죽이지 않기 위해',
                params: { drive: 0.3, bias: 0.12, toneHz: 11000, mix: 45, outDb: -1 } },
    bass:     { note: '바이어스를 올려 짝수 배음을 만듭니다. 베이스가 두꺼워지는 이유가 이것',
                params: { drive: 0.55, bias: 0.3, toneHz: 5000, mix: 75, outDb: -2 } },
    egtr:     { note: '앰프 성격을 더합니다. 톤을 6 kHz 로 닫아 히스를 막습니다',
                params: { drive: 0.45, bias: 0.2, toneHz: 6000, mix: 60, outDb: -1.5 } },
    agtr:     { note: '따뜻하게만. 톤은 활짝 열어둡니다',
                params: { drive: 0.22, bias: 0.1, toneHz: 14000, mix: 35, outDb: -0.5 } },
    piano:    { note: '아주 옅게. 진공관 색이 들리면 피아노가 아닙니다',
                params: { drive: 0.18, bias: 0.08, toneHz: 13000, mix: 28, outDb: -0.5 } },
    strings:  { note: '섹션에 약간의 몸통만. 톤을 닫으면 답답해집니다',
                params: { drive: 0.2, bias: 0.1, toneHz: 12000, mix: 30, outDb: -0.5 } },
    synth:    { note: '드라이브를 크게. 신스에 진공관은 효과가 아니라 필요입니다',
                params: { drive: 0.6, bias: 0.25, toneHz: 9000, mix: 70, outDb: -2 } },
  }),

  ...inst('bitcrush', {
    backing:  { note: '12 비트로 아주 살짝 — 로파이 더블의 질감',
                params: { bits: 14, mix: 28 } },
    perc:     { note: '8 비트 퍼커션은 드럼머신의 소리입니다',
                params: { bits: 8, mix: 52 } },
    brass:    { note: '5 비트 금관은 칩튠 팡파르가 됩니다 — 교정이 아니라 변신입니다',
                params: { bits: 5, mix: 36 } },
    winds:    { note: '목관에 비트크러시를 쓸 일은 거의 없습니다 — 쓴다면 다른 악기를 만드는 쪽입니다',
                params: { bits: 7, mix: 18 } },
    fx:       { note: '5 비트. 효과음에서는 부서질수록 좋습니다',
                params: { bits: 4, mix: 78 } },
    vocal:    { note: '보컬에 비트크러시는 효과입니다 — 11 비트, 낮은 믹스로 전화기 느낌만',
                params: { bits: 11, mix: 25 } },
    drumloop: { note: '12비트 — 샘플러 느낌만 냅니다. 낮추면 루프가 부서집니다',
                params: { bits: 12, mix: 45 } },
    bass:     { note: '베이스를 크러시하면 저역이 먼저 사라집니다. 15비트로 흔적만',
                params: { bits: 15, mix: 14 } },
    egtr:     { note: '10비트 로파이 기타. 병렬로 섞습니다',
                params: { bits: 10, mix: 40 } },
    agtr:     { note: '13비트. 로파이 어쿠스틱 루프의 그 바스락거림입니다',
                params: { bits: 13, mix: 22 } },
    piano:    { note: '로파이 피아노. 이 장치가 악기를 통째로 바꾸는 대표 사례',
                params: { bits: 9, mix: 55 } },
    strings:  { note: '사실상 끈 값 — 스트링에 비트 크러시는 활 소리만 거칠게 만듭니다',
                params: { bits: 16, mix: 10 } },
    synth:    { note: '6비트. 신스는 부서질수록 신스다워지는 유일한 악기입니다',
                params: { bits: 6, mix: 70 } },
  }),

  // ══ Modulation ═════════════════════════════════════════════════════════════

  ...inst('chorus', {
    backing:  { note: '백킹에 코러스는 더블을 더 두껍게 만드는 정석입니다',
                params: { rateHz: 0.45, depthMs: 3.5, delayMs: 25, mix: 35 } },
    perc:     { note: '빠르고 얕게 — 퍼커션이 흔들리면 박자가 흐려집니다',
                params: { rateHz: 1.2, depthMs: 1.5, delayMs: 12, mix: 15 } },
    brass:    { note: '섹션을 두 배로 들리게 하는 정도',
                params: { rateHz: 0.5, depthMs: 2.5, delayMs: 20, mix: 22 } },
    winds:    { note: '느리고 얕게. 목관의 비브라토와 싸우면 안 됩니다',
                params: { rateHz: 0.3, depthMs: 3, delayMs: 24, mix: 18 } },
    fx:       { note: '깊고 느리게. 흔들릴수록 효과음답습니다',
                params: { rateHz: 0.9, depthMs: 6, delayMs: 30, mix: 55 } },
    vocal:    { note: '더블링의 흉내입니다. 깊게 걸면 1980년대가 되고 가사는 흐려집니다',
                params: { rateHz: 0.35, depthMs: 1.8, delayMs: 22, mix: 14 } },
    drumloop: { note: '루프 전체에 코러스는 위상을 흔듭니다. 아주 얕게만',
                params: { rateHz: 0.4, depthMs: 1.5, delayMs: 14, mix: 15 } },
    bass:     { note: '저역이 흔들리면 모노에서 사라집니다. 깊이를 최소로',
                params: { rateHz: 0.3, depthMs: 1, delayMs: 12, mix: 12 } },
    egtr:     { note: '80년대 클린 기타. 이 악기가 코러스의 고향입니다',
                params: { rateHz: 0.7, depthMs: 5, delayMs: 20, mix: 45 } },
    agtr:     { note: '12현처럼 들리게 하는 값. 통기타 코러스의 고전적 용법',
                params: { rateHz: 0.5, depthMs: 3.5, delayMs: 16, mix: 30 } },
    piano:    { note: '전자 피아노 느낌. 어쿠스틱 피아노에는 안 어울립니다',
                params: { rateHz: 0.6, depthMs: 2.5, delayMs: 18, mix: 25 } },
    strings:  { note: '느리고 깊게 — 섹션 인원이 늘어난 것처럼 들립니다',
                params: { rateHz: 0.2, depthMs: 6, delayMs: 26, mix: 28 } },
    synth:    { note: '넓고 진하게. 신스 패드의 기본값이라고 봐도 됩니다',
                params: { rateHz: 0.45, depthMs: 7, delayMs: 22, mix: 55 } },
  }),

  ...inst('harmonizer', {
    backing:  { note: '화음을 만드는 것이 백킹의 일입니다. 이 장치의 본래 자리',
                params: { v1St: 12, v1Db: -12, v2Db: -16, spread: 0.7, windowMs: 35, mix: 0.35 } },
    perc:     { note: '5도 위를 아주 작게 — 퍼커션에서는 음정보다 질감입니다',
                params: { v1St: 7, v1Db: -24, v2Db: -60, spread: 0.5, windowMs: 20, mix: 0.1 } },
    brass:    { note: '5도를 더해 섹션을 두껍게 합니다',
                params: { v1St: 7, v1Db: -16, v2Db: -20, spread: 0.45, windowMs: 50, mix: 0.22 } },
    winds:    { note: '옥타브 위를 작게 — 플루트 더블의 고전적인 방법입니다',
                params: { v1St: 12, v1Db: -18, v2Db: -60, spread: 0.6, windowMs: 55, mix: 0.18 } },
    fx:       { note: '옥타브 아래를 크게. 효과음은 음정이 아니라 무게입니다',
                params: { v1St: -12, v1Db: -8, v2Db: -12, spread: 0.9, windowMs: 80, mix: 0.5 } },
    vocal:    { note: '한 옥타브 위를 아주 작게 — 들리면 안 되고, 꺼보면 비어야 합니다',
                params: { v1St: 12, v1Db: -20, v2Db: -60, spread: 0.55, windowMs: 30, mix: 0.14 } },
    drumloop: { note: '드럼에는 옥타브 아래를 아주 조금 — 하모나이저는 트랜지언트에서 '
                      + '스플라이스가 가장 잘 들리므로, 킥의 몸통만 두껍게 하고 빠집니다',
                params: { v1St: -12, v1Db: -16, v2Db: -60, spread: 0.2, windowMs: 130, mix: 0.12 } },
    bass:     { note: '베이스에 옥타브 위 — 아래로 내리면 이미 있는 곳에 겹쳐 뭉갭니다. '
                      + '창은 길게: 낮은 음일수록 한 주기가 길어서 짧은 창은 매번 주기 중간을 자릅니다',
                params: { v1St: 12, v1Db: -14, v2Db: -60, spread: 0.25, windowMs: 200, mix: 0.2 } },
    egtr:     { note: '일렉 기타에 5도 위 — 이 기기가 만들어진 이유 그 자체입니다',
                params: { v1St: 7, v1Db: -4, v2Db: -60, spread: 0.6, windowMs: 90, mix: 0.4 } },
    agtr:     { note: '통기타에 옥타브 위를 얇게 — 12현 흉내이지 화음이 아닙니다',
                params: { v1St: 12, v1Db: -12, v2Db: -60, spread: 0.7, windowMs: 90, mix: 0.25 } },
    piano:    { note: '피아노는 이미 화음이라 평행 3도가 거의 항상 틀립니다 — 옥타브만, 아주 얕게',
                params: { v1St: 12, v1Db: -18, v2Db: -60, spread: 0.4, windowMs: 45, mix: 0.12 } },
    strings:  { note: '현 섹션에 옥타브 위아래 — 인원을 늘리는 쪽이지 화성을 바꾸는 쪽이 아닙니다',
                params: { v1St: 12, v1Db: -14, v2St: -12, v2Db: -14, spread: 0.9, windowMs: 130, mix: 0.25 } },
    synth:    { note: '신스 리드에 5도와 옥타브를 세게 — 워블이 신스에서는 결점이 아니라 성격입니다',
                params: { v1St: 7, v1Db: -3, v2St: 12, v2Db: -5, spread: 0.8, windowMs: 85, mix: 0.5 } },
  }),
  ...inst('linphase', {
    backing:  { note: '위상이 돌지 않아야 리드와 겹쳐도 얇아지지 않습니다',
                params: { length: 2, lowDb: -1, lowHz: 150, b1Db: -2.5, b1Hz: 450, b1Q: 1.3,
                          b2Db: 1, b2Hz: 3500, b2Q: 0.9, highDb: 2.5 } },
    perc:     { note: '짧은 길이로 — 퍼커션에 지연을 더하면 박자가 밀립니다',
                params: { length: 1, lowDb: -2, lowHz: 200, b1Db: -1.5, b1Hz: 600, b1Q: 1.2,
                          b2Db: 2, b2Hz: 5000, b2Q: 0.9, highDb: 3 } },
    brass:    { note: '섹션을 여러 마이크로 녹음했다면 선형 위상이 답입니다',
                params: { length: 2, lowDb: 1, lowHz: 180, b1Db: -2, b1Hz: 450, b1Q: 1.2,
                          b2Db: -2.5, b2Hz: 3200, b2Q: 1.1, highDb: 2 } },
    winds:    { note: '목관 섹션도 같은 이유로 — 다만 더 얕게',
                params: { length: 2, lowDb: -0.5, lowHz: 160, b1Db: -1.5, b1Hz: 350, b1Q: 1.1,
                          b2Db: 1.5, b2Hz: 2500, b2Q: 0.9, highDb: 1.5 } },
    fx:       { note: '저역을 크게 덜어냅니다. 위상은 효과음에서 중요하지 않습니다',
                params: { length: 1, lowDb: -3, lowHz: 200, b1Db: 0, b1Hz: 800, b1Q: 1,
                          b2Db: -1, b2Hz: 1500, b2Q: 0.8, highDb: 4 } },
    vocal:    { note: '위상이 돌지 않는 EQ. 더블 트랙과 겹칠 때 보컬에서 이것이 중요해집니다',
                params: { length: 2, lowDb: 0.5, lowHz: 120, b1Db: -2, b1Hz: 400, b1Q: 1.4,
                          b2Db: 2, b2Hz: 3000, b2Q: 0.9, highDb: 2 } },
    drumloop: { note: '드럼에는 빠름 길이로. 프리링잉은 트랜지언트 앞에 붙는 것이라 '
                      + '드럼에서 가장 잘 들리고, 짧을수록 그 물결이 짧습니다',
                params: { length: 0, lowDb: 2, lowHz: 70, b1Db: -3, b1Hz: 400, b1Q: 1.6,
                          b2Db: 2.5, b2Hz: 6000, b2Q: 0.9, highDb: 1.5 } },
    bass:     { note: '베이스는 정밀 길이 — 저역을 분해하려면 응답이 길어야 하고, '
                      + '베이스에는 앞에서 울릴 트랜지언트가 거의 없습니다',
                params: { length: 2, lowDb: 2.5, lowHz: 70, b1Db: -3, b1Hz: 300, b1Q: 1.5,
                          b2Db: 1, b2Hz: 1500, b2Q: 1, highDb: -2 } },
    egtr:     { note: '일렉 기타에 표준 길이 · 로우미드를 덜고 프레즌스를 세웁니다',
                params: { length: 1, hpfHz: 80, lowDb: -1, lowHz: 150, b1Db: -3.5, b1Hz: 450, b1Q: 1.4,
                          b2Db: 3, b2Hz: 2500, b2Q: 1.1, highDb: -1.5 } },
    agtr:     { note: '통기타에 정밀 길이 — 통울림을 좁게 덜어내려면 그만큼의 분해능이 필요합니다',
                params: { length: 2, hpfHz: 70, lowDb: -1.5, lowHz: 110, b1Db: -4, b1Hz: 200, b1Q: 2.5,
                          b2Db: 2, b2Hz: 5000, b2Q: 0.8, highDb: 2.5, highHz: 10000 } },
    piano:    { note: '피아노에 정밀 길이, 아주 얕게. 위상이 돌면 페달을 밟은 화음의 '
                      + '배음들이 서로 어긋납니다',
                params: { length: 2, lowDb: 1, lowHz: 100, b1Db: -1.5, b1Hz: 350, b1Q: 1.3,
                          b2Db: 1.5, b2Hz: 4000, b2Q: 0.8, highDb: 1.5 } },
    strings:  { note: '현 섹션에 정밀 길이 — 여러 연주자가 겹친 소리라 위상 회전이 넓이로 드러납니다',
                params: { length: 2, hpfHz: 60, lowDb: -1, lowHz: 120, b1Db: -2, b1Hz: 400, b1Q: 1.2,
                          b2Db: 1.5, b2Hz: 3000, b2Q: 0.9, highDb: 2, highHz: 9000 } },
    synth:    { note: '신스에 표준 길이 — 만들어진 소리라 무엇을 해도 되고, 길이는 지연이 '
                      + '덜한 쪽으로',
                params: { length: 1, lowDb: 1.5, lowHz: 90, b1Db: -2, b1Hz: 500, b1Q: 1,
                          b2Db: 2, b2Hz: 5000, b2Q: 0.8, highDb: 2.5, highHz: 11000 } },
  }),
  ...inst('tape', {
    backing:  { note: '테이프 더블의 질감. 백킹에서 테이프는 두께를 만듭니다',
                params: { speed: 1, drive: 3, bias: 0.5, bump: 2, wow: 0.03, flutter: 0.07, crosstalk: 0.2 } },
    perc:     { note: '빠른 속도로 — 퍼커션에 와우가 들리면 박자가 흔들립니다',
                params: { speed: 2, drive: 4, bias: 0.45, bump: 1, wow: 0.02, flutter: 0.05, crosstalk: 0.12 } },
    brass:    { note: '범프를 크게. 금관과 테이프는 오래된 조합입니다',
                params: { speed: 1, drive: 5, bias: 0.6, bump: 3, wow: 0.04, flutter: 0.08, crosstalk: 0.18 } },
    winds:    { note: '드라이브는 가장 낮게. 목관은 테이프에서 쉽게 지저분해집니다',
                params: { speed: 2, drive: 2, bias: 0.5, bump: 2, wow: 0.025, flutter: 0.04, crosstalk: 0.1 } },
    fx:       { note: '느린 속도, 큰 와우 — 테이프가 망가진 소리 자체가 효과입니다',
                params: { speed: 0, drive: 7, bias: 0.7, bump: 4, wow: 0.08, flutter: 0.15, crosstalk: 0.3 } },
    vocal:    { note: '테이프 보컬은 거의 전적으로 범프와 아주 약한 드라이브입니다',
                params: { speed: 1, drive: 2.5, bias: 0.5, bump: 1.5, wow: 0.02, flutter: 0.04, crosstalk: 0.1 } },
    drumloop: { note: '드럼에 15 ips — 테이프가 드럼을 눌러주는 건 상단부터라, '
                      + '심벌이 먼저 잡히고 킥은 범프로 부풀어 오릅니다',
                params: { speed: 1, drive: 7, bias: 0.45, bump: 5, wow: 0.12, flutter: 0.18, crosstalk: 0.3 } },
    bass:     { note: '베이스는 범프가 근음과 겹치면 뭉갭니다 — 30 ips 로 범프를 100 Hz 로 '
                      + '올려 비켜 세우고 레벨만',
                params: { speed: 2, drive: 6, bias: 0.5, bump: 1.5, wow: 0.05, flutter: 0.08, crosstalk: 0.1 } },
    egtr:     { note: '일렉 기타에 7.5 ips — 느린 테이프의 좁은 상단이 앰프 뒤에서 '
                      + '제일 자연스럽게 들립니다',
                params: { speed: 0, drive: 8, bias: 0.35, bump: 4, wow: 0.3, flutter: 0.3, hiss: 0.25, crosstalk: 0.45 } },
    agtr:     { note: '통기타는 상단이 소리의 전부라 30 ips — 바이어스를 올려 '
                      + '깨끗하게, 범프는 낮게',
                params: { speed: 2, drive: 2, bias: 0.62, bump: 1.5, wow: 0.1, flutter: 0.1, mix: 0.7 } },
    piano:    { note: '피아노는 워우를 절대 못 숨깁니다 — 길게 뻗는 음이 흔들리면 '
                      + '바로 고장난 소리가 됩니다. 15 ips 에 워우를 끕니다',
                params: { speed: 1, drive: 3, bias: 0.55, bump: 2.5, wow: 0.03, flutter: 0.06, crosstalk: 0.15 } },
    strings:  { note: '현에는 15 ips 에 워우를 아주 얕게 — 섹션이 한 덩어리로 들리게',
                params: { speed: 1, drive: 2, bias: 0.55, bump: 3, wow: 0.18, flutter: 0.1, crosstalk: 0.3 } },
    synth:    { note: '신스에 7.5 ips 를 세게 — 디지털로 만든 것을 아날로그 매체에 '
                      + '한 번 통과시키는 것이 목적입니다',
                params: { speed: 0, drive: 11, bias: 0.25, bump: 6, wow: 0.5, flutter: 0.45, hiss: 0.35, crosstalk: 0.55 } },
  }),
  ...inst('amp', {
    backing:  { note: '백킹을 앰프로 보내면 리드와 질감이 갈립니다',
                params: { gain: 30, stages: 1, master: 36, sag: 45, cab: 2, mic: 52, mid: -1 } },
    perc:     { note: '작은 캡으로 퍼커션을 좁혀 로파이로 만듭니다',
                params: { gain: 40, stages: 1, master: 42, sag: 30, cab: 3, mic: 60, mid: 1 } },
    brass:    { note: '금관을 앰프에 넣으면 1960년대 소울 섹션이 됩니다',
                params: { gain: 50, stages: 2, master: 44, sag: 42, cab: 1, mic: 48, mid: 2 } },
    winds:    { note: '가장 낮은 게인으로 — 목관은 금방 깨집니다',
                params: { gain: 22, stages: 1, master: 30, sag: 55, cab: 0, mic: 62, mid: 4 } },
    fx:       { note: '끝까지 올립니다. 효과음에 깨끗한 앰프는 쓸모가 없습니다',
                params: { gain: 70, stages: 3, master: 50, sag: 60, cab: 2, mic: 40, mid: -3 } },
    vocal:    { note: '보컬을 앰프로 보내는 건 효과입니다. 작은 캡, 낮은 게인, 마이크를 멀리',
                params: { gain: 35, stages: 1, master: 40, sag: 40, cab: 2, mic: 50, mid: 0 } },
    drumloop: { note: '드럼을 앰프에 넣는 건 왜곡이지 앰프 소리가 아닙니다 — 캐비닛을 끄고 한 단만',
                params: { gain: 40, stages: 1, master: 30, sag: 20, cab: 3, mic: 50, level: -4 } },
    bass:     { note: '베이스 앰프는 기타 앰프가 아닙니다 — 캐비닛을 끄고 저역을 살립니다. '
                      + '기타 캐비닛의 80 Hz 하이패스가 베이스의 근음을 잘라냅니다',
                params: { gain: 30, stages: 1, master: 45, sag: 55, cab: 3, bass: 4, treble: -3 } },
    egtr:     { note: '이 악기를 위해 만든 장치입니다. 두 단 크런치에 2×12',
                params: { gain: 55, stages: 2, master: 45, sag: 35, cab: 1, mic: 45 } },
    agtr:     { note: '통기타에는 거의 클린으로, 마이크는 오프 액시스. 픽업 소리를 부드럽게만',
                params: { gain: 15, stages: 1, master: 25, sag: 15, cab: 0, mic: 80, treble: -3 } },
    piano:    { note: '전자 피아노를 앰프에 — 로즈가 원래 그렇게 들어갔습니다',
                params: { gain: 28, stages: 1, master: 38, sag: 50, cab: 0, mic: 55, mid: 2 } },
    strings:  { note: '현에는 캐비닛의 고역 차단만 빌려 씁니다. 왜곡은 거의 없이',
                params: { gain: 10, stages: 1, master: 18, sag: 10, cab: 1, mic: 70, presence: -2 } },
    synth:    { note: '신스를 앰프로 — 세 단에 4×12, 기계 소리를 악기 소리로 바꾸는 쪽',
                params: { gain: 78, stages: 3, master: 55, sag: 30, cab: 2, mic: 40, stack: 1 } },
  }),

  ...inst('rotary', {
    backing:  { note: '로터리 백킹은 교회 합창의 흔들림을 흉내냅니다',
                params: { rateHz: 5.2, doppler: 80, throb: 50, xoverHz: 820, drive: 18, mix: 70 } },
    perc:     { note: '빠르고 얕게 — 퍼커션의 로터리는 탬버린을 흔드는 손처럼 들립니다',
                params: { rateHz: 6.5, doppler: 60, throb: 40, xoverHz: 1100, drive: 12, mix: 45 } },
    brass:    { note: '금관 섹션에 로터리는 오르간처럼 들리게 합니다',
                params: { rateHz: 5.5, doppler: 90, throb: 65, xoverHz: 900, drive: 28, mix: 80 } },
    winds:    { note: '느리게 — 목관의 비브라토와 박자가 맞지 않으면 어지럽습니다',
                params: { rateHz: 4.2, doppler: 75, throb: 55, xoverHz: 950, drive: 16, mix: 55 } },
    fx:       { note: '가장 빠르고 가장 깊게',
                params: { rateHz: 7.5, doppler: 100, throb: 80, xoverHz: 700, drive: 35, mix: 95 } },
    vocal:    { note: '로터리 보컬은 존 레논입니다. 도플러는 줄이고 믹스는 중간에',
                params: { rateHz: 4.8, doppler: 70, throb: 45, xoverHz: 800, drive: 15, mix: 60 } },
    drumloop: { note: '드럼을 회전시키면 그루브가 흔들립니다 — 절반만 섞고 도플러는 최소로',
                params: { rateHz: 3.2, doppler: 30, throb: 45, xoverHz: 1200, drive: 10, mix: 35 } },
    bass:     { note: '베이스는 드럼 로터만 쓰게 크로스오버를 올리고, 도플러는 거의 끕니다 — '
                      + '저역이 흔들리면 모노에서 사라집니다',
                params: { rateHz: 0.9, doppler: 20, throb: 30, xoverHz: 1600, balance: -70, mix: 40 } },
    egtr:     { note: '기타를 레슬리에 넣던 그 소리. 드라이브를 올려 캐비닛을 밀어붙입니다',
                params: { rateHz: 6.2, doppler: 120, throb: 70, xoverHz: 700, drive: 55, mix: 100 } },
    agtr:     { note: '통기타에는 느리게 · 얕게. 마이크를 넓혀 공간만 얻습니다',
                params: { rateHz: 0.8, doppler: 70, throb: 35, micAngle: 140, drive: 0, mix: 55 } },
    piano:    { note: '전자 피아노 — 오르간 다음으로 이 스피커에 자주 들어간 악기입니다',
                params: { rateHz: 5.8, doppler: 100, throb: 60, xoverHz: 850, drive: 22, mix: 90 } },
    strings:  { note: '아주 느린 코랄. 섹션이 숨 쉬는 것처럼만',
                params: { rateHz: 0.35, doppler: 60, throb: 25, micAngle: 160, accelSec: 3.5, mix: 60 } },
    synth:    { note: '빠른 트레몰로에 혼 쪽으로 기울여서. 신스 리드를 오르간처럼 만듭니다',
                params: { rateHz: 7, doppler: 150, throb: 80, balance: 60, accelSec: 0.5, mix: 100 } },
  }),

  ...inst('flanger', {
    backing:  { note: '백킹 스택에 아주 얕게 — 리드와 위상이 싸우지 않을 만큼',
                params: { rateHz: 0.12, depthMs: 1.5, delayMs: 7, feedback: 0.25, mix: 20 } },
    perc:     { note: '짧은 지연으로 금속성만 더합니다',
                params: { rateHz: 0.5, depthMs: 0.8, delayMs: 4, feedback: 0.15, mix: 12 } },
    brass:    { note: '금관 플랜저는 70년대 펑크의 소리입니다',
                params: { rateHz: 0.15, depthMs: 2.5, delayMs: 8, feedback: 0.3, mix: 25 } },
    winds:    { note: '가장 느리게, 거의 들리지 않게',
                params: { rateHz: 0.09, depthMs: 1.8, delayMs: 9, feedback: 0.2, mix: 18 } },
    fx:       { note: '깊고 빠르게. 제트기 소리가 목적입니다',
                params: { rateHz: 0.25, depthMs: 5, delayMs: 10, feedback: 0.6, mix: 60 } },
    vocal:    { note: '느리게, 얕게. 보컬 플랜저는 구절 하나에만 쓰는 장치입니다',
                params: { rateHz: 0.1, depthMs: 1.2, delayMs: 5, feedback: 0.2, mix: 15 } },
    drumloop: { note: '루프 전체 플랜징. 피드백을 낮게 잡아야 리듬이 남습니다',
                params: { rateHz: 0.2, depthMs: 1.5, delayMs: 2, feedback: 0.3, mix: 30 } },
    bass:     { note: '피드백 거의 없이. 저역 플랜저는 위상 문제 그 자체입니다',
                params: { rateHz: 0.15, depthMs: 0.8, delayMs: 4, feedback: 0.15, mix: 20 } },
    egtr:     { note: '기타 플랜저의 기본값. 피드백이 성격을 만듭니다',
                params: { rateHz: 0.3, depthMs: 2.5, delayMs: 3, feedback: 0.6, mix: 45 } },
    agtr:     { note: '아주 옅게. 통기타에 플랜저는 대체로 과합니다',
                params: { rateHz: 0.25, depthMs: 1.2, delayMs: 5, feedback: 0.25, mix: 22 } },
    piano:    { note: '느리게 흐르는 정도. 앰비언트 피아노에서 씁니다',
                params: { rateHz: 0.08, depthMs: 2, delayMs: 6, feedback: 0.35, mix: 25 } },
    strings:  { note: '아주 느리게 — 움직이는 게 보이면 안 됩니다',
                params: { rateHz: 0.06, depthMs: 1.5, delayMs: 7, feedback: 0.2, mix: 18 } },
    synth:    { note: '깊고 강한 피드백. 신스에서 플랜저는 악기의 일부가 됩니다',
                params: { rateHz: 0.4, depthMs: 4, delayMs: 2, feedback: 0.75, mix: 55 } },
  }),

  ...inst('phaser', {
    backing:  { note: '1.4 kHz 중심이면 리드의 자음을 먹지 않습니다',
                params: { rateHz: 0.35, depth: 0.55, centreHz: 1400, feedback: 0.3, mix: 25 } },
    perc:     { note: '높은 중심 주파수로 — 퍼커션의 정보는 위에 있습니다',
                params: { rateHz: 0.8, depth: 0.4, centreHz: 2500, feedback: 0.2, mix: 18 } },
    brass:    { note: '금관의 중역을 휘젓습니다',
                params: { rateHz: 0.4, depth: 0.7, centreHz: 1600, feedback: 0.35, mix: 28 } },
    winds:    { note: '900 Hz 중심, 얕게',
                params: { rateHz: 0.2, depth: 0.45, centreHz: 900, feedback: 0.25, mix: 20 } },
    fx:       { note: '깊고 빠르고 피드백 많이',
                params: { rateHz: 1.2, depth: 0.9, centreHz: 700, feedback: 0.6, mix: 60 } },
    vocal:    { note: '1.2 kHz 중심이면 가사를 덜 먹습니다',
                params: { rateHz: 0.25, depth: 0.5, centreHz: 1200, feedback: 0.25, mix: 22 } },
    drumloop: { note: '하이햇에 움직임만 줍니다. 중심 주파수를 높게',
                params: { rateHz: 0.5, depth: 0.5, centreHz: 2200, feedback: 0.25, mix: 28 } },
    bass:     { note: '중심을 높게 잡아 저역을 피합니다. 펑크 베이스의 그 소리',
                params: { rateHz: 0.35, depth: 0.6, centreHz: 900, feedback: 0.4, mix: 30 } },
    egtr:     { note: '기타 페이저. 느리게 돌면서 깊게',
                params: { rateHz: 0.25, depth: 0.8, centreHz: 800, feedback: 0.5, mix: 45 } },
    agtr:     { note: '옅게 — 통기타는 페이저가 걸린 게 티 나면 이상합니다',
                params: { rateHz: 0.2, depth: 0.45, centreHz: 1200, feedback: 0.3, mix: 22 } },
    piano:    { note: '전자 피아노의 그 흔들림',
                params: { rateHz: 0.3, depth: 0.6, centreHz: 1000, feedback: 0.35, mix: 30 } },
    strings:  { note: '아주 느리게, 넓게. 패드가 숨쉬는 느낌',
                params: { rateHz: 0.08, depth: 0.7, centreHz: 700, feedback: 0.3, mix: 25 } },
    synth:    { note: '빠르고 깊게, 피드백 크게. 신스 페이저는 감출 이유가 없습니다',
                params: { rateHz: 0.9, depth: 0.9, centreHz: 1400, feedback: 0.7, mix: 55 } },
  }),

  ...inst('tremolo', {
    backing:  { note: '백킹에 트레몰로는 얕게 — 깊으면 합창이 흔들립니다',
                params: { rateHz: 5, depth: 0.25, shape: 0.5 } },
    perc:     { note: '빠르게. 퍼커션의 트레몰로는 롤처럼 들립니다',
                params: { rateHz: 8, depth: 0.5, shape: 0 } },
    brass:    { note: '금관 섹션의 셰이크를 흉내냅니다',
                params: { rateHz: 6.5, depth: 0.35, shape: 1 } },
    winds:    { note: '목관의 자연 비브라토와 비슷한 속도로',
                params: { rateHz: 4, depth: 0.4, shape: 0.5 } },
    fx:       { note: '느리고 깊게 — 맥동 자체가 효과입니다',
                params: { rateHz: 2.5, depth: 0.8, shape: 0 } },
    vocal:    { note: '보컬 트레몰로는 깊이가 생명입니다 — 0.3 을 넘기면 노래가 아니라 효과가 됩니다',
                params: { rateHz: 5.5, depth: 0.3, shape: 1 } },
    drumloop: { note: '박에 맞춘 게이팅. 깊이를 크게 주면 리듬 장치가 됩니다',
                params: { rateHz: 8, depth: 0.7, shape: 0.9 } },
    bass:     { note: '느리고 얕게. 베이스 트레몰로는 레벨이 흔들리는 것으로 들립니다',
                params: { rateHz: 3, depth: 0.25, shape: 0 } },
    egtr:     { note: '서프 기타. 이 악기의 고전적 트레몰로',
                params: { rateHz: 5.5, depth: 0.6, shape: 0.2 } },
    agtr:     { note: '아주 얕게 — 통기타에는 흔들림보다 숨결 정도',
                params: { rateHz: 4, depth: 0.32, shape: 0 } },
    piano:    { note: '로즈 피아노의 그 흔들림. 부드러운 사인 파형',
                params: { rateHz: 4.5, depth: 0.45, shape: 0 } },
    strings:  { note: '아주 느리게, 더 얕게. 섹션이 숨쉬는 정도지 떠는 게 아닙니다',
                params: { rateHz: 1.2, depth: 0.2, shape: 0 } },
    synth:    { note: '빠르고 각지게. 신스에서는 게이트 시퀀서처럼 씁니다',
                params: { rateHz: 12, depth: 0.85, shape: 1 } },
  }),

  ...inst('autopan', {
    backing:  { note: '좌우로 넓게 움직입니다. 백킹은 움직여도 됩니다',
                params: { rateHz: 0.2, depth: 0.62 } },
    perc:     { note: '빠르게 튕깁니다 — 셰이커가 좌우로 오가는 그 소리',
                params: { rateHz: 2, depth: 0.45 } },
    brass:    { note: '섹션은 거의 움직이지 않습니다',
                params: { rateHz: 0.8, depth: 0.12 } },
    winds:    { note: '느리고 얕게 — 목관이 좌우로 오가면 섹션이 흩어집니다',
                params: { rateHz: 0.11, depth: 0.34 } },
    fx:       { note: '가장 빠르고 가장 넓게',
                params: { rateHz: 3.5, depth: 0.9 } },
    vocal:    { note: '리드 보컬은 움직이지 않습니다 — 이 설정은 애드리브와 더블 트랙용입니다',
                params: { rateHz: 0.09, depth: 0.28 } },
    drumloop: { note: '루프를 패닝하면 킥이 움직입니다. 아주 얕게만',
                params: { rateHz: 0.3, depth: 0.2 } },
    bass:     { note: '베이스는 움직이면 안 됩니다. 사실상 끈 값',
                params: { rateHz: 0.1, depth: 0.05 } },
    egtr:     { note: '느리게 좌우로. 더블 트랙이 아닐 때 폭을 만듭니다',
                params: { rateHz: 0.25, depth: 0.55 } },
    agtr:     { note: '아주 느리게, 절반 폭으로',
                params: { rateHz: 0.15, depth: 0.4 } },
    piano:    { note: '피아노는 이미 스테레오입니다. 거의 움직이지 않게',
                params: { rateHz: 0.12, depth: 0.15 } },
    strings:  { note: '느리게 크게 — 섹션이 방 안에서 움직이는 느낌',
                params: { rateHz: 0.08, depth: 0.5 } },
    synth:    { note: '빠르고 넓게. 아르페지오가 좌우로 튀게 됩니다',
                params: { rateHz: 1.2, depth: 0.85 } },
  }),

  // ══ Delay ══════════════════════════════════════════════════════════════════

  ...inst('delay', {
    backing:  { note: '리드보다 짧고 작게 — 백킹의 딜레이가 들리면 안 됩니다',
                params: { timeMs: 240, feedback: 0.16, mix: 0.09 } },
    perc:     { note: '짧은 반복으로 리듬을 만듭니다',
                params: { timeMs: 180, feedback: 0.3, mix: 0.12 } },
    brass:    { note: '섹션 뒤에 한 번만 — 금관의 딜레이는 들리면 과합니다',
                params: { timeMs: 520, feedback: 0.19, mix: 0.17 } },
    winds:    { note: '길고 부드럽게 — 목관의 반복은 다음 음과 겹쳐도 어울립니다',
                params: { timeMs: 600, feedback: 0.28, mix: 0.18 } },
    fx:       { note: '길게, 많이. 효과음의 딜레이는 효과 그 자체입니다',
                params: { timeMs: 800, feedback: 0.6, mix: 0.35 } },
    vocal:    { note: '8분 점음표(120 BPM 에서 375 ms). 문장 끝만 밀고 가사는 건드리지 않습니다',
                params: { timeMs: 375, feedback: 0.22, mix: 0.14 } },
    drumloop: { note: '8분음표 슬랩. 피드백을 낮게 해야 그루브가 안 흐려집니다',
                params: { timeMs: 250, feedback: 0.18, mix: 0.16 } },
    bass:     { note: '베이스에 딜레이는 저역을 겹칩니다. 짧고 거의 안 들리게',
                params: { timeMs: 120, feedback: 0.1, mix: 0.1 } },
    egtr:     { note: '슬랩백 120 ms. 로카빌리부터 지금까지 안 바뀐 값',
                params: { timeMs: 120, feedback: 0.22, mix: 0.24 } },
    agtr:     { note: '점8분음표. 아르페지오가 자기 자신과 엮입니다',
                params: { timeMs: 375, feedback: 0.3, mix: 0.2 } },
    piano:    { note: '길고 옅게. 피아노 딜레이는 방처럼 들려야 합니다',
                params: { timeMs: 500, feedback: 0.25, mix: 0.15 } },
    strings:  { note: '아주 길고 아주 옅게. 꼬리를 늘리는 용도',
                params: { timeMs: 700, feedback: 0.35, mix: 0.14 } },
    synth:    { note: '피드백을 크게 — 신스 딜레이는 반복 자체가 파트가 됩니다',
                params: { timeMs: 375, feedback: 0.55, mix: 0.32 } },
  }),

  ...inst('pingpong', {
    backing:  { note: '좌우로 던져 가운데의 리드를 비웁니다',
                params: { timeMs: 300, feedback: 0.25, toneHz: 7500, mix: 22 } },
    perc:     { note: '짧게 튕깁니다 — 퍼커션의 핑퐁은 리듬을 두 배로 만듭니다',
                params: { timeMs: 200, feedback: 0.35, toneHz: 9000, mix: 25 } },
    brass:    { note: '어둡게 — 반복이 밝으면 섹션과 섞입니다',
                params: { timeMs: 450, feedback: 0.22, toneHz: 5500, mix: 18 } },
    winds:    { note: '길고 어둡게 — 목관의 반복은 뒤에서 번져야 합니다',
                params: { timeMs: 680, feedback: 0.32, toneHz: 6200, mix: 23 } },
    fx:       { note: '가장 길고 가장 많이 — 효과음의 반복은 효과 그 자체입니다',
                params: { timeMs: 700, feedback: 0.6, toneHz: 4000, mix: 45 } },
    vocal:    { note: '좌우로 던져 가운데를 비웁니다. 리드가 설 자리는 가운데입니다',
                params: { timeMs: 350, feedback: 0.3, toneHz: 6500, mix: 18 } },
    drumloop: { note: '탑라인만 좌우로 튀게. 톤을 닫아 킥이 따라가지 않게 합니다',
                params: { timeMs: 250, feedback: 0.25, toneHz: 4000, mix: 18 } },
    bass:     { note: '핑퐁은 베이스에 쓰지 않는 게 맞습니다. 흔적만 남긴 값',
                params: { timeMs: 180, feedback: 0.12, toneHz: 1500, mix: 8 } },
    egtr:     { note: '리드 기타를 좌우로 벌립니다',
                params: { timeMs: 375, feedback: 0.35, toneHz: 5000, mix: 28 } },
    agtr:     { note: '아르페지오가 좌우로 흐릅니다. 톤은 밝게 열어둡니다',
                params: { timeMs: 333, feedback: 0.3, toneHz: 8000, mix: 24 } },
    piano:    { note: '넓고 옅게. 피드백을 낮춰 화음이 뭉치지 않게',
                params: { timeMs: 500, feedback: 0.28, toneHz: 7000, mix: 20 } },
    strings:  { note: '아주 길게. 홀 뒤에서 되돌아오는 소리처럼',
                params: { timeMs: 750, feedback: 0.4, toneHz: 5000, mix: 18 } },
    synth:    { note: '빠르고 강하게. 신스 아르페지오와 핑퐁은 한 세트입니다',
                params: { timeMs: 187, feedback: 0.55, toneHz: 9000, mix: 35 } },
  }),

  ...inst('tapedelay', {
    backing:  { note: '테이프 반복이 백킹을 뒤로 밀어줍니다',
                params: { timeMs: 300, feedback: 0.22, toneHz: 2800, wowMs: 0.35, drive: 0.15, mix: 12 } },
    perc:     { note: '짧고 밝게 — 퍼커션의 테이프 반복은 고스트 노트처럼 들립니다',
                params: { timeMs: 250, feedback: 0.32, toneHz: 4500, wowMs: 0.3, drive: 0.25, mix: 18 } },
    brass:    { note: '와우를 크게 — 금관과 테이프 흔들림은 잘 맞습니다',
                params: { timeMs: 450, feedback: 0.28, toneHz: 2800, wowMs: 0.7, drive: 0.3, mix: 20 } },
    winds:    { note: '길고 어둡게, 와우는 많이',
                params: { timeMs: 600, feedback: 0.3, toneHz: 3200, wowMs: 0.8, drive: 0.2, mix: 16 } },
    fx:       { note: '테이프가 망가진 소리로',
                params: { timeMs: 750, feedback: 0.55, toneHz: 2200, wowMs: 1.5, drive: 0.45, mix: 40 } },
    vocal:    { note: '반복이 어두워져야 가사와 겹치지 않습니다 — 톤 3.2 kHz',
                params: { timeMs: 400, feedback: 0.28, toneHz: 3200, wowMs: 0.5, drive: 0.22, mix: 16 } },
    drumloop: { note: '와우를 낮게 — 테이프 흔들림이 드럼에서는 박자가 밀린 것처럼 들립니다',
                params: { timeMs: 250, feedback: 0.2, toneHz: 4000, wowMs: 0.2, drive: 0.2, mix: 15 } },
    bass:     { note: '거의 안 씁니다. 드라이브만 조금 빌려 쓰는 값',
                params: { timeMs: 160, feedback: 0.12, toneHz: 2000, wowMs: 0.1, drive: 0.35, mix: 10 } },
    egtr:     { note: '테이프 에코. 어두운 톤과 드라이브가 이 장치의 전부입니다',
                params: { timeMs: 300, feedback: 0.4, toneHz: 3000, wowMs: 0.8, drive: 0.45, mix: 28 } },
    agtr:     { note: '따뜻하게 한 번만 되돌아옵니다',
                params: { timeMs: 375, feedback: 0.25, toneHz: 4500, wowMs: 0.5, drive: 0.25, mix: 20 } },
    piano:    { note: '길고 어둡게. 반복이 화음이 아니라 공간으로 들리게',
                params: { timeMs: 550, feedback: 0.3, toneHz: 3000, wowMs: 0.6, drive: 0.2, mix: 18 } },
    strings:  { note: '아주 길고 어둡게. 와우를 크게 줘도 스트링은 견딥니다',
                params: { timeMs: 800, feedback: 0.42, toneHz: 2500, wowMs: 1.2, drive: 0.15, mix: 16 } },
    synth:    { note: '피드백을 거의 발진 직전까지. 테이프 딜레이의 그 자기발진',
                params: { timeMs: 400, feedback: 0.7, toneHz: 5000, wowMs: 1, drive: 0.5, mix: 35 } },
  }),

  // ══ Reverb ═════════════════════════════════════════════════════════════════

  ...inst('reverb', {
    backing:  { note: '리드보다 젖게 — 백킹은 뒤에 있어야 합니다',
                params: { decaySec: 2, mix: 0.28, preDelayMs: 30 } },
    perc:     { note: '짧은 방. 퍼커션의 리버브가 길면 리듬이 뭉갭니다',
                params: { decaySec: 0.7, mix: 0.2, preDelayMs: 6 } },
    brass:    { note: '스트링과 같은 홀, 조금 더 가깝게',
                params: { decaySec: 2.1, mix: 0.26, preDelayMs: 16 } },
    winds:    { note: '스트링보다 작은 방 — 목관은 가깝게 들려야 합니다',
                params: { decaySec: 1.4, mix: 0.3, preDelayMs: 14 } },
    fx:       { note: '가장 길고 가장 젖게 — 효과음은 공간 그 자체일 때가 많습니다',
                params: { decaySec: 4.5, mix: 0.45, preDelayMs: 50 } },
    vocal:    { note: '보컬 리버브는 길이보다 프리딜레이입니다 — 35 ms 가 가사와 울림을 떼어 놓습니다',
                params: { decaySec: 1.8, mix: 0.22, preDelayMs: 35 } },
    drumloop: { note: '짧은 방. 드럼 리버브는 길면 그루브를 지웁니다',
                params: { decaySec: 0.9, mix: 0.14, preDelayMs: 10 } },
    bass:     { note: '베이스에 리버브는 저역을 흐립니다. 거의 드라이',
                params: { decaySec: 0.6, mix: 0.06, preDelayMs: 0 } },
    egtr:     { note: '중간 길이. 프리딜레이를 줘서 피킹이 앞에 남게 합니다',
                params: { decaySec: 1.6, mix: 0.2, preDelayMs: 25 } },
    agtr:     { note: '일렉보다 짧게. 통기타는 리버브가 많으면 바로 아마추어처럼 들립니다',
                params: { decaySec: 1.1, mix: 0.16, preDelayMs: 18 } },
    piano:    { note: '홀 쪽으로. 피아노는 원래 큰 방에 있는 악기입니다',
                params: { decaySec: 2.4, mix: 0.26, preDelayMs: 30 } },
    strings:  { note: '가장 깁니다. 스트링에 긴 홀은 효과가 아니라 기본입니다',
                params: { decaySec: 3.4, mix: 0.34, preDelayMs: 40 } },
    synth:    { note: '길고 많이. 신스는 공간이 곧 사운드 디자인입니다',
                params: { decaySec: 3, mix: 0.38, preDelayMs: 18 } },
  }),

  ...inst('spacereverb', {
    backing:  { note: '리드와 같은 공간, 조금 더 넓고 더 젖게',
                params: { space: 7, sizePct: 110, decayPct: 100, preDelayMs: 22, dampingPct: 95, erDb: 0, tailDb: 0,
                          lowCutHz: 280, highCutHz: 11500, widthPct: 125, mixPct: 24 } },
    perc:     { note: '초기 반사만 — 퍼커션에 필요한 것은 방이지 꼬리가 아닙니다',
                params: { space: 4, sizePct: 90, decayPct: 80, preDelayMs: 12, dampingPct: 110, erDb: 1, tailDb: -1,
                          lowCutHz: 350, highCutHz: 14000, widthPct: 115, mixPct: 18 } },
    brass:    { note: '큰 공간에 가깝게 — 금관은 멀어지면 힘을 잃습니다',
                params: { space: 9, sizePct: 115, decayPct: 105, preDelayMs: 20, dampingPct: 95, erDb: 0, tailDb: 0,
                          lowCutHz: 200, highCutHz: 11000, widthPct: 105, mixPct: 22 } },
    winds:    { note: '작은 홀. 목관은 스트링보다 앞에 있어야 합니다',
                params: { space: 5, sizePct: 95, decayPct: 95, preDelayMs: 18, dampingPct: 100, erDb: 0, tailDb: 0,
                          lowCutHz: 220, highCutHz: 12500, widthPct: 110, mixPct: 24 } },
    fx:       { note: '가장 큰 공간, 꼬리를 올리고 초기 반사를 내립니다',
                params: { space: 14, sizePct: 170, decayPct: 200, preDelayMs: 45, dampingPct: 70, erDb: -3, tailDb: 3,
                          lowCutHz: 150, highCutHz: 10000, widthPct: 140, mixPct: 45 } },
    vocal:    { note: '작은 방 하나. 저역을 250 Hz 에서 잘라야 울림이 가사를 덮지 않습니다',
                params: { space: 6, sizePct: 100, decayPct: 95, preDelayMs: 25, dampingPct: 90, erDb: 0, tailDb: 0,
                          lowCutHz: 250, highCutHz: 11000, widthPct: 110, mixPct: 20 } },
    drumloop: { note: '드럼 룸. 짧고 어둡게, 초기 반사 위주로 — 꼬리는 눌러둡니다',
                params: { space: S('room-drum'), sizePct: 90, decayPct: 65, preDelayMs: 8,
                          dampingPct: 130, erDb: 2, tailDb: -6, lowCutHz: 180,
                          highCutHz: 8000, widthPct: 105, mixPct: 16 } },
    bass:     { note: '부스에 가깝게, 저역을 크게 잘라냅니다. 베이스가 흐려지면 실패입니다',
                params: { space: S('room-booth'), sizePct: 60, decayPct: 45, preDelayMs: 0,
                          dampingPct: 150, erDb: 0, tailDb: -10, lowCutHz: 400,
                          highCutHz: 4000, widthPct: 60, mixPct: 7 } },
    egtr:     { note: '나무 방. 앰프가 있던 공간을 흉내냅니다',
                params: { space: S('room-wood'), sizePct: 100, decayPct: 90, preDelayMs: 18,
                          dampingPct: 110, erDb: 1, tailDb: -2, lowCutHz: 200,
                          highCutHz: 7000, widthPct: 110, mixPct: 20 } },
    agtr:     { note: '스튜디오 룸에 공기만. 하이컷을 높게 열어 피크 소리를 남깁니다',
                params: { space: S('room-studio'), sizePct: 110, decayPct: 95, preDelayMs: 22,
                          dampingPct: 90, erDb: 1, tailDb: -1, lowCutHz: 260,
                          highCutHz: 13000, widthPct: 120, mixPct: 22 } },
    piano:    { note: '리사이틀 홀. 피아노에 맞춰 만들어진 공간입니다',
                params: { space: S('hall-recital'), sizePct: 120, decayPct: 110, preDelayMs: 28,
                          dampingPct: 85, erDb: 0, tailDb: 0, lowCutHz: 140,
                          highCutHz: 12000, widthPct: 120, mixPct: 26 } },
    strings:  { note: '스코어링 스테이지. 스트링 섹션이 실제로 녹음되는 곳',
                params: { space: S('hall-scoring'), sizePct: 140, decayPct: 130, preDelayMs: 35,
                          dampingPct: 75, erDb: -2, tailDb: 2, lowCutHz: 110,
                          highCutHz: 10000, widthPct: 135, mixPct: 32 } },
    synth:    { note: '넓은 앰비언스. 초기 반사를 죽이고 꼬리만 남깁니다',
                params: { space: S('amb-wide'), sizePct: 150, decayPct: 160, preDelayMs: 12,
                          dampingPct: 70, erDb: -8, tailDb: 3, lowCutHz: 220,
                          highCutHz: 11000, widthPct: 145, mixPct: 38 } },
  }),

  ...inst('plate', {
    backing:  { note: '리드와 같은 판, 더 넓고 더 젖게',
                params: { decaySec: 2.2, preDelayMs: 18, dampHz: 7000, diffusion: 0.85, lowCutHz: 320,
                          highCutHz: 12000, widthPct: 125, mixPct: 26 } },
    perc:     { note: '밝고 짧은 판. 퍼커션에 판 리버브는 금속끼리의 조합입니다',
                params: { decaySec: 1.2, preDelayMs: 10, dampHz: 9000, diffusion: 0.7, lowCutHz: 400,
                          highCutHz: 15000, widthPct: 115, mixPct: 16 } },
    brass:    { note: '좁게 — 금관 섹션은 넓히면 한 덩어리가 아니게 됩니다',
                params: { decaySec: 2, preDelayMs: 20, dampHz: 6500, diffusion: 0.8, lowCutHz: 250,
                          highCutHz: 11000, widthPct: 108, mixPct: 20 } },
    winds:    { note: '밝은 판을 얕게 — 목관은 판 리버브에서 쉽게 날카로워집니다',
                params: { decaySec: 1.8, preDelayMs: 16, dampHz: 8500, diffusion: 0.78, lowCutHz: 260,
                          highCutHz: 13000, widthPct: 112, mixPct: 22 } },
    fx:       { note: '가장 길고 넓은 판 — 효과음에 판 리버브는 과할수록 맞습니다',
                params: { decaySec: 4.5, preDelayMs: 40, dampHz: 5000, diffusion: 0.9, lowCutHz: 200,
                          highCutHz: 10000, widthPct: 140, mixPct: 45 } },
    vocal:    { note: '보컬에 가장 많이 쓰인 리버브입니다. 300 Hz 로우컷이 판 리버브를 맑게 유지합니다',
                params: { decaySec: 1.9, preDelayMs: 22, dampHz: 7500, diffusion: 0.82, lowCutHz: 300,
                          highCutHz: 12000, widthPct: 115, mixPct: 20 } },
    drumloop: { note: '짧은 플레이트. 스네어에 몸을 붙이는 고전적 방법입니다',
                params: { decaySec: 1.2, preDelayMs: 8, dampHz: 6000, diffusion: 0.8,
                          lowCutHz: 250, highCutHz: 11000, widthPct: 105, mixPct: 14 } },
    bass:     { note: '플레이트는 베이스에 맞지 않습니다. 최소한으로만',
                params: { decaySec: 0.8, preDelayMs: 0, dampHz: 2500, diffusion: 0.6,
                          lowCutHz: 500, highCutHz: 4000, widthPct: 50, mixPct: 6 } },
    egtr:     { note: '중간 길이 플레이트. 스프링과 달리 색이 없어 리드에 잘 붙습니다',
                params: { decaySec: 2, preDelayMs: 20, dampHz: 6500, diffusion: 0.72,
                          lowCutHz: 220, highCutHz: 9000, widthPct: 115, mixPct: 22 } },
    agtr:     { note: '통기타에는 스프링이 아니라 플레이트입니다. 밝고 깨끗하게',
                params: { decaySec: 1.8, preDelayMs: 24, dampHz: 9000, diffusion: 0.75,
                          lowCutHz: 260, highCutHz: 14000, widthPct: 125, mixPct: 24 } },
    piano:    { note: '길고 부드럽게. 확산을 높여 화음이 뭉치지 않게 합니다',
                params: { decaySec: 3, preDelayMs: 26, dampHz: 8000, diffusion: 0.88,
                          lowCutHz: 180, highCutHz: 13000, widthPct: 120, mixPct: 26 } },
    strings:  { note: '가장 길게. 플레이트는 초기 반사가 없어서 섹션이 가까우면서 거대해집니다',
                params: { decaySec: 4.5, preDelayMs: 32, dampHz: 7000, diffusion: 0.9,
                          lowCutHz: 150, highCutHz: 11000, widthPct: 135, mixPct: 32 } },
    synth:    { note: '길고 넓게, 많이. 신스 패드에 플레이트를 깊게 거는 건 흔한 정답입니다',
                params: { decaySec: 5, preDelayMs: 14, dampHz: 7500, diffusion: 0.85,
                          lowCutHz: 240, highCutHz: 12000, widthPct: 140, mixPct: 40 } },
  }),

  ...inst('spring', {
    backing:  { note: '스프링은 백킹의 리버브가 아닙니다. 쓰더라도 얕게',
                params: { decaySec: 1.4, toneHz: 1100, dampHz: 3200, boing: 0.25, mixPct: 10 } },
    perc:     { note: '짧은 스프링은 퍼커션에 금속성을 더합니다',
                params: { decaySec: 0.9, toneHz: 1500, dampHz: 4000, boing: 0.3, mixPct: 12 } },
    brass:    { note: '금관에 스프링은 옛 소울 레코드의 소리입니다',
                params: { decaySec: 1.6, toneHz: 900, dampHz: 2800, boing: 0.35, mixPct: 14 } },
    winds:    { note: '목관에 스프링을 쓰는 일은 거의 없습니다',
                params: { decaySec: 0.8, toneHz: 1800, dampHz: 4500, boing: 0.12, mixPct: 6 } },
    fx:       { note: '길고 통통 튀게. 스프링의 바운스가 그대로 효과가 됩니다',
                params: { decaySec: 2.5, toneHz: 700, dampHz: 2200, boing: 0.6, mixPct: 16 } },
    vocal:    { note: '스프링은 보컬의 리버브가 아닙니다. 쓰더라도 겨우 들릴 만큼만',
                params: { decaySec: 1.2, toneHz: 1200, dampHz: 3000, boing: 0.2, mixPct: 8 } },
    drumloop: { note: '짧게. 스프링의 보잉이 드럼에서는 스프링이 튕기는 소리로 들킵니다',
                params: { decaySec: 0.9, toneHz: 1800, dampHz: 5000, boing: 0.3, mixPct: 12 } },
    bass:     { note: '스프링은 베이스와 상극입니다. 톤을 높여 저역을 피한 최소값',
                params: { decaySec: 0.7, toneHz: 2200, dampHz: 3000, boing: 0.2, mixPct: 8 } },
    egtr:     { note: '이 장치가 존재하는 이유입니다. 보잉을 크게 열어둡니다',
                params: { decaySec: 2.4, toneHz: 1200, dampHz: 4200, boing: 0.72, mixPct: 30 } },
    agtr:     { note: '통기타에 스프링은 대체로 오답이지만, 아주 옅으면 성격이 됩니다',
                params: { decaySec: 1.4, toneHz: 1600, dampHz: 6000, boing: 0.35, mixPct: 14 } },
    piano:    { note: '로파이 피아노용. 어쿠스틱 피아노에는 어울리지 않습니다',
                params: { decaySec: 1.8, toneHz: 1000, dampHz: 3500, boing: 0.45, mixPct: 18 } },
    strings:  { note: '거의 쓰지 않습니다. 톤을 높여 몸통을 피합니다',
                params: { decaySec: 2, toneHz: 2000, dampHz: 4500, boing: 0.25, mixPct: 12 } },
    synth:    { note: '보잉을 크게 — 신스에 스프링은 빈티지 장비 느낌을 만듭니다',
                params: { decaySec: 2.8, toneHz: 900, dampHz: 5500, boing: 0.65, mixPct: 28 } },
  }),

  ...inst('shimmer', {
    backing:  { note: '꼬리에 옥타브가 떠올라 백킹이 더 넓게 들립니다',
                params: { space: 12, decayPct: 160, shimmer: 0.35, loopMs: 210, preDelayMs: 40, lowCutHz: 320,
                          highCutHz: 11500, widthPct: 120, mixPct: 22 } },
    perc:     { note: '짧게 — 퍼커션에 시머가 길면 소음이 됩니다',
                params: { space: 8, decayPct: 120, shimmer: 0.2, loopMs: 180, preDelayMs: 25, lowCutHz: 400,
                          highCutHz: 14000, widthPct: 115, mixPct: 14 } },
    brass:    { note: '금관 위에 옥타브를 얹습니다',
                params: { space: 13, decayPct: 150, shimmer: 0.28, loopMs: 240, preDelayMs: 35, lowCutHz: 240,
                          highCutHz: 11000, widthPct: 110, mixPct: 18 } },
    winds:    { note: '플루트와 시머는 서로 닮아서 잘 섞입니다',
                params: { space: 9, decayPct: 140, shimmer: 0.32, loopMs: 230, preDelayMs: 30, lowCutHz: 260,
                          highCutHz: 12500, widthPct: 112, mixPct: 20 } },
    fx:       { note: '가장 길고 가장 많이 — 시머는 효과음에서 본래의 쓰임을 찾습니다',
                params: { space: 20, decayPct: 250, shimmer: 0.6, loopMs: 320, preDelayMs: 60, lowCutHz: 180,
                          highCutHz: 10000, widthPct: 140, mixPct: 50 } },
    vocal:    { note: '꼬리에 옥타브가 떠오릅니다. 발라드 마지막 음에 쓰는 장치입니다',
                params: { space: 10, decayPct: 150, shimmer: 0.25, loopMs: 200, preDelayMs: 40, lowCutHz: 300,
                          highCutHz: 11000, widthPct: 115, mixPct: 18 } },
    drumloop: { note: '드럼에 시머는 거의 안 씁니다. 심벌 꼬리에만 아주 옅게',
                params: { space: S('amb-wide'), decayPct: 90, shimmer: 0.2, loopMs: 140,
                          preDelayMs: 20, lowCutHz: 400, highCutHz: 10000,
                          widthPct: 110, mixPct: 10 } },
    bass:     { note: '옥타브 위로 올리면 베이스가 아니게 됩니다. 사실상 끈 값',
                params: { space: S('room-studio'), decayPct: 60, shimmer: 0.12, loopMs: 100,
                          preDelayMs: 0, lowCutHz: 600, highCutHz: 6000,
                          widthPct: 60, mixPct: 6 } },
    egtr:     { note: '앰비언트 기타. 시머가 파트를 만들어주는 대표 사례',
                params: { space: S('hall-concert'), decayPct: 150, shimmer: 0.55, loopMs: 200,
                          preDelayMs: 40, lowCutHz: 220, highCutHz: 10000,
                          widthPct: 125, mixPct: 35 } },
    agtr:     { note: '아르페지오 위에 옅게. 통기타는 이미 배음이 많아 조금만',
                params: { space: S('hall-recital'), decayPct: 120, shimmer: 0.35, loopMs: 180,
                          preDelayMs: 35, lowCutHz: 280, highCutHz: 13000,
                          widthPct: 120, mixPct: 24 } },
    piano:    { note: '길게, 옥타브를 옅게. 피아노 위의 시머는 금방 과해집니다',
                params: { space: S('hall-symphony'), decayPct: 170, shimmer: 0.3, loopMs: 220,
                          preDelayMs: 45, lowCutHz: 200, highCutHz: 12000,
                          widthPct: 125, mixPct: 26 } },
    strings:  { note: '아주 길게. 섹션 위 옥타브가 또 하나의 섹션처럼 들립니다',
                params: { space: S('hall-cathedral'), decayPct: 200, shimmer: 0.45, loopMs: 260,
                          preDelayMs: 50, lowCutHz: 160, highCutHz: 10000,
                          widthPct: 140, mixPct: 32 } },
    synth:    { note: '최대에 가깝게. 신스 패드와 시머는 사실상 한 악기입니다',
                params: { space: S('spec-infinite'), decayPct: 240, shimmer: 0.7, loopMs: 300,
                          preDelayMs: 25, lowCutHz: 240, highCutHz: 11000,
                          widthPct: 145, mixPct: 45 } },
  }),

  // ══ Imaging ════════════════════════════════════════════════════════════════

  ...inst('widener', {
    backing:  { note: '리드는 가운데, 백킹은 가장자리 — 이 대비가 믹스를 넓게 만듭니다',
                params: { width: 1.4, lowMonoHz: 240 } },
    perc:     { note: '퍼커션은 넓을수록 리듬이 커집니다',
                params: { width: 1.3, lowMonoHz: 200 } },
    brass:    { note: '섹션은 한 덩어리로. 거의 넓히지 않습니다',
                params: { width: 1.18, lowMonoHz: 220 } },
    winds:    { note: '조금만 — 넓히면 목관의 실체가 사라집니다',
                params: { width: 1.22, lowMonoHz: 95 } },
    fx:       { note: '가장 넓게 — 효과음은 스피커 바깥에서 들려야 합니다',
                params: { width: 1.9, lowMonoHz: 320 } },
    vocal:    { note: '리드는 가운데입니다. 280 Hz 아래를 모노로 묶고 폭은 거의 건드리지 않습니다',
                params: { width: 1.1, lowMonoHz: 280 } },
    drumloop: { note: '오버헤드를 벌리되 킥은 가운데 묶습니다',
                params: { width: 1.25, lowMonoHz: 140 } },
    bass:     { note: '폭 1.0 — 베이스는 넓히지 않습니다. 모노 지점을 높게 잡습니다',
                params: { width: 1, lowMonoHz: 300 } },
    egtr:     { note: '더블 트랙이 아닐 때 폭을 만듭니다',
                params: { width: 1.35, lowMonoHz: 160 } },
    agtr:     { note: '넓게. 통기타는 폭이 넓을수록 좋아지는 몇 안 되는 악기입니다',
                params: { width: 1.45, lowMonoHz: 180 } },
    piano:    { note: '자연 스테레오를 조금만 도와줍니다',
                params: { width: 1.15, lowMonoHz: 120 } },
    strings:  { note: '섹션은 넓어야 섹션입니다',
                params: { width: 1.5, lowMonoHz: 110 } },
    synth:    { note: '가장 넓게, 그러나 저역은 크게 묶습니다. 넓은 신스 저역이 모노를 무너뜨립니다',
                params: { width: 1.7, lowMonoHz: 260 } },
  }),

  ...inst('monomaker', {
    backing:  { note: '200 Hz 아래를 모노로 — 백킹의 저역이 넓으면 리드가 흐려집니다',
                params: { freqHz: 200, widthPct: 110 } },
    perc:     { note: '220 Hz 아래에는 퍼커션의 정보가 없습니다',
                params: { freqHz: 220, widthPct: 125 } },
    brass:    { note: '금관의 몸통은 낮습니다. 80 Hz 아래만 모노로',
                params: { freqHz: 80, widthPct: 112 } },
    winds:    { note: '105 Hz 아래만 — 목관의 몸통은 그보다 위에 있습니다',
                params: { freqHz: 105, widthPct: 128 } },
    fx:       { note: '240 Hz 아래를 모노로 묶어 리듬 파트와 부딪히지 않게 합니다',
                params: { freqHz: 240, widthPct: 160 } },
    vocal:    { note: '180 Hz 아래를 모노로. 베이스만큼 높일 필요는 없고, 폭은 그대로 둡니다',
                params: { freqHz: 180, widthPct: 102 } },
    drumloop: { note: '킥 대역을 모노로. 오버헤드는 그대로 둡니다',
                params: { freqHz: 130, widthPct: 115 } },
    bass:     { note: '300 Hz 아래 전부 모노. 베이스에서 이건 취향이 아니라 규칙입니다',
                params: { freqHz: 300, widthPct: 100 } },
    egtr:     { note: '앰프 저역만 모아줍니다',
                params: { freqHz: 150, widthPct: 120 } },
    agtr:     { note: '통울림만 모노로, 위는 넓게',
                params: { freqHz: 170, widthPct: 135 } },
    piano:    { note: '낮게 — 피아노 저역의 자연 스테레오를 너무 뺏지 않습니다',
                params: { freqHz: 100, widthPct: 108 } },
    strings:  { note: '첼로·콘트라베이스 대역을 모아 섹션 중심을 잡습니다',
                params: { freqHz: 120, widthPct: 140 } },
    synth:    { note: '가장 높게 — 신스 서브는 반드시 모노여야 합니다',
                params: { freqHz: 260, widthPct: 155 } },
  }),

  ...inst('haas', {
    backing:  { note: '하스로 백킹을 좌우로 벌립니다 — 이 장치가 가장 잘 쓰이는 자리',
                params: { delayMs: 13, amount: 0.52 } },
    perc:     { note: '짧은 지연으로 퍼커션을 한쪽으로 기울입니다',
                params: { delayMs: 11, amount: 0.32 } },
    brass:    { note: '섹션에는 얕게 — 금관이 좌우로 갈리면 한 덩어리가 아니게 됩니다',
                params: { delayMs: 20, amount: 0.38 } },
    winds:    { note: '목관에 하스는 음정을 흐립니다. 얕게',
                params: { delayMs: 24, amount: 0.42 } },
    fx:       { note: '가장 길고 가장 깊게 — 효과음은 모노로 합쳐지지 않아도 됩니다',
                params: { delayMs: 34, amount: 0.85 } },
    vocal:    { note: '리드 보컬에 하스는 위험합니다. 모노로 합쳐지면 목소리가 얇아집니다',
                params: { delayMs: 12, amount: 0.15 } },
    drumloop: { note: '루프에 하스는 위상을 망칩니다. 아주 짧게, 아주 약하게',
                params: { delayMs: 6, amount: 0.2 } },
    bass:     { note: '베이스에는 쓰지 않습니다. 흔적만 남긴 값',
                params: { delayMs: 3, amount: 0.1 } },
    egtr:     { note: '한 번 친 기타를 더블처럼 만듭니다. 하스가 제일 잘 먹히는 악기',
                params: { delayMs: 18, amount: 0.6 } },
    agtr:     { note: '넓게 — 통기타 한 트랙을 스테레오처럼 벌립니다',
                params: { delayMs: 22, amount: 0.65 } },
    piano:    { note: '이미 스테레오라 거의 필요 없습니다',
                params: { delayMs: 8, amount: 0.25 } },
    strings:  { note: '중간 정도. 섹션 폭을 조금 더 벌립니다',
                params: { delayMs: 16, amount: 0.45 } },
    synth:    { note: '가장 길게. 모노 신스를 넓히는 가장 싼 방법입니다',
                params: { delayMs: 28, amount: 0.7 } },
  }),

  // ══ Restore · Pitch ════════════════════════════════════════════════════════

  ...inst('denoise', {
    backing:  { note: '구절 사이의 룸톤. 여러 트랙이면 노이즈도 여러 겹입니다',
                params: { thresholdDb: -52, amount: 0.45, releaseMs: 240 } },
    perc:     { note: '짧은 릴리즈로 — 퍼커션의 꼬리는 원래 짧습니다',
                params: { thresholdDb: -50, amount: 0.3, releaseMs: 100 } },
    brass:    { note: '금관은 시끄러워서 노이즈가 묻힙니다. 얕게',
                params: { thresholdDb: -46, amount: 0.22, releaseMs: 180 } },
    winds:    { note: '숨소리를 지우지 않도록 아주 얕게',
                params: { thresholdDb: -64, amount: 0.15, releaseMs: 280 } },
    fx:       { note: '합성 소스에는 노이즈가 거의 없습니다',
                params: { thresholdDb: -76, amount: 0.06, releaseMs: 160 } },
    vocal:    { note: '구절 사이의 룸톤만. 많이 걸면 숨소리가 수중음이 됩니다',
                params: { thresholdDb: -56, amount: 0.4, releaseMs: 220 } },
    drumloop: { note: '루프에는 잔향이 노이즈처럼 보입니다. 아주 약하게',
                params: { thresholdDb: -58, amount: 0.2, releaseMs: 80 } },
    bass:     { note: '앰프 히스를 낮은 문턱에서. 릴리스를 길게 해야 저음이 안 잘립니다',
                params: { thresholdDb: -54, amount: 0.35, releaseMs: 260 } },
    egtr:     { note: '하이게인 앰프 노이즈. 이 악기에서 가장 자주 필요합니다',
                params: { thresholdDb: -48, amount: 0.5, releaseMs: 150 } },
    agtr:     { note: '룸 노이즈만. 세게 걸면 통기타 고역이 같이 사라집니다',
                params: { thresholdDb: -60, amount: 0.28, releaseMs: 200 } },
    piano:    { note: '페달 노이즈와 룸 톤. 약하게, 길게',
                params: { thresholdDb: -62, amount: 0.25, releaseMs: 300 } },
    strings:  { note: '가장 약하게 — 스트링에서 디노이즈는 활 소리를 먼저 지웁니다',
                params: { thresholdDb: -66, amount: 0.18, releaseMs: 350 } },
    synth:    { note: '신스는 노이즈가 없습니다. 샘플 소스용 최소값',
                params: { thresholdDb: -70, amount: 0.12, releaseMs: 120 } },
  }),

  ...inst('hum', {
    backing:  { note: '험은 건물의 사실입니다 — 같은 마이크로 잡힌 보컬과 같은 답을 씁니다',
                params: { baseHz: 60, harmonics: 7, q: 52 } },
    perc:     { note: '같은 이유로 드럼 루프와 같은 답을 씁니다',
                params: { baseHz: 60, harmonics: 3, q: 28 } },
    brass:    { note: '스트링과 같은 답 — 큰 소리로 녹음된 어쿠스틱 소스입니다',
                params: { baseHz: 60, harmonics: 1, q: 54 } },
    winds:    { note: '스트링과 같은 답 — 같은 방에서 같은 마이크로 잡힌 소스입니다',
                params: { baseHz: 60, harmonics: 1, q: 54 } },
    fx:       { note: '합성 소스에는 험이 없습니다. 신스와 같은 답',
                params: { baseHz: 60, harmonics: 6, q: 50 } },
    vocal:    { note: '마이크는 조명과 전원을 가장 잘 줍습니다 — 배음을 높게 보고 Q 는 좁게',
                params: { baseHz: 60, harmonics: 7, q: 52 } },
    drumloop: { note: '루프에 험이 있는 경우는 드뭅니다. 기본 배음만',
                params: { baseHz: 60, harmonics: 3, q: 28 } },
    bass:     { note: '베이스 앰프 험. 저역 배음이 실제로 겹치므로 Q 를 좁게',
                params: { baseHz: 60, harmonics: 5, q: 38 } },
    egtr:     { note: '싱글코일 험. 이 악기가 이 장치의 주 고객입니다 — 배음을 많이',
                params: { baseHz: 60, harmonics: 8, q: 46 } },
    agtr:     { note: '픽업 통기타의 험. 중간 정도',
                params: { baseHz: 60, harmonics: 4, q: 34 } },
    piano:    { note: '마이크 라인 험만. 배음은 적게, Q 는 넓지 않게',
                params: { baseHz: 60, harmonics: 2, q: 42 } },
    strings:  { note: '기본파 하나만, Q 를 가장 좁게 — 스트링 몸통을 건드리면 안 됩니다',
                params: { baseHz: 60, harmonics: 1, q: 54 } },
    synth:    { note: '아날로그 신스의 전원 험. 하드웨어를 녹음했을 때만',
                params: { baseHz: 60, harmonics: 6, q: 50 } },
  }),

  ...inst('pitchcorrect', {
    backing:  { note: '백킹은 리드보다 더 잡습니다 — 겹쳐 부른 음정의 오차는 합쳐서 들립니다',
                params: { amount: 0.75, formant: 0 } },
    perc:     { note: '음정이 없는 소스입니다. 드럼 루프와 같은 답',
                params: { amount: 0.05, formant: 0 } },
    brass:    { note: '섹션은 화음이라 단음 추적이 되지 않습니다. 스트링과 같은 답',
                params: { amount: 0.18, formant: 0 } },
    winds:    { note: '같은 이유로 스트링과 같은 답',
                params: { amount: 0.18, formant: 0 } },
    fx:       { note: '음정이라는 것이 없습니다. 드럼 루프와 같은 답',
                params: { amount: 0.05, formant: 0 } },
    vocal:    { note: '이 장치의 본래 자리입니다. 현대 팝은 들리기 직전까지 — 발라드라면 0.3 아래로',
                params: { amount: 0.65, formant: 0 } },
    drumloop: { note: '드럼에 피치 보정은 의미가 없습니다. 사실상 끈 값',
                params: { amount: 0.05, formant: 0 } },
    bass:     { note: '베이스 인토네이션을 약하게 잡습니다. 세게 걸면 음이 계단처럼 됩니다',
                params: { amount: 0.35, formant: 0 } },
    egtr:     { note: '벤딩을 지우면 안 되므로 약하게',
                params: { amount: 0.25, formant: 0 } },
    agtr:     { note: '튜닝이 살짝 어긋난 통기타를 부드럽게 당깁니다. 여기서 가장 세게',
                params: { amount: 0.45, formant: 0 } },
    piano:    { note: '피아노는 조율된 악기입니다. 보정할 것이 거의 없습니다',
                params: { amount: 0.12, formant: 0 } },
    strings:  { note: '비브라토를 죽이지 않도록 아주 약하게',
                params: { amount: 0.18, formant: 0 } },
    synth:    { note: '신스 자체는 정확합니다. 샘플 소스를 붙일 때를 위해 가장 높게',
                params: { amount: 0.55, formant: 0 } },
  }),
];
