// Rooms, and how to make one out of numbers.
//
// A reverb preset is usually a bag of knob positions.  This is a bag of ROOMS:
// a size in metres, a decay time, how much the walls eat the top end, how fast
// the reflections pile up.  From that an impulse response is synthesised, and
// the convolver plays it.  The difference matters because the parameters then
// mean something — doubling `size` moves the walls, and the early reflections
// move with them, because they were computed from where the walls are.
//
// ── How an IR is built here ────────────────────────────────────────────────
//
//   1. EARLY REFLECTIONS — a real image-source model.  A shoebox with the
//      space's proportions, a source and a listener placed off-centre in it,
//      and every mirrored image up to order 2 on each axis.  Each image is one
//      tap: delayed by its distance, attenuated by 1/distance, and panned by
//      which side of the listener it arrives from.  That is why a small room
//      sounds small — the first reflection really is 8 ms away.
//
//   2. THE LATE TAIL — dense decorrelated noise, but not ONE noise with ONE
//      envelope.  Three bands, three decay times: bass rings longer in stone
//      and dies faster in a wooden room, and the top end is always the first
//      thing a room absorbs.  A single-envelope tail is the sound everyone
//      recognises as "cheap reverb", and this is the reason why.
//
//   3. THE JOIN — the tail fades in under the reflections over a build time
//      taken from the space's diffusion.  A plate is dense instantly; an open
//      air stage never really becomes dense at all.
//
// ── Two rules the whole file obeys ─────────────────────────────────────────
//
// DETERMINISTIC.  Every random number comes from a seeded LCG, never from
// `Math.random`.  A bounce has to be identical to what was monitored, and an
// IR built from real randomness would make every render a different room.
//
// NORMALISED BY ENERGY.  Every IR is scaled to the same total energy, so
// changing the decay from 0.4 s to 6 s changes the room and not the level.
// Convolver normalisation is turned off in the devices for the same reason —
// the browser's formula is not ours and would put the level back.

export type SpaceGroup = 'live' | 'hall' | 'room' | 'plate' | 'ambience' | 'special';

/** How the tail departs from a plain exponential, where it does. */
export type TailShape = 'exp' | 'gated' | 'reverse' | 'nonlinear';

export interface Space {
  id: string;
  name: string;
  group: SpaceGroup;
  /** Mid-band RT60 — the time to fall 60 dB. */
  rt60Sec: number;
  /** Longest wall, in metres.  Sets the reflection pattern and the pre-delay. */
  sizeM: number;
  /** How fast reflections become dense: 0 slapback, 1 instantly diffuse. */
  diffusion: number;
  /** High-frequency absorption: 0 stone and glass, 1 curtains and bodies. */
  damping: number;
  /** Bass decay relative to mid.  >1 stone, <1 wood and carpet. */
  bassMult: number;
  /** Early reflections relative to the tail, in dB. */
  erDb: number;
  /** Spread of the reflection pattern, 0 mono … 1 fully decorrelated. */
  width: number;
  shape: TailShape;
  /** One line, shown under the picker. */
  note: string;
}

// ── The catalogue ───────────────────────────────────────────────────────────
//
// Grouped the way you would choose one: what KIND of place is this.  The
// numbers are plausible rather than measured — a real cathedral is 6-ish
// seconds with a long bass tail and almost no absorption up top, and that is
// what is written here.

