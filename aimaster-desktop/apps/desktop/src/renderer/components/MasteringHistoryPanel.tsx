// MasteringHistoryPanel — durable, cross-session mastering history (P2).
//
// Lists past masters (settings snapshot + metrics) newest-first with favorites
// pinned.  Each entry can restore its settings into the active options, be
// favorited (kept past the prune cap), renamed, or deleted.  Audio files are
// NOT archived (temp is purged between sessions) — this recalls *settings*.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { formatMetrics, formatOptionsSummary } from '../audio/revisions/revision-logic.js';
import type { HistoryEntry } from '../audio/mastering-history.js';

function sortForDisplay(entries: HistoryEntry[]): HistoryEntry[] {
  // Favorites first, then newest-first within each group (stable).
  return [...entries].sort((a, b) => {
    if (!!a.isFavorite !== !!b.isFavorite) return a.isFavorite ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '방금';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

export default function MasteringHistoryPanel(): React.ReactElement {
  const history = useAudioStore((s) => s.history);
  const restore = useAudioStore((s) => s.restoreHistoryEntry);
  const toggleFav = useAudioStore((s) => s.toggleHistoryFavorite);
  const rename = useAudioStore((s) => s.renameHistoryEntry);
  const remove = useAudioStore((s) => s.removeHistoryEntry);

  const entries = sortForDisplay(history.entries);

  if (entries.length === 0) {
    return <p className="text-[11px] text-zinc-600">아직 마스터링 이력이 없습니다. 마스터링을 실행하면 설정과 측정값이 여기에 저장됩니다.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-zinc-600">{entries.length}개 · 설정·측정값만 저장 (오디오 파일 아님)</p>
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleFav(e.id)}
                    aria-label={e.isFavorite ? '즐겨찾기 해제' : '즐겨찾기'}
                    className={`text-[11px] leading-none ${e.isFavorite ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400'}`}
                  >
                    {e.isFavorite ? '★' : '☆'}
                  </button>
                  <span className="truncate text-[11px] text-zinc-200" title={e.label}>{e.label}</span>
                </div>
                <p className="truncate text-[10px] text-zinc-500" title={e.sourceFileName}>{e.sourceFileName} · {timeAgo(e.createdAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => restore(e.id)} className="rounded bg-indigo-600/80 px-1.5 py-0.5 text-[10px] text-white hover:bg-indigo-600">설정 복원</button>
                <button
                  type="button"
                  onClick={() => { const v = window.prompt('이름 변경', e.label); if (v) rename(e.id, v); }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >이름</button>
                <button type="button" onClick={() => remove(e.id)} aria-label="삭제" className="text-[10px] text-zinc-600 hover:text-red-400">✕</button>
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] font-mono text-zinc-500">
              <span>{formatMetrics(e.metrics)}</span>
              <span className="text-zinc-600">·</span>
              <span>{formatOptionsSummary(e.optionsSnapshot)}</span>
              {e.formatSummary && <><span className="text-zinc-600">·</span><span>{e.formatSummary}</span></>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
