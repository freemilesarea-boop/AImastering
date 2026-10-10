// confirm — asking before something that cannot be taken back by looking away.
//
// Beside `text-prompt.ts` rather than inside it: the two dialogs answer with
// different things (a string, a yes) and folding them into one request type
// makes every caller narrow a union to find out which one it asked.  They do
// share the one thing that has to be shared — `LAYER.textPrompt`, which
// exists because a dialog underneath a torn-off panel is a question nobody
// can answer.  See theme/layers.ts for the measurement.
//
// `window.confirm` is NOT the alternative here.  Electron does implement it,
// unlike prompt, but it is a native modal that cannot show what the answer
// costs — and the cost is the whole reason to ask: "delete 드럼" and "delete
// 드럼, 그 안의 트랙 3개는 남고, 클립 41개와 인서트 6개가 사라집니다" are
// different questions.

import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  /** The second line: what it costs, in the caller's own words. */
  detail: string;
  /** What the accepting button says — a verb, not "확인". */
  confirmLabel: string;
  /** Paints the accepting button as destructive. */
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface ConfirmStore {
  request: ConfirmRequest | null;
  /** Answer the open request and close.  Idempotent: no double resolve. */
  answer: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  request: null,
  answer: (ok) => {
    const open = get().request;
    if (!open) return;
    set({ request: null });
    open.resolve(ok);
  },
}));

/**
 * Ask a yes/no question.  Resolves false for no, and for anything that
 * dismisses it — a cancel and a click outside mean the same thing, and the
 * safe reading of "I did not answer" is "do not do it".
 */
export function askConfirm(
  title: string, detail: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A second ask while one is open answers the first as a no rather than
    // leaving its promise unresolved — a caller waiting forever is worse than
    // a caller told no.
    useConfirmStore.getState().answer(false);
    useConfirmStore.setState({
      request: {
        title, detail,
        confirmLabel: options.confirmLabel ?? '확인',
        danger: options.danger ?? false,
        resolve,
      },
    });
  });
}