export const SPACES: readonly Space[] = [
  // ── 라이브 — stages, and the rooms an audience is standing in ────────────
  { id: 'live-monitor',  name: '스테이지 모니터',   group: 'live', rt60Sec: 0.34, sizeM: 6,  diffusion: 0.45, damping: 0.62, bassMult: 0.85, erDb: 3,   width: 0.55, shape: 'exp',
    note: '무대 위에서 자기 소리로 돌아오는 만큼. 존재감만 주고 사라집니다' },
  { id: 'live-rehearsal', name: '합주실',          group: 'live', rt60Sec: 0.72, sizeM: 9,  diffusion: 0.55, damping: 0.55, bassMult: 1.15, erDb: 2,   width: 0.6,  shape: 'exp',
    note: '흡음재 붙인 작은 방. 저역이 조금 남습니다' },
  { id: 'live-club',     name: '소극장 · 클럽',     group: 'live', rt60Sec: 1.1,  sizeM: 13, diffusion: 0.62, damping: 0.5,  bassMult: 1.1,  erDb: 1,   width: 0.7,  shape: 'exp',
    note: '사람이 찬 클럽. 벽이 가깝고 저역이 뭉칩니다' },
  { id: 'live-house',    name: '라이브하우스',      group: 'live', rt60Sec: 1.6,  sizeM: 20, diffusion: 0.7,  damping: 0.42, bassMult: 1.05, erDb: 0,   width: 0.78, shape: 'exp',
    note: '500석 규모. 밴드 사운드의 기본값' },
  { id: 'live-theatre',  name: '극장 무대',        group: 'live', rt60Sec: 1.45, sizeM: 24, diffusion: 0.66, damping: 0.5,  bassMult: 1.0,  erDb: 2,   width: 0.72, shape: 'exp',
    note: '객석은 흡음, 무대는 반사. 앞은 마르고 뒤는 웁니다' },
  { id: 'live-arena',    name: '아레나',           group: 'live', rt60Sec: 3.2,  sizeM: 55, diffusion: 0.6,  damping: 0.3,  bassMult: 1.25, erDb: -2,  width: 0.85, shape: 'exp',
    note: '체육관. 저역이 오래 남고 딜레이가 들립니다' },
  { id: 'live-stadium',  name: '스타디움',         group: 'live', rt60Sec: 5.0,  sizeM: 90, diffusion: 0.45, damping: 0.25, bassMult: 1.35, erDb: -3,  width: 0.9,  shape: 'exp',
    note: '반대편 스탠드에서 돌아오는 소리까지' },
  { id: 'live-openair',  name: '야외 무대',        group: 'live', rt60Sec: 0.95, sizeM: 42, diffusion: 0.18, damping: 0.45, bassMult: 0.9,  erDb: 4,   width: 0.88, shape: 'exp',
    note: '천장이 없습니다. 반사는 몇 개뿐이고 그게 전부입니다' },

  // ── 홀 — built to sound like this ───────────────────────────────────────
  { id: 'hall-recital',  name: '리사이틀 홀',      group: 'hall', rt60Sec: 1.7,  sizeM: 22, diffusion: 0.82, damping: 0.4,  bassMult: 1.1,  erDb: -1,  width: 0.8,  shape: 'exp',
    note: '독주회장. 악기 하나가 자연스럽게 들리는 크기' },
  { id: 'hall-scoring',  name: '스코어링 스테이지', group: 'hall', rt60Sec: 1.9,  sizeM: 35, diffusion: 0.85, damping: 0.38, bassMult: 1.05, erDb: -2,  width: 0.85, shape: 'exp',
    note: '영화 음악을 녹음하는 방. 크지만 명료합니다' },
  { id: 'hall-concert',  name: '콘서트 홀',        group: 'hall', rt60Sec: 2.2,  sizeM: 42, diffusion: 0.88, damping: 0.32, bassMult: 1.15, erDb: -3,  width: 0.88, shape: 'exp',
    note: '오케스트라 기본값. 넓고 따뜻합니다' },
  { id: 'hall-symphony', name: '심포니 홀',        group: 'hall', rt60Sec: 2.8,  sizeM: 55, diffusion: 0.9,  damping: 0.26, bassMult: 1.2,  erDb: -4,  width: 0.92, shape: 'exp',
    note: '더 크고 더 깁니다. 솔로에 걸면 묻힙니다' },
  { id: 'hall-church',   name: '석조 교회',        group: 'hall', rt60Sec: 3.6,  sizeM: 46, diffusion: 0.86, damping: 0.16, bassMult: 1.35, erDb: -3,  width: 0.9,  shape: 'exp',
    note: '돌은 흡음하지 않습니다. 고역까지 같이 남습니다' },
  { id: 'hall-cathedral', name: '대성당',          group: 'hall', rt60Sec: 6.0,  sizeM: 80, diffusion: 0.9,  damping: 0.12, bassMult: 1.45, erDb: -6,  width: 0.95, shape: 'exp',
    note: '6초. 가사가 겹치기 시작하는 지점입니다' },

  // ── 룸 — where things are actually recorded ──────────────────────────────
  { id: 'room-booth',    name: '보컬 부스',        group: 'room', rt60Sec: 0.22, sizeM: 3,  diffusion: 0.35, damping: 0.75, bassMult: 0.8,  erDb: 4,   width: 0.4,  shape: 'exp',
    note: '거의 무향. 마이크가 방 안에 있다는 것만 알려줍니다' },
  { id: 'room-bedroom',  name: '침실',            group: 'room', rt60Sec: 0.36, sizeM: 5,  diffusion: 0.42, damping: 0.8,  bassMult: 1.2,  erDb: 3,   width: 0.5,  shape: 'exp',
    note: '카펫과 이불. 고역이 먼저 죽습니다' },
  { id: 'room-studio',   name: '스튜디오 룸',      group: 'room', rt60Sec: 0.52, sizeM: 8,  diffusion: 0.6,  damping: 0.55, bassMult: 1.0,  erDb: 2,   width: 0.62, shape: 'exp',
    note: '컨트롤된 방. 아무것도 강조하지 않습니다' },
  { id: 'room-drum',     name: '드럼 룸',         group: 'room', rt60Sec: 0.9,  sizeM: 11, diffusion: 0.58, damping: 0.4,  bassMult: 1.25, erDb: 3,   width: 0.75, shape: 'exp',
    note: '나무 바닥, 높은 천장. 오버헤드에 붙이면 킷이 커집니다' },
  { id: 'room-wood',     name: '우드 라이브룸',    group: 'room', rt60Sec: 1.15, sizeM: 15, diffusion: 0.7,  damping: 0.45, bassMult: 0.92, erDb: 1,   width: 0.78, shape: 'exp',
    note: '나무는 저역을 먹습니다. 중역이 남아서 따뜻합니다' },
  { id: 'room-tile',     name: '타일 룸',         group: 'room', rt60Sec: 1.5,  sizeM: 7,  diffusion: 0.5,  damping: 0.06, bassMult: 0.85, erDb: 2,   width: 0.55, shape: 'exp',
    note: '욕실. 작은데 오래 갑니다 — 고역이 하나도 안 죽어서' },
  { id: 'room-hallway',  name: '복도',            group: 'room', rt60Sec: 1.05, sizeM: 18, diffusion: 0.3,  damping: 0.35, bassMult: 1.05, erDb: 4,   width: 0.45, shape: 'exp',
    note: '길고 좁습니다. 반사가 앞뒤로만 옵니다' },

  // ── 플레이트 · 챔버 — machines that pretend to be rooms ─────────────────
  { id: 'plate-vintage', name: '빈티지 플레이트',   group: 'plate', rt60Sec: 2.4, sizeM: 4, diffusion: 1,    damping: 0.34, bassMult: 0.7,  erDb: -18, width: 0.85, shape: 'exp',
    note: '철판. 첫 샘플부터 밀도가 꽉 찹니다 — 초기 반사가 없습니다' },
  { id: 'plate-bright',  name: '브라이트 플레이트', group: 'plate', rt60Sec: 1.9, sizeM: 4, diffusion: 1,    damping: 0.1,  bassMult: 0.6,  erDb: -18, width: 0.9,  shape: 'exp',
    note: '스네어용. 고역이 안 죽어서 뒤에서 반짝입니다' },
  { id: 'plate-vocal',   name: '보컬 플레이트',    group: 'plate', rt60Sec: 2.1, sizeM: 4, diffusion: 1,    damping: 0.45, bassMult: 0.55, erDb: -18, width: 0.8,  shape: 'exp',
    note: '저역을 미리 덜어낸 플레이트. 보컬 뒤에서 안 뭉칩니다' },
  { id: 'chamber-echo',  name: '에코 챔버',       group: 'plate', rt60Sec: 2.6, sizeM: 9, diffusion: 0.78, damping: 0.22, bassMult: 1.15, erDb: -2,  width: 0.7,  shape: 'exp',
    note: '스피커와 마이크를 넣어둔 콘크리트 방. 플레이트보다 거칩니다' },

  // ── 앰비언스 — glue, not an effect ───────────────────────────────────────
  { id: 'amb-close',     name: '클로즈 앰비언스',   group: 'ambience', rt60Sec: 0.28, sizeM: 6,  diffusion: 0.5, damping: 0.6,  bassMult: 0.9, erDb: 6,  width: 0.55, shape: 'exp',
    note: '드라이한 소스에 공기만 붙입니다. 리버브로 들리면 너무 많은 겁니다' },
  { id: 'amb-wide',      name: '와이드 앰비언스',   group: 'ambience', rt60Sec: 0.6,  sizeM: 14, diffusion: 0.55, damping: 0.5, bassMult: 1.0, erDb: 5,  width: 0.95, shape: 'exp',
    note: '넓게만 벌립니다. 버스에 살짝 걸어 트랙들을 한 방에 모읍니다' },
  { id: 'amb-slap',      name: '슬랩백 룸',        group: 'ambience', rt60Sec: 0.42, sizeM: 20, diffusion: 0.12, damping: 0.4, bassMult: 0.95, erDb: 8, width: 0.6, shape: 'exp',
    note: '반사 몇 개가 또렷하게 들립니다. 로커빌리 보컬' },

  // ── 특수 — rooms that do not exist ───────────────────────────────────────
  { id: 'spec-gated',    name: '게이트 드럼',      group: 'special', rt60Sec: 2.2, sizeM: 18, diffusion: 0.8, damping: 0.3, bassMult: 1.1, erDb: 0,  width: 0.8, shape: 'gated',
    note: '80년대 스네어. 방이 갑자기 없어집니다' },
  { id: 'spec-reverse',  name: '리버스 스웰',      group: 'special', rt60Sec: 1.8, sizeM: 20, diffusion: 0.85, damping: 0.35, bassMult: 1.0, erDb: -6, width: 0.85, shape: 'reverse',
    note: '거꾸로 감긴 테이프. 소리 뒤에서 차오릅니다' },
  { id: 'spec-nonlin',   name: '논리니어 홀',      group: 'special', rt60Sec: 2.6, sizeM: 30, diffusion: 0.85, damping: 0.3, bassMult: 1.1, erDb: -2, width: 0.85, shape: 'nonlinear',
    note: '빨리 줄었다가 낮은 데서 오래 버팁니다. 밀도가 죽지 않습니다' },
  { id: 'spec-infinite', name: '무한 공간',        group: 'special', rt60Sec: 11,  sizeM: 70, diffusion: 0.92, damping: 0.2, bassMult: 1.2, erDb: -9, width: 0.95, shape: 'exp',
    note: '끝나지 않습니다. 패드와 앰비언트용' },
];

