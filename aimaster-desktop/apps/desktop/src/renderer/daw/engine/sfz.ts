// SFZ — reading somebody else's sample library.
//
// A sampler is only as useful as the libraries it can open, and SFZ is the
// one open format that free libraries actually ship in: Salamander Grand
// Piano, VSCO 2, most of what is on freepats.  It is a plain text file, which
// is why it is readable here at all — the alternatives are proprietary
// binaries.
//
// ── What the format is ──────────────────────────────────────────────────────
//
// A flat list of `<region>` blocks, each naming one sample file and the
// conditions under which it plays.  Regions inherit from the `<group>` above
// them, and groups from `<global>`, which is the whole reason a piano library
// is not 500 lines of repetition:
//
//     <global> ampeg_release=0.6
//     <group>  lovel=1 hivel=63
//     <region> sample=A0v1.wav lokey=21 hikey=23 pitch_keycenter=21
//
// ── What this reads, and what it ignores ────────────────────────────────────
//
// The opcodes below are the ones that decide WHICH sample plays and at WHAT
// pitch — the part a sampler cannot be wrong about.  SFZ has several hundred
// more, most of them modulation and filtering that a library uses to shape a
// sound it already found.  Unknown opcodes are kept as raw text rather than
// dropped, so a later reader can use them without the file being parsed twice,
// and so `unsupported` can tell the truth about what was skipped instead of
// pretending the file was fully understood.

/** One playable region: a sample plus the conditions it answers to. */
export interface SfzRegion {
  /** Path as written in the file, relative to the library root. */
  sample: string;
  loKey: number;
  hiKey: number;
  /** The pitch the sample was recorded at. */
  keyCenter: number;
  loVel: number;
  hiVel: number;
  /** Fine tune, in cents. */
  tuneCents: number;
  /** Coarse shift, in semitones. */
  transpose: number;
  volumeDb: number;
  /** −100 (left) to 100 (right). */
  pan: number;
  /** Which pass of a round robin this is, 1-based; 0 means "not in one". */
  seqPosition: number;
  seqLength: number;
  /** 'attack' plays on key down, 'release' on key up. */
  trigger: 'attack' | 'release' | 'first' | 'legato';
  loopMode: 'no_loop' | 'one_shot' | 'loop_continuous' | 'loop_sustain';
  loopStart: number;
  loopEnd: number;
  /** Release stage in seconds, if the file asked for one. */
  ampegRelease: number;
  /** Every opcode as written, so nothing is silently lost. */
  raw: Record<string, string>;
}

export interface SfzInstrument {
  regions: SfzRegion[];
  /** `default_path` from `<control>`, prepended to every sample path. */
  defaultPath: string;
  /** Opcodes seen but not acted on, with how often — for an honest report. */
  unsupported: Record<string, number>;
}

const NOTE_OFFSET: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

/**
 * A key as SFZ writes it: `60`, `c4`, `C#4`, `db3`.
 *
 * Middle C is c4 = 60 here, which is the convention SFZ and most libraries
 * use.  Getting this off by an octave transposes an entire instrument, and it
 * is the classic way a sampler ends up "working" while everything plays in
 * the wrong register.
 */
