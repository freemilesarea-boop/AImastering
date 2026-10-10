// delete-tracks — the one route from "delete this" to `removeTracks`.
//
// In `ui/` rather than in `daw/edit/` because it reads the store, and the
// store already imports from `daw/edit` — putting it there would close a
// cycle.  Everything it decides is in `daw/edit/track-removal.ts`, which is
// pure; this is only the asking and the applying.
//
// One function, used by the track header's × and by Mod+Backspace, so the two
// cannot come to disagree about what the confirmation says or which tracks it
// means.

import type { TrackId } from '../daw/model/types.js';
import { removeTracks } from '../daw/model/session-ops.js';
import {
  describeRemoval, removalCost, removalTitle,
} from '../daw/edit/track-removal.js';
import { useDawStore } from '../stores/dawStore.js';
import { useAppStore } from '../stores/appStore.js';
import { askConfirm } from './confirm.js';

/**
 * Ask, then delete.  Resolves true when tracks were actually removed.
 *
 * Goes through `apply`, so Mod+Z brings the whole thing back — which is why
 * the confirmation can be one dialog rather than a two-step arm: the cost of
 * being wrong is one keystroke, and the dialog is there to say what the cost
 * IS, not to make it hard to answer.
 */
export async function deleteTracks(ids: readonly TrackId[]): Promise<boolean> {
  const { session } = useDawStore.getState();
  const notify = useAppStore.getState().notify;
  const cost = removalCost(session, ids);

  if (cost.names.length === 0) {
    notify(cost.refused.length > 0 ? '마스터는 지울 수 없습니다' : '지울 트랙을 고르세요', 'warning');
    return false;
  }

  const ok = await askConfirm(removalTitle(cost), describeRemoval(cost),
    { confirmLabel: '삭제', danger: true });
  if (!ok) return false;

  // Re-read: the dialog was on screen, and what it described has to be what
  // goes.  Names are captured above for the message, because after this the
  // tracks are gone and there is nothing left to name them from.
  useDawStore.getState().apply((s) => removeTracks(s, ids));
  notify(cost.names.length === 1
    ? `${cost.names[0]} 삭제 — Mod+Z 로 되돌립니다`
    : `트랙 ${cost.names.length}개 삭제 — Mod+Z 로 되돌립니다`, 'info');
  return true;
}