export const SPACE_GROUP_LABEL: Record<SpaceGroup, string> = {
  live: '라이브 · 무대',
  hall: '홀',
  room: '룸',
  plate: '플레이트 · 챔버',
  ambience: '앰비언스',
  special: '특수',
};

export function spaceAt(index: number): Space {
  const i = Math.max(0, Math.min(SPACES.length - 1, Math.round(index)));
  return SPACES[i]!;
}

export function spaceIndex(id: string): number {
  const i = SPACES.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

/** Names in catalogue order, for a picker. */
export function spaceChoices(): string[] {
  return SPACES.map((s) => `${SPACE_GROUP_LABEL[s.group]} · ${s.name}`);
}

/** What each space is, in one line — shown under the picker. */
export function spaceNotes(): string[] {
  return SPACES.map((s) => `${s.rt60Sec.toFixed(1)}초 · ${s.sizeM} m — ${s.note}`);
}

// ── The synthesiser ─────────────────────────────────────────────────────────

export interface IrOptions {
  sampleRate: number;
  /** Scales the room's dimensions.  1 is the space as catalogued. */
  sizeScale?: number;
  /** Scales the decay time.  1 is the space as catalogued. */
  decayScale?: number;
  /** Absolute HF absorption, overriding the space's own. */
  damping?: number;
  /** Scales the stereo spread.  0 collapses the room to mono. */
  widthScale?: number;
  /** Which half to build — the devices use both, separately. */
  part?: 'full' | 'early' | 'tail';
  /** For gated and reverse shapes: how long the room lasts, in ms. */
  holdMs?: number;
  seed?: number;
}

export interface SynthesisedIr {
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
  frames: number;
  sampleRate: number;
  /** What the tail actually decays with, after scaling — for the display. */
  rt60Sec: number;
}

/** Speed of sound, m/s, at something like room temperature. */
const C = 343;

/** −60 dB is what a decay time means: e^(−6.9078 · t/RT60). */
const LN_MILLION = 6.907755;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A seeded LCG.  A bounce must be the same room as the monitor was. */
function rng(seed: number): () => number {
  let state = (seed | 0) || 0x2545f491;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x7fffffff - 1;   // −1 … 1
  };
}