export function parseKey(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = /^([a-g])([#b]*)(-?\d+)$/.exec(s);
  if (!m) return null;
  let semis = NOTE_OFFSET[m[1]!]!;
  for (const ch of m[2]!) semis += ch === '#' ? 1 : -1;
  return semis + (Number(m[3]!) + 1) * 12;
}

/** Opcodes this reader acts on.  Anything else lands in `unsupported`. */
const KNOWN = new Set([
  'sample', 'key', 'lokey', 'hikey', 'pitch_keycenter', 'lovel', 'hivel',
  'tune', 'transpose', 'volume', 'pan', 'seq_position', 'seq_length',
  'trigger', 'loop_mode', 'loop_start', 'loop_end', 'ampeg_release',
  'default_path',
]);

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : fallback;
}

function buildRegion(op: Record<string, string>): SfzRegion | null {
  const sample = op['sample']?.trim();
  if (!sample) return null;   // a region with no sample plays nothing

  // `key=` is shorthand: it sets the range AND the recorded pitch at once.
  const key = op['key'] !== undefined ? parseKey(op['key']) : null;
  const loKey = key ?? parseKey(op['lokey'] ?? '') ?? 0;
  const hiKey = key ?? parseKey(op['hikey'] ?? '') ?? 127;
  const centre = key ?? parseKey(op['pitch_keycenter'] ?? '') ?? loKey;

  const trigger = op['trigger']?.trim().toLowerCase();
  const loopMode = op['loop_mode']?.trim().toLowerCase();

  return {
    sample: sample.replace(/\\/g, '/'),   // libraries are written on Windows
    loKey: Math.min(loKey, hiKey),
    hiKey: Math.max(loKey, hiKey),
    keyCenter: centre,
    loVel: Math.max(0, Math.min(127, num(op['lovel'], 0))),
    hiVel: Math.max(0, Math.min(127, num(op['hivel'], 127))),
    tuneCents: num(op['tune'], 0),
    transpose: num(op['transpose'], 0),
    volumeDb: num(op['volume'], 0),
    pan: Math.max(-100, Math.min(100, num(op['pan'], 0))),
    seqPosition: Math.max(0, num(op['seq_position'], 0)),
    seqLength: Math.max(1, num(op['seq_length'], 1)),
    trigger: trigger === 'release' || trigger === 'first' || trigger === 'legato'
      ? trigger : 'attack',
    loopMode: loopMode === 'one_shot' || loopMode === 'loop_continuous' || loopMode === 'loop_sustain'
      ? loopMode : 'no_loop',
    loopStart: Math.max(0, num(op['loop_start'], 0)),
    loopEnd: Math.max(0, num(op['loop_end'], 0)),
    ampegRelease: Math.max(0, num(op['ampeg_release'], 0)),
    raw: { ...op },
  };
}

/**
 * Parse one .sfz file.
 *
 * Takes the text rather than a path so it can be tested without a filesystem
 * and so the main process stays the only thing that reads disk.
 */
export function parseSfz(text: string): SfzInstrument {
  const regions: SfzRegion[] = [];
  const unsupported: Record<string, number> = {};
  let defaultPath = '';

  let global: Record<string, string> = {};
  let group: Record<string, string> = {};
  let master: Record<string, string> = {};
  let current: Record<string, string> | null = null;
  let currentKind: 'global' | 'group' | 'region' | 'control' | 'master' | null = null;

  const flush = (): void => {
    if (currentKind === 'region' && current) {
      const built = buildRegion({ ...global, ...master, ...group, ...current });
      if (built) regions.push(built);
    }
    current = null;
  };

  // Strip block comments first, then work line by line: SFZ allows several
  // opcodes on one line, and a header can share a line with them.
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;

    // Split into headers and `opcode=value` pairs.  A value may contain
    // spaces (sample paths do), so a pair runs until the next `word=`.
    const tokens = line.match(/<\w+>|[a-zA-Z0-9_]+=(?:(?!\s+[a-zA-Z0-9_]+=)[^<])*/g) ?? [];
    for (const token of tokens) {
      const header = /^<(\w+)>$/.exec(token);
      if (header) {
        flush();
        const kind = header[1]!.toLowerCase();
        if (kind === 'global') { global = {}; group = {}; master = {}; currentKind = 'global'; current = global; }
        else if (kind === 'master') { master = {}; group = {}; currentKind = 'master'; current = master; }
        else if (kind === 'group') { group = {}; currentKind = 'group'; current = group; }
        else if (kind === 'region') { currentKind = 'region'; current = {}; }
        else if (kind === 'control') { currentKind = 'control'; current = {}; }
        else { currentKind = null; current = {}; }
        continue;
      }
      const eq = token.indexOf('=');
      if (eq <= 0 || !current) continue;
      const name = token.slice(0, eq).trim().toLowerCase();
      const value = token.slice(eq + 1).trim();
      if (currentKind === 'control' && name === 'default_path') {
        defaultPath = value.replace(/\\/g, '/');
        continue;
      }
      if (!KNOWN.has(name)) unsupported[name] = (unsupported[name] ?? 0) + 1;
      current[name] = value;
    }
  }
  flush();
  return { regions, defaultPath, unsupported };
}
