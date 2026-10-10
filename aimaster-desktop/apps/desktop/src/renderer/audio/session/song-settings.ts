// song-settings — what the user did to ONE song, kept for later.
//
// The Studio could always shape a song, and the queue could always render
// a batch, but nothing joined them: `StudioPage` held its parameter state
// in a page-local `useState`, so pressing Back threw the work away, and the
// only render path (`audio:master`) took five scalar options rather than a
// chain config. Tuning twenty songs was therefore twenty sittings that had
// to end in an export each, and none of them could be revisited.
//
// This module is the join. It stores, per source file:
//
//   - the full all-modules parameter state,
//   - the free parametric EQ bands (which live outside that state because
//     they have neither fixed length nor fixed names),
//   - which modules the user genuinely moved, and
//   - the preset they started from, for display.
//
// Identity is the **absolute source path**, not the queue item id. Queue ids
// are fresh UUIDs on every import, so keying by them would lose the work the
// moment a file was removed and re-added — which is exactly what someone
// does when they are unhappy with a render.
//
// # The layering rule
//
// The final step of the workflow picks one album preset — K-POP, streaming,
// whatever — and applies it to every song. That preset and the per-song work
// will disagree, and `layerAlbumPreset` is where the disagreement is settled:
//
//   **A module the song actually changed is never overwritten. Everything
//   else takes the album preset.**
//
// So the album gets one consistent loudness and tone, and a song where
// somebody deliberately set the limiter differently keeps that setting. The
// alternative — preset always wins — silently destroys per-song work at the
// last step, which is the one place a user is least likely to check.
//
// "Actually changed" is measured against the module defaults, not against
// the preset, so auditioning a preset in the Studio and then moving on does
// not permanently pin every module it touched.

import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
} from '../parameters/index.js';
import { presetApplyPlan } from '../presets/preset-to-state.js';
import type { LouiPreset } from '../presets/loui-presets.js';
import type { FreeEqBand } from '../modules/eq-graph-model.js';
import type { SongProfile } from '../presets/adaptive-defaults.js';

const STORAGE_KEY = 'loui.song.settings';
const SCHEMA_VERSION = 1;
/** Enough for several albums; past this the oldest entries are dropped. */
const MAX_ENTRIES = 400;

/** Everything the Studio holds for one song. */
export interface SongSettings {
  /** Absolute source path — the identity. */
  filePath: string;
  /** Epoch ms of the save. */
  savedAt: number;
  state: AllModulesParameterState;
  freeBands: FreeEqBand[];
  masterBypass: boolean;
  /** Preset last applied in the Studio, for the queue row's label. */
  presetId: string | null;
  /**
   * The Match EQ reference: where it came from, and the 32 numbers measured
   * from it.
   *
   * The curve is stored rather than re-measured from the path, because the
   * reference file may have moved by the time the batch runs — and a saved
   * song that silently stopped matching would be worse than one that
   * matches a file the user no longer has.
   */
  referencePath?: string | null;
  referenceCurveDb?: number[] | null;
  /**
   * What the engine measured about this song.
   *
   * Saved because measuring costs a decode and two analysis passes — worth
   * doing once per file, not once per visit — and because the adapted
   * settings should be reproducible later without the source being
   * re-readable.
   */
  profile?: SongProfile | null;
}

interface StoredEnvelope {
  version: number;
  items: SongSettings[];
}

// ── Which modules the user actually moved ────────────────────────────────

/**
 * Module ids whose state differs from the defaults.
 *
 * Compared value by value rather than by reference: the state is rebuilt on
 * every edit, so every module is a new object every time and a reference
 * check would report the whole rack as changed.
 */
export function changedModules(state: AllModulesParameterState): ModuleId[] {
  const base = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  const out: ModuleId[] = [];
  for (const id of MODULE_IDS) {
    const mine = state[id];
    const theirs = base[id];
    if (!mine || !theirs) continue;
    if (mine.bypass !== theirs.bypass) { out.push(id); continue; }
    const keys = new Set([
      ...Object.keys(mine.parameters),
      ...Object.keys(theirs.parameters),
    ]);
    for (const k of keys) {
      if (mine.parameters[k] !== theirs.parameters[k]) { out.push(id); break; }
    }
  }
  return out;
}

