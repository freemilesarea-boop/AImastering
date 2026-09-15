// Where a sample library is allowed to read from.
//
// An .sfz file is somebody else's text, and every `sample=` in it is a path
// this process will open.  A library downloaded from the internet naming
//
//     <region> sample=../../../../../../etc/passwd
//
// is not a hypothetical — it is the obvious attack on any sampler that
// resolves paths relative to a root and then reads them.  Nothing else in the
// pipeline would notice: the bytes come back, `decodeAudioData` rejects them,
// and the file has already been read.
//
// So containment is checked here, once, before the read — the same shape as
// `stemPath.ts` uses for a name the renderer supplies.

import path from 'node:path';

export class SamplePathError extends Error {}

/**
 * Resolve one sample path inside its library, or refuse.
 *
 * `root` is the directory the .sfz was opened from.  The result is guaranteed
 * to be inside it, so a traversal, an absolute path, or a symlink-looking
 * name cannot reach outside the library the user chose.
 */
export function samplePathIn(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0')) {
    throw new SamplePathError('잘못된 샘플 경로입니다');
  }
  const base = path.resolve(root);
  // An absolute path in the .sfz is not "relative to the library" by any
  // reading, so it is refused rather than quietly resolved.
  if (path.isAbsolute(relative)) {
    throw new SamplePathError('샘플 경로는 라이브러리 안에 있어야 합니다');
  }
  const dest = path.resolve(base, relative);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (dest !== base && !dest.startsWith(withSep)) {
    throw new SamplePathError('샘플 경로가 라이브러리 밖을 가리킵니다');
  }
  return dest;
}