export interface EarlyTap {
  timeSec: number;
  gain: number;
  /** −1 hard left … +1 hard right. */
  pan: number;
}

/**
 * Every mirrored image of the source, up to order 2 per axis.
 *
 * A shoebox of the space's proportions, with the source and the listener
 * placed off-centre so no two images land on the same sample.  Symmetry is the
 * enemy here: a centred source in a symmetric room produces coincident taps,
 * which is a comb filter rather than a room.
 */
export function earlyTaps(space: Space, opts: IrOptions): EarlyTap[] {
  const size = Math.max(1, space.sizeM * (opts.sizeScale ?? 1));
  const rt60 = Math.max(0.05, space.rt60Sec * (opts.decayScale ?? 1));

  // Proportions of a room that does not ring: no dimension a simple multiple
  // of another.
  const lx = size;
  const ly = size * 0.79;
  const lz = Math.max(2.4, size * 0.43);

  const src = { x: lx * 0.32, y: ly * 0.41, z: lz * 0.45 };
  const mic = { x: lx * 0.63, y: ly * 0.58, z: lz * 0.52 };
  const direct = Math.hypot(src.x - mic.x, src.y - mic.y, src.z - mic.z);

  const taps: EarlyTap[] = [];
  const order = 2;
  for (let ix = -order; ix <= order; ix++) {
    for (let iy = -order; iy <= order; iy++) {
      for (let iz = -order; iz <= order; iz++) {
        if (ix === 0 && iy === 0 && iz === 0) continue;   // the direct sound is not a reflection
        // Mirror the source across each wall pair.
        const x = ix % 2 === 0 ? ix * lx + src.x : (ix + 1) * lx - src.x;
        const y = iy % 2 === 0 ? iy * ly + src.y : (iy + 1) * ly - src.y;
        const z = iz % 2 === 0 ? iz * lz + src.z : (iz + 1) * lz - src.z;
        const dx = x - mic.x;
        const dy = y - mic.y;
        const dz = z - mic.z;
        const distance = Math.hypot(dx, dy, dz);
        const timeSec = (distance - direct) / C;
        if (timeSec <= 0) continue;
        // Spherical spreading, then the room's own decay law.  Both are
        // needed: 1/d alone makes a big room quiet rather than long.
        const spread = direct / distance;
        const decay = Math.exp(-LN_MILLION * timeSec / rt60);
        const gain = spread * decay;
        if (gain < 1e-4) continue;
        taps.push({ timeSec, gain, pan: clamp(dx / Math.max(1, distance) * 1.6, -1, 1) });
      }
    }
  }
  taps.sort((a, b) => a.timeSec - b.timeSec);

  // Diffusion is how many surfaces there are to bounce off.  An open-air stage
  // has a few and a plate has more than can be counted, and keeping all 124
  // images for both would make them the same room.  Cutting from the late end
  // keeps the ones that define the size — the first arrivals.
  const keep = Math.max(4, Math.round(6 + 118 * clamp(space.diffusion, 0, 1)));
  const kept = taps.slice(0, keep);

  // A shoebox produces images that land on the same sample; identical delays
  // are a comb filter, not a room.  A sub-millisecond deterministic jitter
  // breaks the ties without moving anything audibly.
  const jitter = rng(0x7f4a7c15);
  for (const tap of kept) {
    tap.timeSec = Math.max(0, tap.timeSec + jitter() * 0.00035);
  }
  kept.sort((a, b) => a.timeSec - b.timeSec);
  return kept;
}

