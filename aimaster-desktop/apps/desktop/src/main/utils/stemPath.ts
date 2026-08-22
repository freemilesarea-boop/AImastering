// Where a stem file is allowed to land.
//
// The renderer chooses each stem's file name (it is the one that knows the
// track order and how names were de-duplicated), and a name that arrives on
// an IPC channel is untrusted input however friendly the sender.  A name of
// `../../secrets` would otherwise write outside the folder the user picked.
//
// Two layers on purpose: the name is stripped down to characters a file name
// can carry, and then the RESULT is checked to be a direct child of the
// destination.  The first is what usually catches it; the second is what
// catches whatever the first did not think of.

import path from 'node:path';

/** Characters allowed in a stem file name — letters, digits, Hangul, spaces. */
const UNSAFE = /[^\w.\-가-힣 ()]+/g;

export class StemPathError extends Error {}

export function stemFileName(name: string): string {
  // A leading dot would make the file hidden, and a name that is only dots
  // resolves to the directory itself.
  const cleaned = name.replace(UNSAFE, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return cleaned || 'stem';
}

/**
 * The absolute path a stem may be written to, or a throw.
 *
 * `directory` is the folder chosen through the save dialog; nothing else is
 * a legal destination.
 */
export function stemFilePath(directory: string, name: string): string {
  const dir = path.resolve(directory);
  const dest = path.resolve(dir, `${stemFileName(name)}.wav`);
  if (path.dirname(dest) !== dir) {
    throw new StemPathError('잘못된 스템 파일 이름입니다');
  }
  return dest;
}
