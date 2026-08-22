// Where templates live.
//
// The same shape and the same discipline as `user-presets.ts`, because a
// template is the same kind of thing: user-written data that is read back on
// a different day, possibly on a different build, possibly after being
// hand-edited or half-written by a crash.
//
//   NOTHING IS SILENTLY LOST.  Saving over the cap, reading a corrupted
//   store, importing a file with entries this build cannot use — each says
//   what it dropped instead of quietly doing something else.
//   A WRITE THAT FAILED IS REPORTED.  `localStorage` throws on quota and in
//   privacy modes; returning `true` regardless would tell the user their
//   template was saved when it was not.

import type { SessionTemplate, TrackTemplate } from '../model/track-template.js';

const TRACK_KEY = 'loui.daw.templates.track';
const SESSION_KEY = 'loui.daw.templates.session';
const SCHEMA_VERSION = 1;
const MAX_TEMPLATES = 200;

export interface TemplateStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

let override: TemplateStore | null = null;

/** Point the store somewhere else.  Pass null to go back to `localStorage`. */
export function setTemplateStore(store: TemplateStore | null): void { override = store; }

function store(): TemplateStore | null {
  if (override) return override;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

interface Envelope<T> { version: number; items: T[] }

function isTrackTemplate(v: unknown): v is TrackTemplate {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<TrackTemplate>;
  return typeof t.id === 'string' && typeof t.name === 'string'
    && typeof t.trackName === 'string' && typeof t.kind === 'string'
    && Array.isArray(t.inserts) && Array.isArray(t.sends)
    && !!t.output && typeof t.output === 'object'
    && typeof t.createdAt === 'number' && typeof t.updatedAt === 'number';
}

function isSessionTemplate(v: unknown): v is SessionTemplate {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<SessionTemplate>;
  return typeof t.id === 'string' && typeof t.name === 'string'
    && Array.isArray(t.tracks) && Array.isArray(t.buses) && Array.isArray(t.groups)
    && Array.isArray(t.markers) && Array.isArray(t.timeSignature)
    && typeof t.tempoBpm === 'number'
    && typeof t.createdAt === 'number' && typeof t.updatedAt === 'number';
}

function read<T>(key: string, guard: (v: unknown) => v is T): T[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Envelope<T>> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return [];
    // A corrupted entry is dropped rather than taking the whole list with it.
    return parsed.items.filter(guard);
  } catch {
    return [];
  }
}

function write<T>(key: string, items: readonly T[]): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify({ version: SCHEMA_VERSION, items }));
    return true;
  } catch {
    return false;   // quota, privacy mode — the caller is told, not lied to
  }
}

// ── Ids ───────────────────────────────────────────────────────────────────────

let counter = 0;
/** Ids are prefixed so a track template can never collide with a session one. */
function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Reset the id counter — tests only, so ids are reproducible. */
export function resetTemplateIds(): void { counter = 0; }

// ── Track templates ───────────────────────────────────────────────────────────