/** Where the tail has taken over, in seconds. */
function buildSec(space: Space, opts: IrOptions): number {
  const size = Math.max(1, space.sizeM * (opts.sizeScale ?? 1));
  // A big room takes longer to become dense, and a diffuse one takes less.
  const base = (size / C) * 2.2;
  return base * (1.6 - space.diffusion) + 0.004;
}

/** The IR's length: the decay plus the room's own build-up, capped. */
export function irLengthSec(space: Space, opts: IrOptions): number {
  const rt60 = Math.max(0.05, space.rt60Sec * (opts.decayScale ?? 1));
  if (space.shape === 'gated' || space.shape === 'reverse') {
    return clamp((opts.holdMs ?? 260) / 1000 + 0.03, 0.05, 4);
  }
  return clamp(rt60 * 1.05 + buildSec(space, opts), 0.05, 12);
}

/**
 * One-pole lowpass, in place, forwards.
 *
 * Used to split the noise into bands.  A one-pole is a gentle split, which is
 * what is wanted: sharp band edges in a reverb tail are audible as resonances.
 */
function onePole(input: Float32Array, out: Float32Array, cutoffHz: number, sampleRate: number): void {
  const a = Math.exp(-2 * Math.PI * Math.min(0.45 * sampleRate, cutoffHz) / sampleRate);
  let z = 0;
  for (let i = 0; i < input.length; i++) {
    z = input[i]! * (1 - a) + z * a;
    out[i] = z;
  }
}