// ── Layering ─────────────────────────────────────────────────────────────

/** What `layerAlbumPreset` did, so the UI can say it in words. */
export interface LayerReport {
  /** Modules the album preset wrote. */
  applied: ModuleId[];
  /** Modules the preset wanted but the song had already claimed. */
  kept: ModuleId[];
}

export interface LayerResult {
  state: AllModulesParameterState;
  report: LayerReport;
}

/**
 * Combine one song's saved state with the album preset.
 *
 * Modules the song genuinely changed keep their values; every other module
 * the preset mentions takes the preset's. Returns the report as well as the
 * state because a rule the user cannot see is a rule they will not trust.
 */
export function layerAlbumPreset(
  saved: AllModulesParameterState,
  preset: LouiPreset | null,
): LayerResult {
  if (!preset) {
    return { state: saved, report: { applied: [], kept: [] } };
  }
  const claimed = new Set(changedModules(saved));
  const plan = presetApplyPlan(preset);
  const next: AllModulesParameterState = { ...saved };
  const applied = new Set<ModuleId>();
  const kept = new Set<ModuleId>();

  for (const b of plan.bypasses) {
    if (claimed.has(b.moduleId)) { kept.add(b.moduleId); continue; }
    const mod = next[b.moduleId];
    if (!mod) continue;
    next[b.moduleId] = { ...mod, bypass: b.bypass };
    applied.add(b.moduleId);
  }
  for (const p of plan.parameters) {
    if (claimed.has(p.moduleId)) { kept.add(p.moduleId); continue; }
    const mod = next[p.moduleId];
    if (!mod) continue;
    next[p.moduleId] = {
      ...mod,
      parameters: { ...mod.parameters, [p.parameterId]: p.value },
    };
    applied.add(p.moduleId);
  }

  return {
    state: next,
    report: {
      applied: MODULE_IDS.filter((id) => applied.has(id)),
      kept: MODULE_IDS.filter((id) => kept.has(id)),
    },
  };
}

// ── Storage ──────────────────────────────────────────────────────────────

function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

function isSettings(v: unknown): v is SongSettings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<SongSettings>;
  return typeof s.filePath === 'string'
    && s.filePath.length > 0
    && typeof s.savedAt === 'number'
    && !!s.state && typeof s.state === 'object'
    && Array.isArray(s.freeBands);
}

function readEnvelope(): StoredEnvelope {
  const s = store();
  if (!s) return { version: SCHEMA_VERSION, items: [] };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { version: SCHEMA_VERSION, items: [] };
    const parsed = JSON.parse(raw) as StoredEnvelope | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { version: SCHEMA_VERSION, items: [] };
    }
    return { version: SCHEMA_VERSION, items: parsed.items.filter(isSettings) };
  } catch {
    // A corrupt entry must not take the app down with it. Losing saved
    // settings is bad; refusing to open the app is worse.
    return { version: SCHEMA_VERSION, items: [] };
  }
}

/**
 * Persist the envelope, and say whether it actually landed.
 *
 * It used to be `try { setItem } catch { /* quota — ignore *\/ }` and
 * return nothing.  A save that never happened was therefore
 * indistinguishable from one that did: `saveSongSettings` still handed back
 * an entry, the Studio set `savedAt`, cleared the dirty flag, turned the
 * queue badge green and said "N개 모듈 설정을 저장했습니다", and the render
 * later found nothing to apply.  That is the same symptom as the render bug
 * — 설정 저장을 눌렀는데 원본으로 돌아간다 — from a different cause, and the
 * one the user could do nothing about.
 *
 * Verified by READING IT BACK rather than by trusting that `setItem` did not
 * throw.  A quota failure is only the loud way storage can refuse: a private
 * window, a cleared-site-data policy or a shimmed storage can accept the
 * call and keep nothing, and only a read-back sees that.
 */