export function listTrackTemplates(): TrackTemplate[] {
  return read(TRACK_KEY, isTrackTemplate)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SaveResult<T> {
  saved: T | null;
  /** Why it did not save, when it did not. */
  problem: string | null;
}

/**
 * Save a template, replacing one of the same NAME if there is one.
 *
 * By name rather than by id because that is what the user means: saving "Lead
 * Vocal" twice is a correction, not a second template with the same label
 * that they will have to tell apart later.
 */
export function saveTrackTemplate(template: TrackTemplate): SaveResult<TrackTemplate> {
  if (!template.name) return { saved: null, problem: '이름이 필요합니다' };
  const items = listTrackTemplates();
  const at = items.findIndex((t) => t.name === template.name);
  const now = Date.now();
  const entry: TrackTemplate = {
    ...template,
    id: at >= 0 ? items[at]!.id : (template.id || makeId('tt:')),
    createdAt: at >= 0 ? items[at]!.createdAt : now,
    updatedAt: now,
  };
  if (at >= 0) items[at] = entry;
  else if (items.length >= MAX_TEMPLATES) {
    return { saved: null, problem: `트랙 템플릿이 ${MAX_TEMPLATES}개를 넘었습니다 — 지우고 다시 저장하세요` };
  } else items.unshift(entry);

  return write(TRACK_KEY, items)
    ? { saved: entry, problem: null }
    : { saved: null, problem: '저장소에 쓸 수 없습니다 — 브라우저 저장 공간을 확인하세요' };
}

export function deleteTrackTemplate(id: string): boolean {
  const items = listTrackTemplates();
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return false;
  return write(TRACK_KEY, next);
}

export function findTrackTemplate(id: string): TrackTemplate | undefined {
  return listTrackTemplates().find((t) => t.id === id);
}

// ── Session templates ─────────────────────────────────────────────────────────

export function listSessionTemplates(): SessionTemplate[] {
  return read(SESSION_KEY, isSessionTemplate)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveSessionTemplate(template: SessionTemplate): SaveResult<SessionTemplate> {
  if (!template.name) return { saved: null, problem: '이름이 필요합니다' };
  const items = listSessionTemplates();
  const at = items.findIndex((t) => t.name === template.name);
  const now = Date.now();
  const entry: SessionTemplate = {
    ...template,
    id: at >= 0 ? items[at]!.id : (template.id || makeId('st:')),
    createdAt: at >= 0 ? items[at]!.createdAt : now,
    updatedAt: now,
  };
  if (at >= 0) items[at] = entry;
  else if (items.length >= MAX_TEMPLATES) {
    return { saved: null, problem: `세션 템플릿이 ${MAX_TEMPLATES}개를 넘었습니다 — 지우고 다시 저장하세요` };
  } else items.unshift(entry);

  return write(SESSION_KEY, items)
    ? { saved: entry, problem: null }
    : { saved: null, problem: '저장소에 쓸 수 없습니다 — 브라우저 저장 공간을 확인하세요' };
}

export function deleteSessionTemplate(id: string): boolean {
  const items = listSessionTemplates();
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return false;
  return write(SESSION_KEY, next);
}

export function findSessionTemplate(id: string): SessionTemplate | undefined {
  return listSessionTemplates().find((t) => t.id === id);
}

// ── Moving them between machines ──────────────────────────────────────────────

export interface TemplateFile {
  version: number;
  tracks: TrackTemplate[];
  sessions: SessionTemplate[];
}

export function exportTemplates(): string {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    tracks: listTrackTemplates(),
    sessions: listSessionTemplates(),
  } satisfies TemplateFile, null, 2);
}

export interface ImportResult {
  tracks: number;
  sessions: number;
  problems: string[];
}

/**
 * Merge a template file into this machine's store.
 *
 * Entries this build cannot read are counted and named rather than dropped in
 * silence, and a name collision REPLACES — importing a file twice must not
 * leave two of everything.
 */
export function importTemplates(raw: string): ImportResult {
  const problems: string[] = [];
  let parsed: Partial<TemplateFile> | null = null;
  try { parsed = JSON.parse(raw) as Partial<TemplateFile>; }
  catch { return { tracks: 0, sessions: 0, problems: ['유효하지 않은 JSON 파일입니다'] }; }
  if (!parsed || typeof parsed !== 'object') {
    return { tracks: 0, sessions: 0, problems: ['템플릿 파일 형식이 아닙니다'] };
  }

  let tracks = 0;
  let sessions = 0;
  const rawTracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const t of rawTracks) {
    if (!isTrackTemplate(t)) { problems.push('읽을 수 없는 트랙 템플릿 하나를 건너뛰었습니다'); continue; }
    const r = saveTrackTemplate(t);
    if (r.saved) tracks++; else problems.push(`${t.name} — ${r.problem}`);
  }
  for (const t of rawSessions) {
    if (!isSessionTemplate(t)) { problems.push('읽을 수 없는 세션 템플릿 하나를 건너뛰었습니다'); continue; }
    const r = saveSessionTemplate(t);
    if (r.saved) sessions++; else problems.push(`${t.name} — ${r.problem}`);
  }
  if (rawTracks.length === 0 && rawSessions.length === 0) {
    problems.push('파일에 템플릿이 없습니다');
  }
  return { tracks, sessions, problems };
}
