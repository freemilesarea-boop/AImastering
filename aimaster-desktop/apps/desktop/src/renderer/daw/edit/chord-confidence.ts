// How sure the chart is, and how to say so.
//
// This is display logic and it does not live in the view, for the reason
// stage D ran into with the benchmark's grid label: an honesty property that
// cannot be tested is a decoration.  The rule below — that a chord a PERSON
// wrote is never doubtful — is exactly the kind of thing that would rot
// silently inside a React component.

import { UNSURE_MARGIN } from '../audio/chroma/chord-segment.js';
import { formatChord, type ChordEvent } from '../model/chords.js';

export { UNSURE_MARGIN };

/**
 * Whether the detector was near a coin toss on this chord.
 *
 * A chord with no margin at all is one a person put there, and a person's
 * chord is NOT doubtful — it is the answer.  Marking it unsure because we
 * have no number for it would be the display lying in the other direction,
 * and it would put the user's own decisions into the list of things to go
 * back and check.
 */
export function isUnsure(event: ChordEvent): boolean {
  return event.margin !== undefined && event.margin < UNSURE_MARGIN;
}

/** The doubtful chords, in time order — the ones worth listening back to. */
export function unsureChords(events: readonly ChordEvent[]): ChordEvent[] {
  return [...events].sort((a, b) => a.timeSec - b.timeSec).filter(isUnsure);
}

/**
 * The next one to go and listen to, wrapping around at the end.
 *
 * Wrapping matters more than it looks: the point of the count is to work
 * through the doubtful bars, and a button that goes dead after the last one
 * makes the user find the first again by hand.
 */
export function nextUnsureAfter(
  events: readonly ChordEvent[], timeSec: number,
): ChordEvent | null {
  const list = unsureChords(events);
  if (list.length === 0) return null;
  return list.find((e) => e.timeSec > timeSec + 1e-6) ?? list[0] ?? null;
}

/**
 * What a chord block says on hover.
 *
 * Three different sentences, because there are three different situations and
 * one tooltip for all of them would be useless: a chord somebody typed, a
 * chord the detector is sure of, and a chord it nearly called something else.
 */
export function describeChordBlock(event: ChordEvent): string {
  const name = formatChord(event.chord);
  if (event.margin === undefined) return `${name} — 더블클릭해서 고쳐 쓰세요`;
  const lead = `${(event.margin * 100).toFixed(1)}%`;
  if (isUnsure(event)) {
    return `${name} — 검출기가 2위와 거의 비등했습니다 (차이 ${lead}).`
      + ' 들어보고 고쳐 쓰면 이 표시가 사라집니다';
  }
  return `${name} — 오디오에서 읽음 (2위와 차이 ${lead}). 더블클릭해서 고쳐 쓰세요`;
}