/**
 * Build the impulse response for a space.
 *
 * `part` splits it: 'early' is the image-source taps alone, 'tail' the diffuse
 * field alone.  The Space Reverb builds both and mixes them with its own
 * faders, which is the only way an ER/tail balance can be a real control
 * rather than a tone knob.
 */
export function renderIr(space: Space, opts: IrOptions): SynthesisedIr {
  const sampleRate = opts.sampleRate;
  const part = opts.part ?? 'full';
  const rt60 = clamp(space.rt60Sec * (opts.decayScale ?? 1), 0.05, 14);
  const damping = clamp(opts.damping ?? space.damping, 0, 1);
  const width = clamp(space.width * (opts.widthScale ?? 1), 0, 1);
  const lengthSec = irLengthSec(space, { ...opts, decayScale: rt60 / space.rt60Sec });
  const frames = Math.max(8, Math.round(sampleRate * lengthSec));

  const left = new Float32Array(frames) as Float32Array<ArrayBuffer>;
  const right = new Float32Array(frames) as Float32Array<ArrayBuffer>;

  // ── Early reflections ────────────────────────────────────────────────────
  if (part !== 'tail') {
    const erGain = Math.pow(10, space.erDb / 20);
    for (const tap of earlyTaps(space, { ...opts, decayScale: rt60 / space.rt60Sec })) {
      const index = Math.round(tap.timeSec * sampleRate);
      if (index >= frames) continue;
      // Constant power, and narrowed by the width control along with the tail.
      const pan = tap.pan * width;
      const l = Math.cos((pan + 1) * Math.PI / 4);
      const r = Math.sin((pan + 1) * Math.PI / 4);
      // Absorption on each bounce shows up as a duller reflection; modelled as
      // a simple loss that grows with arrival time.
      const absorb = Math.exp(-damping * tap.timeSec * 6);
      left[index] = left[index]! + tap.gain * l * erGain * absorb;
      right[index] = right[index]! + tap.gain * r * erGain * absorb;
    }
  }

  // ── The diffuse tail ─────────────────────────────────────────────────────
  if (part !== 'early') {
    const build = buildSec(space, { ...opts, decayScale: rt60 / space.rt60Sec });
    const hfMult = clamp(1 - 0.78 * damping, 0.1, 1.2);
    const loMult = clamp(space.bassMult, 0.2, 2.2);
    const hold = (opts.holdMs ?? 260) / 1000;

    // The three band envelopes, computed once for both channels.
    //
    // An exponential decay is a geometric sequence, so it is one multiply per
    // sample rather than a `Math.exp`.  That matters: the longest space is
    // eleven seconds, and three transcendentals per sample per channel took
    // most of half a second — long enough to see as a stall when picking a
    // room from the list.
    const envLow = new Float32Array(frames);
    const envMid = new Float32Array(frames);
    const envHigh = new Float32Array(frames);

    /** Per-sample ratio of a −60 dB-in-`seconds` decay. */
    const ratio = (seconds: number): number =>
      Math.exp(-LN_MILLION / (Math.max(1e-4, seconds) * sampleRate));

    // A band's decay time IS the multiplier: the low band of a stone room
    // decays over `rt60 · bassMult`, and that is the only place the band
    // differs.  The gate and the reverse swell are the same shape in every
    // band — a gate closing at different times per band would be a crossover,
    // not a gate.
    const fill = (out: Float32Array, seconds: number, weight: number): void => {
      if (space.shape === 'reverse') {
        const span = Math.max(0.02, hold);
        for (let i = 0; i < frames; i++) {
          const u = (i / sampleRate) / span;
          out[i] = u <= 1 ? weight * u * u : 0;
        }
        return;
      }
      if (space.shape === 'nonlinear') {
        // Two slopes: a fast one that sets the initial impression, and a slow
        // floor underneath it that keeps the density up.
        let fast = 1;
        let slow = 0.4;
        const rFast = ratio(seconds * 0.35);
        const rSlow = ratio(seconds);
        for (let i = 0; i < frames; i++) {
          out[i] = weight * Math.max(fast, slow);
          fast *= rFast;
          slow *= rSlow;
        }
        return;
      }
      if (space.shape === 'gated') {
        const fade = 0.008;
        let env = 1;
        // Even a gated room decays a little before the gate shuts.
        const r = ratio(seconds * 2.5);
        for (let i = 0; i < frames; i++) {
          const t = i / sampleRate;
          const gate = t < hold ? 1
            : t < hold + fade ? 0.5 * (1 + Math.cos(Math.PI * (t - hold) / fade))
              : 0;
          out[i] = weight * env * gate;
          env *= r;
        }
        return;
      }
      let env = 1;
      const r = ratio(seconds);
      for (let i = 0; i < frames; i++) {
        out[i] = weight * env;
        env *= r;
      }
    };

    fill(envLow, rt60 * loMult, 1.35);
    fill(envMid, rt60, 1);
    fill(envHigh, rt60 * hfMult, 0.85);

    // The join: the tail fades in under the reflections, smoothstepped.
    if (space.shape !== 'reverse' && build > 0) {
      const buildFrames = Math.min(frames, Math.round(build * sampleRate));
      for (let i = 0; i < buildFrames; i++) {
        const rise = i / buildFrames;
        const fadeIn = rise * rise * (3 - 2 * rise);
        envLow[i] = envLow[i]! * fadeIn;
        envMid[i] = envMid[i]! * fadeIn;
        envHigh[i] = envHigh[i]! * fadeIn;
      }
    }

    const noise = new Float32Array(frames);
    const band = new Float32Array(frames);
    const bandHi = new Float32Array(frames);

    for (let c = 0; c < 2; c++) {
      const target = c === 0 ? left : right;
      const next = rng((opts.seed ?? 0x51ed270b) + c * 0x9e3779b9);
      for (let i = 0; i < frames; i++) noise[i] = next();

      onePole(noise, band, 240, sampleRate);      // low band
      onePole(noise, bandHi, 3400, sampleRate);   // low + mid

      for (let i = 0; i < frames; i++) {
        const low = band[i]!;
        const mid = bandHi[i]! - low;
        const high = noise[i]! - bandHi[i]!;
        target[i] = target[i]! + low * envLow[i]! + mid * envMid[i]! + high * envHigh[i]!;
      }
    }

    // Narrow by blending the two decorrelated noises toward their average.
    if (width < 1) {
      const k = (1 - width) / 2;
      for (let i = 0; i < frames; i++) {
        const l = left[i]!;
        const r = right[i]!;
        left[i] = l * (1 - k) + r * k;
        right[i] = r * (1 - k) + l * k;
      }
    }
  }

  // ── Energy normalisation ─────────────────────────────────────────────────
  //
  // Every IR carries the same energy, so the space picker changes the room and
  // not the level.  Without this a 6-second cathedral is 14 dB louder than a
  // vocal booth and every A/B is a loudness comparison.
  let energy = 0;
  for (let i = 0; i < frames; i++) energy += left[i]! * left[i]! + right[i]! * right[i]!;
  const rms = Math.sqrt(energy / 2);
  const scale = rms > 1e-9 ? IR_ENERGY_TARGET / rms : 0;
  for (let i = 0; i < frames; i++) {
    left[i] = left[i]! * scale;
    right[i] = right[i]! * scale;
  }

  return { left, right, frames, sampleRate, rt60Sec: rt60 };
}