function writeEnvelope(env: StoredEnvelope): boolean {
  const s = store();
  if (!s) return false;
  let json: string;
  try { json = JSON.stringify(env); } catch { return false; }
  try { s.setItem(STORAGE_KEY, json); } catch { return false; }
  try { return s.getItem(STORAGE_KEY) === json; } catch { return false; }
}

/** The saved settings for one file, or null. */
export function loadSongSettings(filePath: string): SongSettings | null {
  if (!filePath) return null;
  return readEnvelope().items.find((i) => i.filePath === filePath) ?? null;
}

/** What `saveSongSettings` managed to do. */
export interface SaveSongSettingsResult {
  /** True only when the write was read back from storage. */
  stored: boolean;
  /** The entry as stored, or null when nothing was stored. */
  entry: SongSettings | null;
  /**
   * How many OTHER songs' saved settings had to be dropped to make room.
   *
   * Reported because it is data loss.  Freeing space silently would trade
   * one song's save for another's without anybody being told.
   */
  evicted: number;
}

/**
 * Save (or replace) the settings for one file.
 *
 * Deep-cloned on the way in so later React edits cannot mutate what was
 * saved — the whole point is that this is a snapshot.
 *
 * When storage is full the oldest OTHER songs are shed and the write is
 * retried; the song being saved is never the one dropped, because it is the
 * one the user is looking at. Shedding a quarter at a time rather than one
 * at a time bounds the retries at about nine instead of four hundred, and
 * each retry re-serialises the whole envelope.
 *
 * Returns whether it worked. The caller must not report a save it did not
 * get — that was the bug.
 */
export function saveSongSettings(input: Omit<SongSettings, 'savedAt'>): SaveSongSettingsResult {
  const entry: SongSettings = {
    ...(JSON.parse(JSON.stringify(input)) as Omit<SongSettings, 'savedAt'>),
    savedAt: Date.now(),
  };
  const env = readEnvelope();
  const idx = env.items.findIndex((i) => i.filePath === entry.filePath);
  if (idx >= 0) env.items[idx] = entry;
  else env.items.push(entry);
  if (env.items.length > MAX_ENTRIES) {
    env.items.sort((a, b) => a.savedAt - b.savedAt);
    env.items = env.items.slice(env.items.length - MAX_ENTRIES);
  }
  if (writeEnvelope(env)) return { stored: true, entry, evicted: 0 };

  // Out of room.  Shed the oldest entries that are not this song.
  let evicted = 0;
  const others = () => env.items.filter((i) => i.filePath !== entry.filePath);
  while (others().length > 0) {
    const rest = others().sort((a, b) => a.savedAt - b.savedAt);
    const drop = Math.max(1, Math.floor(rest.length / 4));
    const doomed = new Set(rest.slice(0, drop).map((i) => i.filePath));
    env.items = env.items.filter((i) => !doomed.has(i.filePath));
    evicted += doomed.size;
    if (writeEnvelope(env)) return { stored: true, entry, evicted };
  }
  // Even this song alone will not fit.  Leave storage as it was found
  // rather than ending with an envelope holding one song and a lie.
  return { stored: false, entry: null, evicted };
}

/**
 * Forget one file's settings. True if something was removed AND the removal
 * was persisted — a delete that storage refused is not a delete.
 */
export function clearSongSettings(filePath: string): boolean {
  const env = readEnvelope();
  const before = env.items.length;
  env.items = env.items.filter((i) => i.filePath !== filePath);
  if (env.items.length === before) return false;
  return writeEnvelope(env);
}

/** Every saved path — used to mark queue rows without loading each entry. */
export function savedSongPaths(): string[] {
  return readEnvelope().items.map((i) => i.filePath);
}

/**
 * Drop everything. Exported for tests and for a settings-screen reset.
 * Returns whether storage took it.
 */
export function clearAllSongSettings(): boolean {
  return writeEnvelope({ version: SCHEMA_VERSION, items: [] });
}
