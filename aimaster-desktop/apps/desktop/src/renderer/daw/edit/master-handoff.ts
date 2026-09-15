// From the mixer to the masterer, in one press.
//
// The app has two halves and until now they only joined one way: the home
// screen could send a track INTO the DAW, and getting a finished mix back out
// meant bouncing it to disk, going home, and adding the file you had just
// made.  Three steps, one of which is a file dialog, to cross a seam inside a
// single program.
//
// ── Why the refusals are computed before anything renders ────────────────────
//
// Rendering a five-minute session takes seconds and the reasons it might be
// pointless are all knowable in advance.  A button that spends those seconds
// and then says "there was nothing to send" has taken the time to tell you
// something it knew before it started — and, worse, an app that only refuses
// after the work looks broken rather than careful.  So this is the same shape
// as `spotProblem`: one function that says what is wrong, called by the UI to
// disable the control and by the command to refuse.

import { isAudible } from '../model/mixer-math.js';
import { sessionEndSec, trackClips } from '../model/session-ops.js';
import type { DawSession } from '../model/types.js';

/** Queue capacity, mirrored from the mastering store it feeds. */
export const MASTER_QUEUE_LIMIT = 20;

export interface HandoffState {
  /** How many files are already waiting to be mastered. */
  queued: number;
  /**
   * Whether this session already has a row that the send would replace.
   *
   * A replacement needs no free slot, so a full queue must not refuse it —
   * otherwise the one thing a full list has to allow, updating a mix that is
   * already on it, is the one thing it blocks.
   */
  replacesExisting?: boolean;
}

/**
 * Why this mix cannot be sent, or null when it can.
 *
 * Each reason says what to do about it, because "cannot send" on its own sends
 * the person looking for a bug that is not there.
 */
export function handoffProblem(session: DawSession, state: HandoffState): string | null {
  if (sessionEndSec(session) <= 0) {
    return '보낼 오디오가 없습니다 — 클립을 먼저 놓으세요';
  }
  // Everything muted renders silence, and silence in the mastering list is a
  // confusing thing to be handed: the file is there, it is the right length,
  // and it does nothing.
  //
  // Only tracks that actually HOLD something are counted.  Asking `isAudible`
  // about every track in the session answers yes for the master — which is
  // always audible and never a source — so the check would never fire.  Solo
  // is already folded into `isAudible`, so a solo somewhere else reads here as
  // "this track is not heard", which is what it is.
  const heard = session.tracks.filter(
    (t) => trackClips(t).length > 0 && isAudible(session, t));
  if (heard.length === 0) {
    return '들리는 트랙이 없습니다 — 전부 음소거되어 있거나 솔로가 다른 트랙에 걸려 있습니다';
  }
  // A re-send takes the row it already has, so a full queue is no obstacle to
  // it.  Refusing here would mean the one thing a full queue must never block:
  // updating a mix that is already in the list.
  if (state.queued >= MASTER_QUEUE_LIMIT && !state.replacesExisting) {
    return `마스터링 대기열이 꽉 찼습니다 (${MASTER_QUEUE_LIMIT}곡)`
      + ' — 홈에서 몇 곡 지운 뒤에 다시 보내세요';
  }
  return null;
}

/**
 * What the person is told after a send that worked.
 *
 * Names the file, because the mastering list is about to have one more row in
 * it and which row is theirs is not otherwise obvious.
 */
export function handoffMessage(fileName: string, queuedAfter: number): string {
  const more = queuedAfter > 1 ? ` — 대기열 ${queuedAfter}곡` : '';
  return `${fileName} 을(를) 마스터링으로 보냈습니다${more}`;
}

/**
 * What to say after a send, given what the queue did with it.
 *
 * A replacement has to be said out loud.  Silently swapping the row would
 * look identical to nothing happening, and the person who just changed their
 * mix and pressed the button needs to know the list now holds the new one.
 */
export function stageMessage(
  fileName: string, outcome: 'added' | 'replaced' | 'added-beside-running', queuedAfter: number,
): string {
  const more = queuedAfter > 1 ? ` — 대기열 ${queuedAfter}곡` : '';
  if (outcome === 'replaced') return `${fileName} 을(를) 새 믹스로 교체했습니다${more}`;
  if (outcome === 'added-beside-running') {
    return `${fileName} 을(를) 추가했습니다 — 이전 믹스는 마스터링 중이라 그대로 뒀습니다${more}`;
  }
  return handoffMessage(fileName, queuedAfter);
}

/** The name the mastering list will show for this session. */
export function handoffFileName(sessionName: string): string {
  const safe = sessionName.replace(/[^\w.\-가-힣 ]+/g, '_').slice(0, 80).trim();
  return `${safe.length > 0 ? safe : 'mix'}.wav`;
}
