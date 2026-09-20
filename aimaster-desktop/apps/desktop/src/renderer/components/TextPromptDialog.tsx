// The one-line text dialog behind `askText` — see ui/text-prompt.ts for why
// this exists at all (Electron's window.prompt throws).

import React, { useEffect, useRef, useState } from 'react';
import { useTextPromptStore } from '../ui/text-prompt.js';
import { LAYER } from '../theme/layers.js';

export default function TextPromptDialog() {
  const request = useTextPromptStore((s) => s.request);
  const answer = useTextPromptStore((s) => s.answer);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);

  // Re-seed on each new request rather than on mount: the dialog is one
  // component reused for every ask, so a stale value would offer the previous
  // question's answer as this one's default.
  useEffect(() => {
    if (!request) return;
    setValue(request.initial);
    // Selected, not just focused — the common case is replacing the old name,
    // and having to clear it first is the thing that makes renaming tedious.
    const id = window.setTimeout(() => { input.current?.focus(); input.current?.select(); }, 0);
    return () => window.clearTimeout(id);
  }, [request]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50"
      style={{ zIndex: LAYER.textPrompt }}
      data-testid="text-prompt"
      onMouseDown={(e) => { if (e.target === e.currentTarget) answer(null); }}
    >
      <div className="w-[360px] rounded-lg border border-zinc-700 bg-[#15151d] p-4 shadow-xl">
        <p className="text-[12px] text-zinc-300 mb-2">{request.title}</p>
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); answer(value); }
            // Stopped here as well as handled: Escape is bound in the DAW
            // layer too, and closing this must not also drop a selection.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(null); }
          }}
          className="w-full h-7 rounded px-2 text-[12px] bg-zinc-950 border border-zinc-700 text-zinc-100"
          data-testid="text-prompt-input"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={() => answer(null)}
            className="px-3 h-6 rounded text-[11px] border border-zinc-700 bg-zinc-900 text-zinc-400"
          >취소</button>
          <button
            onClick={() => answer(value)}
            className="px-3 h-6 rounded text-[11px] border border-zinc-600 bg-zinc-700 text-zinc-100"
            data-testid="text-prompt-ok"
          >확인</button>
        </div>
      </div>
    </div>
  );
}
