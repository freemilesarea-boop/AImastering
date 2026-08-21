// Presets you made yourself.
//
// The factory presets in `plugin-presets.ts` are a fixed list compiled into the
// app.  These are the other half: the settings someone arrived at by ear, kept
// under a name they chose, sitting in the same picker as the factory ones
// because at the moment of reaching for a sound nobody cares who wrote it.
//
// Three rules shape the whole file:
//
//   A SAVED PRESET IS DATA, NOT CODE.  It can be hand-edited, copied between
//   machines, restored from a backup, or corrupted.  So every value is checked
//   against the device's own declared parameters on the way IN and on the way
//   OUT — unknown ids dropped, out-of-range values clamped.  A preset file from
//   a newer build must not be able to put a device somewhere it cannot go.
//
//   A FULL SNAPSHOT, NOT A PATCH.  A factory preset stores only what it decides
//   so that adding a parameter later does not silently give every preset a zero
//   for it.  A user preset means "this exact sound", so it stores every
//   parameter — and anything added to the device later still resolves to the
//   device's default, because loading spreads the defaults underneath.
//
//   NOTHING IS SILENTLY LOST.  Saving over the cap, importing a file with
//   entries for a device that no longer exists, loading a preset with a
//   parameter that was removed — each of those reports what it dropped instead
//   of quietly doing something else.

import { findPlugin } from './plugins.js';
import { presetGroups, type PluginPreset } from './plugin-presets.js';

const STORAGE_KEY = 'loui.daw.presets.user';
const SCHEMA_VERSION = 1;
const MAX_PRESETS = 500;
const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 160;

/** The group user presets appear under, above every factory group. */
export const USER_GROUP = '내 프리셋';
/** Ids carry a prefix so a user preset can never collide with a factory one. */
export const USER_PREFIX = 'user:';

export interface UserPreset {
  id: string;
  pluginId: string;
  name: string;
  /** Optional one-liner, the same field the factory presets use. */
  note: string;
  createdAt: number;
  updatedAt: number;
  params: Record<string, number>;
}

interface StoredEnvelope {
  version: number;
  items: UserPreset[];
}

// ── Where they live ───────────────────────────────────────────────────────────

/**
 * The bit of `Storage` this needs.
 *
 * Named so a test can hand over a plain object, and so the store could move to
 * a file on disk later without any caller changing.
 */
export interface PresetStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

let override: PresetStore | null = null;

/** Point the store somewhere else.  Pass null to go back to `localStorage`. */
export function setUserPresetStore(store: PresetStore | null): void { override = store; }

function store(): PresetStore | null {
  if (override) return override;
  try {
    // localStorage throws outright in some sandboxed and privacy modes, so
    // even reaching for it is guarded.
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

// ── Validation ────────────────────────────────────────────────────────────────

export function sanitiseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

export function sanitiseNote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LEN);
}

export interface SanitisedParams {
  params: Record<string, number>;
  /** Parameter ids in the stored preset that the device does not have. */
  unknown: string[];
  /** Parameter ids whose stored value had to be pulled back into range. */
  clamped: string[];
}

/**
 * Check a stored parameter map against the device that will receive it.
 *
 * Everything about a preset is user-writable, and a device's ranges change
 * between builds.  Loading is therefore never a straight assignment: unknown
 * ids are dropped, non-numbers are dropped, and anything outside the declared
 * range is clamped to it.  What was dropped comes back so a caller can say so.
 */
export function sanitiseParams(
  pluginId: string, raw: Record<string, unknown>,
): SanitisedParams {
  const device = findPlugin(pluginId);
  const out: Record<string, number> = {};
  const unknown: string[] = [];
  const clamped: string[] = [];
  if (!device) {
    return { params: {}, unknown: Object.keys(raw).sort(), clamped };
  }
  const defs = new Map(device.params.map((p) => [p.id, p]));
  for (const [id, value] of Object.entries(raw)) {
    const def = defs.get(id);
    if (!def) { unknown.push(id); continue; }
    if (typeof value !== 'number' || !Number.isFinite(value)) { unknown.push(id); continue; }
    const fixed = Math.min(def.max, Math.max(def.min, value));
    if (fixed !== value) clamped.push(id);
    out[id] = fixed;
  }
  return { params: out, unknown: unknown.sort(), clamped: clamped.sort() };
}

