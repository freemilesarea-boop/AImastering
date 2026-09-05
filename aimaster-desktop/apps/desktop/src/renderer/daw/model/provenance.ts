// provenance.ts — what made this recording, written into the recording.
//
// Two questions follow a track for the rest of its life, and neither is
// answerable from the audio:
//
//   1. Was a machine involved, and in what?
//   2. Is this built on somebody else's work, and by what right?
//
// Distributors now ask the first at upload.  The second decides whether a
// claim gets released or upheld.  Both are cheap to answer at the moment of
// export, when the app still knows, and expensive to answer six months later
// from memory.
//
// ── What this is NOT ─────────────────────────────────────────────────────────
//
// It is not a way around Content ID.  Fingerprint matching reads the AUDIO;
// no tag in a file changes whether a match fires.  What a record like this
// does is let you answer the claim: here is what the track is built on, here
// is the right under which, here is what was added.  Claiming otherwise would
// be selling a lie to somebody about to release music.
//
// ── The one rule ─────────────────────────────────────────────────────────────
//
// The app writes what the app did, and the user cannot delete it.  A
// disclosure that a person can quietly empty is not a disclosure — it is a
// checkbox that always says what its owner wants it to say.  `aiWork` is
// therefore appended by the pipeline, and only the human-authored fields are
// free text.

/** What a machine did. */
export type AiKind =
  | 'mastering'      // the loudness / tonal chain
  | 'separation'     // stems pulled out of a mix
  | 'pitch'          // pitch correction or transfer
  | 'timing'         // quantise / align
  | 'generation'     // material the model invented
  | 'other';

export const AI_KIND_LABELS: Record<AiKind, string> = {
  mastering:  'AI 마스터링',
  separation: 'AI 음원 분리',
  pitch:      'AI 피치',
  timing:     'AI 타이밍',
  generation: 'AI 생성',
  other:      'AI 기타',
};

export interface AiStep {
  kind: AiKind;
  /** The specific thing, e.g. "Loui AI Pop · −10 LUFS". */
  detail: string;
}

/** Why you are allowed to build on the source. */
export type LicenceBasis =
  | 'own-work'      // it is yours
  | 'licensed'      // you hold a licence
  | 'permission'    // written permission from the holder
  | 'public-domain'
  | 'unknown';      // you have not established one — say so rather than guess

export const BASIS_LABELS: Record<LicenceBasis, string> = {
  'own-work':      '자작',
  licensed:        '라이선스 보유',
  permission:      '권리자 허락',
  'public-domain': '퍼블릭 도메인',
  unknown:         '미확인',
};

/** A work this one is built on. */
export interface SourceWork {
  title: string;
  artist: string;
  /** The recording's identifier, when you have it. */
  isrc?: string;
  basis: LicenceBasis;
  /** Licence number, contract, URL — whatever backs the basis up. */
  note?: string;
}

export interface Provenance {
  title: string;
  artist: string;
  /** Release year.  Null while unknown — 0 would read as a real year. */
  year: number | null;
  copyright: string;
  /** What a person did, in their own words. */
  humanWork: string[];
  /** What a machine did.  Written by the pipeline, not typed. */
  aiWork: AiStep[];
  /** What this is built on.  Empty means "original work". */
  derivedFrom: SourceWork[];
}

export function emptyProvenance(title = '', artist = ''): Provenance {
  return { title, artist, year: null, copyright: '', humanWork: [], aiWork: [], derivedFrom: [] };
}

/**
 * Record a machine step.  Identical steps collapse: mastering a track three
 * times while tweaking is one fact about the track, not three.
 */
export function withAiStep(p: Provenance, step: AiStep): Provenance {
  const detail = step.detail.trim();
  if (detail.length === 0) return p;
  const already = p.aiWork.some((s) => s.kind === step.kind && s.detail === detail);
  if (already) return p;
  return { ...p, aiWork: [...p.aiWork, { kind: step.kind, detail }] };
}

/** Record something a person did. */
export function withHumanWork(p: Provenance, what: string): Provenance {
  const text = what.trim();
  if (text.length === 0 || p.humanWork.includes(text)) return p;
  return { ...p, humanWork: [...p.humanWork, text] };
}

export function withSource(p: Provenance, source: SourceWork): Provenance {
  return { ...p, derivedFrom: [...p.derivedFrom, source] };
}

