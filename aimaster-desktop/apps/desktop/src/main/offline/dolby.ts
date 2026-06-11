// dolby — Dolby codec export for the multichannel surround output (Phase 4).
//
// Encodes the multichannel WAV to a real Dolby codec with the bundled ffmpeg:
// AC-3 (Dolby Digital), E-AC-3 (Dolby Digital Plus), or TrueHD (lossless).
//
// Scope: standard Dolby codecs.  Dolby ATMOS (E-AC-3 + JOC object metadata) is
// NOT here — that needs Dolby's proprietary encoder; the ADM BWF path
// (adm.ts) is the open authoring route to Atmos tools.
//
// Pure helpers (no I/O); the actual ffmpeg call lives in the render path.

export type DolbyCodec = 'none' | 'ac3' | 'eac3' | 'truehd';
export const DOLBY_CODECS: DolbyCodec[] = ['none', 'ac3', 'eac3', 'truehd'];

export function dolbyExt(codec: DolbyCodec): string {
  switch (codec) {
    case 'ac3': return '.ac3';
    case 'eac3': return '.eac3';
    case 'truehd': return '.thd';
    default: return '';
  }
}

export function dolbyLabel(codec: DolbyCodec): string {
  switch (codec) {
    case 'ac3': return 'Dolby Digital (AC-3)';
    case 'eac3': return 'Dolby Digital Plus (E-AC-3)';
    case 'truehd': return 'Dolby TrueHD (무손실)';
    default: return '없음';
  }
}

/** ffmpeg `-c:a …` args for a Dolby codec ([] for 'none'). */
export function dolbyEncodeArgs(codec: DolbyCodec): string[] {
  switch (codec) {
    case 'ac3': return ['-c:a', 'ac3', '-b:a', '640k'];   // AC-3 max (5.1; 7.1 down-mixes)
    case 'eac3': return ['-c:a', 'eac3', '-b:a', '448k']; // E-AC-3 supports 7.1
    case 'truehd': return ['-strict', 'experimental', '-c:a', 'truehd']; // lossless (ffmpeg's truehd encoder is experimental)
    default: return [];
  }
}

export function isDolbyEnabled(codec: DolbyCodec | undefined | null): boolean {
  return !!codec && codec !== 'none';
}
