// The yes/no dialog behind `askConfirm` — see ui/confirm.ts for why it is not
// `window.confirm` and theme/layers.ts for why it sits where it does.

import React, { useEffect, useRef } from 'react';
import { useConfirmStore } from '../ui/confirm.js';
import { LAYER } from '../theme/layers.js';

export default function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const answer = useConfirmStore((s) => s.answer);
  const cancel = useRef<HTMLButtonElement>(null);

  // Focus lands on CANCEL, not on the destructive button: Enter arrives from
  // whatever the user was doing a moment ago, and a delete confirmed by a
  // keystroke aimed at something else is the failure this dialog exists to
  // prevent.
  useEffect(() => {
    if (!request) return;
    const id = window.setTimeout(() => cancel.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [request]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50"
      style={{ zIndex: LAYER.textPrompt }}
      data-testid="confirm-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(false); }
      }}
    >
      <div className="w-[400px] rounded-lg border border-zinc-700 bg-[#15151d] p-4 shadow-xl">
        <p className="text-[12px] text-zinc-200 mb-1">{request.title}</p>
        <p className="text-[11px] text-zinc-500 leading-relaxed" data-testid="confirm-detail">
          {request.detail}
        </p>
        <div className="flex justify-end gap-2 mt-3">
          <button
            ref={cancel}
            onClick={() => answer(false)}
            className="px-3 h-6 rounded text-[11px] border border-zinc-600 bg-zinc-800 text-zinc-200"
            data-testid="confirm-cancel"
          >취소</button>
          <button
            onClick={() => answer(true)}
            className={`px-3 h-6 rounded text-[11px] border ${request.danger
              ? 'border-red-500/70 bg-red-600/40 text-red-100'
              : 'border-zinc-600 bg-zinc-700 text-zinc-100'}`}
            data-testid="confirm-ok"
          >{request.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