export function isDerivative(p: Provenance): boolean {
  return p.derivedFrom.length > 0;
}

export function usedAi(p: Provenance): boolean {
  return p.aiWork.length > 0;
}

/**
 * What is missing before this can be sent anywhere.
 *
 * Returns null when the record is complete enough to stand behind.  These are
 * the things a distributor or a claim reviewer asks, so an empty answer is a
 * problem now rather than a surprise later.
 */
export function provenanceProblem(p: Provenance): string | null {
  if (p.title.trim().length === 0) return '제목이 비어 있습니다';
  if (p.artist.trim().length === 0) return '아티스트가 비어 있습니다';
  for (const s of p.derivedFrom) {
    if (s.title.trim().length === 0) return '원곡 제목이 비어 있습니다';
    if (s.basis === 'unknown') {
      return `"${s.title}" 의 이용 근거가 미확인입니다 — 확인하거나, 미확인이라고 적힌 채 나갑니다`;
    }
  }
  return null;
}

/** One paragraph a person can read, for the file's comment field. */
export function describeProvenance(p: Provenance): string {
  const lines: string[] = [];
  if (p.humanWork.length > 0) lines.push(`사람 작업: ${p.humanWork.join(', ')}`);
  lines.push(p.aiWork.length > 0
    ? `AI 작업: ${p.aiWork.map((s) => `${AI_KIND_LABELS[s.kind]}(${s.detail})`).join(', ')}`
    : 'AI 작업: 없음');
  if (p.derivedFrom.length > 0) {
    lines.push(`2차 창작 — 원곡: ${p.derivedFrom.map((s) => {
      const who = s.artist.trim().length > 0 ? ` / ${s.artist}` : '';
      const isrc = s.isrc ? ` [ISRC ${s.isrc}]` : '';
      const note = s.note ? ` (${s.note})` : '';
      return `${s.title}${who}${isrc} — ${BASIS_LABELS[s.basis]}${note}`;
    }).join(' · ')}`);
  } else {
    lines.push('2차 창작 아님 (원저작물)');
  }
  return lines.join(' | ');
}

/** RIFF LIST/INFO tags — the fields every player and tagger reads. */
export function infoTags(p: Provenance, appVersion: string, at = new Date()): [string, string][] {
  const tags: [string, string][] = [];
  if (p.title.trim())  tags.push(['INAM', p.title.trim()]);
  if (p.artist.trim()) tags.push(['IART', p.artist.trim()]);
  if (p.copyright.trim()) tags.push(['ICOP', p.copyright.trim()]);
  tags.push(['ICRD', (p.year ?? at.getFullYear()).toString()]);
  tags.push(['ISFT', `Louver Mastering AI ${appVersion}`]);
  tags.push(['ICMT', describeProvenance(p)]);
  return tags;
}

/**
 * Broadcast Wave `CodingHistory` — the professional standard for "what
 * happened to this file", one CRLF line per step, read by every mastering and
 * broadcast tool.
 */
export function codingHistory(p: Provenance, appVersion: string): string {
  const lines = p.aiWork.map((s) =>
    `A=ANALOGUE,T=${AI_KIND_LABELS[s.kind]}: ${s.detail}`);
  for (const w of p.humanWork) lines.push(`A=ANALOGUE,T=사람 작업: ${w}`);
  for (const s of p.derivedFrom) {
    lines.push(`A=ANALOGUE,T=원곡: ${s.title} / ${s.artist} — ${BASIS_LABELS[s.basis]}`);
  }
  lines.push(`A=PCM,T=Louver Mastering AI ${appVersion}`);
  return lines.join('\r\n') + '\r\n';
}

/** The full record, for anything that wants to read it back exactly. */
export function provenanceJson(p: Provenance, appVersion: string, at = new Date()): string {
  return JSON.stringify({
    schema: 'loui.provenance/1',
    writtenAt: at.toISOString(),
    writtenBy: `Louver Mastering AI ${appVersion}`,
    title: p.title,
    artist: p.artist,
    year: p.year,
    copyright: p.copyright,
    humanWork: p.humanWork,
    aiWork: p.aiWork,
    derivative: p.derivedFrom.length > 0,
    derivedFrom: p.derivedFrom,
  });
}
