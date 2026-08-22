// OMF — recognised, and refused with the reason.
//
// OMF and AAF get named in one breath and are not one format.  AAF is an
// object graph inside a Microsoft compound file; OMF is an object graph
// inside BENTO, an unrelated container from the early nineties whose table
// of contents lives at the END of the file.  Nothing in the AAF reader can
// be pointed at an OMF: not the sector layout, not the property encoding,
// not the class ids.
//
// So this build reads AAF and does not read OMF, and the honest thing is to
// say which file you handed over and what to do about it.  The alternative —
// a half-written OMF importer that produces a plausible-looking timeline —
// fails in the one place that costs a day: the mix session, after the
// picture editor has gone home.
//
// It is also worth saying plainly: OMF has been superseded.  Avid, Pro Tools
// and Resolve have all exported AAF for over a decade, and asking for one is
// usually a two-minute conversation rather than a conversion job.

/** ASCII "OMFI" — the tag both OMF 1 and OMF 2 carry. */
const OMFI = [0x4F, 0x4D, 0x46, 0x49];
/** The Bento container label, which sits near the end of the file. */
const BENTO_LABEL = [0xA4, 0x43, 0x4D, 0xA4];

function contains(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Is this an OMF file?
 *
 * Checked at both ends: OMF 1 puts its tag at the front, and a Bento
 * container's label is at the back, so a file that only ever gets its first
 * kilobyte read would be reported as "unknown format" rather than as what
 * it is.
 */
export function looksLikeOmf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(2048, bytes.length));
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
  return contains(head, OMFI) || contains(tail, OMFI) || contains(tail, BENTO_LABEL);
}

/** What to tell someone who just handed over an OMF. */
export const OMF_REFUSAL =
  'OMF 파일입니다 — 이 빌드는 AAF 만 읽습니다.'
  + ' OMF 는 AAF 와 이름만 나란히 불릴 뿐 컨테이너부터 다른 형식이라,'
  + ' AAF 리더로는 한 바이트도 읽히지 않습니다.'
  + ' 보내신 분께 AAF 로 다시 뽑아 달라고 하세요 —'
  + ' Avid · Pro Tools · Resolve 모두 10년 넘게 AAF 를 내보냅니다.';