// ── The envelope ──────────────────────────────────────────────────────────────

function isPreset(value: unknown): value is UserPreset {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<UserPreset>;
  return typeof p.id === 'string' && typeof p.pluginId === 'string'
    && typeof p.name === 'string'
    && typeof p.createdAt === 'number' && typeof p.updatedAt === 'number'
    && !!p.params && typeof p.params === 'object' && !Array.isArray(p.params);
}

function readEnvelope(): StoredEnvelope {
  const s = store();
  if (!s) return { version: SCHEMA_VERSION, items: [] };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { version: SCHEMA_VERSION, items: [] };
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { version: SCHEMA_VERSION, items: [] };
    }
    return { version: SCHEMA_VERSION, items: parsed.items.filter(isPreset) };
  } catch {
    // A corrupted store reads as empty rather than throwing on every render.
    return { version: SCHEMA_VERSION, items: [] };
  }
}

function writeEnvelope(env: StoredEnvelope): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, items: env.items }));
    return true;
  } catch {
    return false;   // quota, privacy mode — the caller is told, not lied to
  }
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `${USER_PREFIX}${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** For tests, so ids are comparable between runs. */
export function resetUserPresetIds(): void { counter = 0; }

// ── Reading ───────────────────────────────────────────────────────────────────

/** Every user preset, newest first.  Pass a device id to narrow it. */
export function listUserPresets(pluginId?: string): UserPreset[] {
  return readEnvelope().items
    .filter((p) => pluginId === undefined || p.pluginId === pluginId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findUserPreset(id: string): UserPreset | undefined {
  return readEnvelope().items.find((p) => p.id === id);
}

export function isUserPresetId(id: string): boolean {
  return id.startsWith(USER_PREFIX);
}

/**
 * Can this device's settings be saved at all?
 *
 * Only devices this build ships: a preset is validated against a declared
 * parameter list, and a third-party plugin reached through the external host
 * has none here.  The UI asks before drawing a save button, because a button
 * that always fails is worse than no button.
 */
export function canSaveUserPreset(pluginId: string): boolean {
  return findPlugin(pluginId) !== undefined;
}

/**
 * A user preset wearing the factory preset's shape.
 *
 * The picker, `resolvePreset`, and everything downstream then treat the two
 * kinds identically — which is the point.  Parameters are sanitised here, so
 * what comes out of the picker is always something the device can accept.
 */
export function asPluginPreset(preset: UserPreset): PluginPreset {
  return {
    id: preset.id,
    pluginId: preset.pluginId,
    name: preset.name,
    group: USER_GROUP,
    note: preset.note,
    params: sanitiseParams(preset.pluginId, preset.params).params,
  };
}

/**
 * The whole picker for one device: your presets first, then the factory ones.
 *
 * Yours go on top because they are the ones you were looking for — the factory
 * list does not change, so it is the part you already know the shape of.  When
 * you have saved nothing, this is exactly the factory list and the picker looks
 * the way it always did.
 */
export function allPresetGroups(
  pluginId: string,
): Array<{ group: string; presets: PluginPreset[] }> {
  const mine = listUserPresets(pluginId).map(asPluginPreset);
  const factory = presetGroups(pluginId);
  return mine.length > 0 ? [{ group: USER_GROUP, presets: mine }, ...factory] : factory;
}

// ── Writing ───────────────────────────────────────────────────────────────────

export type SaveResult =
  | { ok: true; preset: UserPreset }
  | { ok: false; reason: string };

export interface SaveRequest {
  pluginId: string;
  name: string;
  note?: string;
  params: Record<string, number>;
}

/**
 * Save the device as it stands now.
 *
 * A name that already exists on the SAME device is refused rather than
 * silently making a second entry with the same label — two identical names in
 * one picker is a way to lose a sound.  Overwriting is a separate, deliberate
 * call.
 */
export function saveUserPreset(request: SaveRequest): SaveResult {
  const name = sanitiseName(request.name);
  if (!name) return { ok: false, reason: '이름을 입력하세요' };
  if (!findPlugin(request.pluginId)) {
    return { ok: false, reason: '알 수 없는 장치입니다' };
  }

  const env = readEnvelope();
  if (env.items.some((p) => p.pluginId === request.pluginId && p.name === name)) {
    return { ok: false, reason: `이미 "${name}" 이 있습니다 — 덮어쓰기를 쓰세요` };
  }
  if (env.items.length >= MAX_PRESETS) {
    return { ok: false, reason: `프리셋은 ${MAX_PRESETS}개까지입니다` };
  }

  const now = Date.now();
  const preset: UserPreset = {
    id: newId(),
    pluginId: request.pluginId,
    name,
    note: sanitiseNote(request.note ?? ''),
    createdAt: now,
    updatedAt: now,
    params: sanitiseParams(request.pluginId, request.params).params,
  };
  env.items.push(preset);
  if (!writeEnvelope(env)) return { ok: false, reason: '프리셋을 저장할 수 없습니다' };
  return { ok: true, preset };
}

/** Replace one preset's parameters with what the device is doing now. */
export function overwriteUserPreset(
  id: string, params: Record<string, number>,
): SaveResult {
  const env = readEnvelope();
  const index = env.items.findIndex((p) => p.id === id);
  const existing = env.items[index];
  if (index < 0 || !existing) return { ok: false, reason: '프리셋을 찾을 수 없습니다' };
  const next: UserPreset = {
    ...existing,
    updatedAt: Date.now(),
    params: sanitiseParams(existing.pluginId, params).params,
  };
  env.items[index] = next;
  if (!writeEnvelope(env)) return { ok: false, reason: '프리셋을 저장할 수 없습니다' };
  return { ok: true, preset: next };
}

export function renameUserPreset(id: string, nextName: string, nextNote?: string): SaveResult {
  const name = sanitiseName(nextName);
  if (!name) return { ok: false, reason: '이름을 입력하세요' };
  const env = readEnvelope();
  const index = env.items.findIndex((p) => p.id === id);
  const existing = env.items[index];
  if (index < 0 || !existing) return { ok: false, reason: '프리셋을 찾을 수 없습니다' };
  if (env.items.some((p) => p.id !== id && p.pluginId === existing.pluginId && p.name === name)) {
    return { ok: false, reason: `이미 "${name}" 이 있습니다` };
  }
  const next: UserPreset = {
    ...existing,
    name,
    note: nextNote === undefined ? existing.note : sanitiseNote(nextNote),
    updatedAt: Date.now(),
  };
  env.items[index] = next;
  if (!writeEnvelope(env)) return { ok: false, reason: '프리셋을 저장할 수 없습니다' };
  return { ok: true, preset: next };
}

export function deleteUserPreset(id: string): boolean {
  const env = readEnvelope();
  const before = env.items.length;
  env.items = env.items.filter((p) => p.id !== id);
  if (env.items.length === before) return false;
  return writeEnvelope(env);
}

/** Wipe everything.  Only reachable from an explicit, confirmed action. */
export function clearUserPresets(): void {
  writeEnvelope({ version: SCHEMA_VERSION, items: [] });
}

// ── Moving them between machines ──────────────────────────────────────────────

export const EXPORT_KIND = 'loui.daw.presets';

interface ExportFile {
  kind: string;
  version: number;
  exportedAt: number;
  items: UserPreset[];
}

/**
 * Everything, or one device's worth, as a file.
 *
 * localStorage is not a place to keep work: it is cleared by a reinstall, a
 * profile reset, or a stray "clear site data".  A preset someone spent an
 * afternoon on has to be able to leave the machine.
 */
export function exportUserPresets(pluginId?: string): string {
  const file: ExportFile = {
    kind: EXPORT_KIND,
    version: SCHEMA_VERSION,
    exportedAt: Date.now(),
    items: listUserPresets(pluginId),
  };
  return JSON.stringify(file, null, 2);
}

export interface ImportReport {
  added: number;
  renamed: number;
  skipped: number;
  /** One line per skipped entry, so a partial import can be explained. */
  reasons: string[];
}

/**
 * Read a file back in.
 *
 * A name that clashes with an existing preset for the same device is imported
 * under `이름 (2)` rather than being dropped or overwriting: the person doing
 * the import cannot know which of the two they wanted, and only one of those
 * three outcomes keeps both.
 */
export function importUserPresets(json: string): ImportReport {
  const report: ImportReport = { added: 0, renamed: 0, skipped: 0, reasons: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    report.skipped += 1;
    report.reasons.push('파일이 올바른 JSON 이 아닙니다');
    return report;
  }
  const file = parsed as Partial<ExportFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.items)) {
    report.skipped += 1;
    report.reasons.push('프리셋 파일이 아닙니다');
    return report;
  }
  if (file.kind !== EXPORT_KIND) {
    report.skipped += 1;
    report.reasons.push('다른 프로그램의 파일입니다');
    return report;
  }

  const env = readEnvelope();
  const now = Date.now();
  for (const raw of file.items) {
    if (!isPreset(raw)) {
      report.skipped += 1;
      report.reasons.push('형식이 맞지 않는 항목 하나를 건너뛰었습니다');
      continue;
    }
    if (!findPlugin(raw.pluginId)) {
      report.skipped += 1;
      report.reasons.push(`"${raw.name}" — 이 빌드에 없는 장치(${raw.pluginId})`);
      continue;
    }
    if (env.items.length >= MAX_PRESETS) {
      report.skipped += 1;
      report.reasons.push(`"${raw.name}" — 프리셋 한도(${MAX_PRESETS}개)를 넘었습니다`);
      continue;
    }
    const taken = new Set(env.items.filter((p) => p.pluginId === raw.pluginId).map((p) => p.name));
    const wanted = sanitiseName(raw.name);
    if (!wanted) {
      report.skipped += 1;
      report.reasons.push('이름이 없는 항목 하나를 건너뛰었습니다');
      continue;
    }
    const name = uniqueName(wanted, taken);
    if (name !== wanted) report.renamed += 1;
    env.items.push({
      id: newId(),
      pluginId: raw.pluginId,
      name,
      note: sanitiseNote(raw.note ?? ''),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: now,
      params: sanitiseParams(raw.pluginId, raw.params).params,
    });
    report.added += 1;
  }

  if (report.added > 0 && !writeEnvelope(env)) {
    return { added: 0, renamed: 0, skipped: report.added + report.skipped,
      reasons: ['프리셋을 저장할 수 없습니다'] };
  }
  return report;
}

function uniqueName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n++) {
    const candidate = sanitiseName(`${wanted} (${n})`);
    if (!taken.has(candidate)) return candidate;
  }
  return sanitiseName(`${wanted} ${Date.now().toString(36)}`);
}

/** `3개 추가 · 1개 이름 변경 · 2개 건너뜀` — what an import actually did. */
export function describeImport(report: ImportReport): string {
  const parts: string[] = [`${report.added}개 추가`];
  if (report.renamed > 0) parts.push(`${report.renamed}개 이름 변경`);
  if (report.skipped > 0) parts.push(`${report.skipped}개 건너뜀`);
  return parts.join(' · ');
}