/**
 * The energy every IR is scaled to.
 *
 * Picked so a mid-length space at 100 % wet sits a few dB under the dry
 * signal — loud enough to hear what the room is doing, quiet enough that
 * turning the mix up is a decision rather than a rescue.
 */
export const IR_ENERGY_TARGET = 0.6;

// ── Buffers, with a cache ───────────────────────────────────────────────────
//
// Every knob tick on Size or Decay is a new room, and a 6-second stereo IR is
// 1.4 million samples.  Regenerating that on every pointermove would drop the
// audio thread, so identical requests come back from a map and near-identical
// ones are rounded together.

interface CacheEntry { key: string; buffer: AudioBuffer }
const cache: CacheEntry[] = [];
const CACHE_MAX = 24;

function cacheKey(space: Space, opts: IrOptions): string {
  return [
    space.id, opts.sampleRate, opts.part ?? 'full',
    (opts.sizeScale ?? 1).toFixed(2),
    (opts.decayScale ?? 1).toFixed(2),
    (opts.damping ?? space.damping).toFixed(2),
    (opts.widthScale ?? 1).toFixed(2),
    Math.round(opts.holdMs ?? 260),
    opts.seed ?? 0,
  ].join('|');
}

/** An IR as an AudioBuffer, built once per distinct set of numbers. */
export function irBuffer(ctx: BaseAudioContext, space: Space, opts: IrOptions): AudioBuffer {
  const key = cacheKey(space, opts);
  const hit = cache.find((e) => e.key === key);
  if (hit && hit.buffer.sampleRate === ctx.sampleRate) return hit.buffer;

  const ir = renderIr(space, { ...opts, sampleRate: ctx.sampleRate });
  const buffer = ctx.createBuffer(2, ir.frames, ctx.sampleRate);
  buffer.copyToChannel(ir.left, 0);
  buffer.copyToChannel(ir.right, 1);

  cache.push({ key, buffer });
  if (cache.length > CACHE_MAX) cache.shift();
  return buffer;
}

