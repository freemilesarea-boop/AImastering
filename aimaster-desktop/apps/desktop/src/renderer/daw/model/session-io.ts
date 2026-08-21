// DAW session serialisation and Session Import.
//
// Import Session Data is the feature that saves a re-do: pull selected
// tracks — with their clips, inserts, sends, automation and source files —
// out of another session and into this one.  Ids are remapped on the way in
// so two sessions built from the same template cannot collide.

import { DAW_SESSION_VERSION, type BusDef, type DawSession, type GroupDef, type Track } from './types.js';
import { nextId } from './ids.js';

export function serializeDawSession(session: DawSession): string {
  return JSON.stringify(session, null, 2);
}

export type ParseResult =
  | { ok: true; session: DawSession; warnings: string[] }
  | { ok: false; error: string };

export function deserializeDawSession(raw: string): ParseResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: '유효하지 않은 JSON 파일입니다.' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '세션 파일 형식이 올바르지 않습니다.' };
  }
  const o = parsed as Record<string, unknown>;
  if (o['version'] !== DAW_SESSION_VERSION) {
    return { ok: false, error: `지원하지 않는 세션 버전 (${String(o['version'])}).` };
  }
  if (!Array.isArray(o['tracks'])) return { ok: false, error: '트랙 정보가 없습니다.' };

  const warnings: string[] = [];
  const session = parsed as DawSession;
  if (!session.tracks.some((t) => t.kind === 'master')) {
    warnings.push('마스터 트랙이 없어 새로 만들었습니다.');
  }
  return { ok: true, session, warnings };
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Tracks to pull in.  Empty = every audio/aux track in the source. */
  trackIds?: string[];
  /** Bring the source's playlists (takes) along, not just the active one. */
  includeAlternatePlaylists?: boolean;
  /** Bring automation lanes along. */
  includeAutomation?: boolean;
}

export interface ImportResult {
  session: DawSession;
  importedTrackIds: string[];
  warnings: string[];
}

/**
 * Merge tracks from `source` into `target`.  Everything a track depends on —
 * files, the buses it outputs / sends to, the groups it belongs to — comes
 * with it, remapped to fresh ids.
 */
export function importSessionData(
  target: DawSession, source: DawSession, options: ImportOptions = {},
): ImportResult {
  const warnings: string[] = [];
  const wanted = new Set(options.trackIds ?? source.tracks
    .filter((t) => t.kind === 'audio' || t.kind === 'aux')
    .map((t) => t.id));

  const busMap   = new Map<string, string>();
  const fileMap  = new Map<string, string>();
  const trackMap = new Map<string, string>();

  const buses: BusDef[] = [...target.buses];
  const files = [...target.files];
  const tracks: Track[] = [];
  const groups: GroupDef[] = [...target.groups];

  const mapBus = (id: string): string => {
    const existing = busMap.get(id);
    if (existing) return existing;
    const srcBus = source.buses.find((b) => b.id === id);
    // Reuse a target bus with the same name — importing "Reverb A" twice
    // should land on one bus, not two.
    const match = srcBus ? buses.find((b) => b.name === srcBus.name) : undefined;
    const created: BusDef = match ?? {
      id: nextId('bus'),
      name: srcBus?.name ?? 'Imported Bus',
      channels: srcBus?.channels ?? 2,
    };
    if (!match) buses.push(created);
    busMap.set(id, created.id);
    return created.id;
  };

  const mapFile = (id: string): string => {
    const existing = fileMap.get(id);
    if (existing) return existing;
    const srcFile = source.files.find((f) => f.id === id);
    if (!srcFile) { fileMap.set(id, id); return id; }
    const match = files.find((f) => f.path === srcFile.path);
    if (match) { fileMap.set(id, match.id); return match.id; }
    const copy = { ...srcFile, id: nextId('file') };
    files.push(copy);
    fileMap.set(id, copy.id);
    return copy.id;
  };

  for (const track of source.tracks) {
    if (!wanted.has(track.id)) continue;
    if (track.kind === 'master') { warnings.push('마스터 트랙은 가져오지 않습니다.'); continue; }

    const newId = nextId('trk');
    trackMap.set(track.id, newId);

    const playlists = (options.includeAlternatePlaylists
      ? track.playlists
      : track.playlists.filter((p) => p.id === track.activePlaylistId)
    ).map((p) => ({
      id: nextId('pl'),
      name: p.name,
      clips: p.clips.map((c) => ({ ...c, id: nextId('clip'), fileId: mapFile(c.fileId) })),
    }));
    const activePlaylist = playlists[0];
    if (!activePlaylist) { warnings.push(`${track.name}: 플레이리스트가 없어 건너뜁니다.`); continue; }

    tracks.push({
      ...track,
      id: newId,
      name: uniqueName(track.name, [...target.tracks, ...tracks]),
      playlists,
      activePlaylistId: activePlaylist.id,
      input: track.input ? mapBus(track.input) : null,
      output: track.output.kind === 'bus'
        ? { kind: 'bus', busId: mapBus(track.output.busId) }
        : track.output,
      inserts: track.inserts.map((i) => ({
        ...i,
        id: nextId('ins'),
        sidechainSource: i.sidechainSource ? mapBus(i.sidechainSource) : null,
      })),
      sends: track.sends.map((s) => ({ ...s, id: nextId('snd'), target: mapBus(s.target) })),
      automation: options.includeAutomation === false
        ? []
        : track.automation.map((l) => ({ ...l, id: nextId('lane') })),
      groupIds: [],
      vcaId: null,          // VCAs are not imported; the assignment would dangle
    });
  }

  // Rebuild the groups whose members all came across.
  for (const group of source.groups) {
    const members = group.memberIds.map((m) => trackMap.get(m)).filter((m): m is string => Boolean(m));
    if (members.length === 0) continue;
    const created: GroupDef = { ...group, id: nextId('grp'), memberIds: members };
    groups.push(created);
    for (const t of tracks) if (members.includes(t.id)) t.groupIds = [...t.groupIds, created.id];
  }

  // Keep the master last.
  const masterIndex = target.tracks.findIndex((t) => t.kind === 'master');
  const merged = [...target.tracks];
  merged.splice(masterIndex === -1 ? merged.length : masterIndex, 0, ...tracks);

  return {
    session: { ...target, tracks: merged, buses, files, groups },
    importedTrackIds: tracks.map((t) => t.id),
    warnings,
  };
}

/** "Vox" → "Vox 2" when the name is taken. */
export function uniqueName(name: string, existing: readonly Track[]): string {
  const taken = new Set(existing.map((t) => t.name));
  if (!taken.has(name)) return name;
  for (let n = 2; n < 999; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}