/** Drop every cached room.  Only the tests need this. */
export function clearIrCache(): void { cache.length = 0; }

// ── For the display ─────────────────────────────────────────────────────────

export interface IrDisplay {
  /** Envelope of the tail, 0…1, evenly spaced over `lengthSec`. */
  envelope: number[];
  /** The first reflections, for the comb of lines at the front. */
  taps: EarlyTap[];
  lengthSec: number;
  rt60Sec: number;
}

/**
 * What the picture in the plugin window draws.
 *
 * Computed from the same functions the audio uses, so the drawing cannot drift
 * away from the sound: a gated room's picture stops because the IR stops.
 */
export function irDisplay(space: Space, opts: IrOptions, points = 96): IrDisplay {
  const rt60 = clamp(space.rt60Sec * (opts.decayScale ?? 1), 0.05, 14);
  const scaled: IrOptions = { ...opts, decayScale: rt60 / space.rt60Sec };
  const lengthSec = irLengthSec(space, scaled);
  const build = buildSec(space, scaled);
  const hold = (opts.holdMs ?? 260) / 1000;

  const envelope: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / Math.max(1, points - 1)) * lengthSec;
    let env: number;
    if (space.shape === 'nonlinear') {
      env = Math.max(
        Math.exp(-LN_MILLION * t / (rt60 * 0.35)),
        0.4 * Math.exp(-LN_MILLION * t / rt60),
      );
    } else if (space.shape === 'gated') {
      env = (t < hold ? 1 : 0) * Math.exp(-LN_MILLION * t / (rt60 * 2.5));
    } else if (space.shape === 'reverse') {
      const span = Math.max(0.02, hold);
      env = t <= span ? Math.pow(t / span, 2) : 0;
    } else {
      env = Math.exp(-LN_MILLION * t / rt60);
    }
    const rise = build <= 0 ? 1 : clamp(t / build, 0, 1);
    envelope.push(env * (space.shape === 'reverse' ? 1 : rise * rise * (3 - 2 * rise)));
  }

  return {
    envelope,
    taps: earlyTaps(space, scaled).slice(0, 40),
    lengthSec,
    rt60Sec: rt60,
  };
}
