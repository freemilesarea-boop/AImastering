// PoolPanel — every file the session holds, and what became of it.
//
// The questions this answers are the ones nobody can answer after an hour of
// editing: which of these forty takes am I using, why is the project folder
// 8 GB, and where did this file come from.  All of them are derivable from the
// session, so the panel keeps no state of its own beyond the search box.
//
// "Delete unused" is the one destructive button, so it says what it will take
// before it takes it, and the model recomputes the pool rather than trusting
// what this panel drew — the list may be a few edits old by the time it is
// pressed.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import {
  POOL_FILTER_LABELS, buildPool, describePool, queryPool, removeUnusedFiles,
  summarisePool, type PoolFilter, type PoolSort,
} from '../../../daw/model/clip-pool.js';

const SORTS: { id: PoolSort; label: string }[] = [
  { id: 'name', label: '이름' },
  { id: 'duration', label: '길이' },
  { id: 'uses', label: '쓰임' },
  { id: 'unused-first', label: '안 쓰는 것 먼저' },
];

const field = {
  background: '#1d1d28', border: '1px solid #3a3a48', borderRadius: 4,
  padding: '3px 8px', fontSize: 11, color: premium.text.primary,
} as const;

const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export default function PoolPanel({ onClose }: { onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const seek = useDawStore((s) => s.seek);
  const setSelection = useDawStore((s) => s.setSelection);
  const notify = useAppStore((s) => s.notify);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PoolFilter>('all');
  const [sort, setSort] = useState<PoolSort>('name');
  const [open, setOpen] = useState<string | null>(null);

  const pool = useMemo(() => buildPool(session), [session]);
  const shown = useMemo(() => queryPool(pool, { search, filter, sort }), [pool, search, filter, sort]);
  const summary = useMemo(() => summarisePool(pool), [pool]);

  const cleanUp = (): void => {
    if (summary.unused === 0) { notify('안 쓰는 파일이 없습니다'); return; }
    apply((s) => removeUnusedFiles(s));
    notify(`안 쓰는 파일 ${summary.unused}개 제거 (${mmss(summary.unusedSec)})`, 'success');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-lg border p-5"
        style={{
          width: 780, maxHeight: '84vh', background: '#15151d', borderColor: '#3a3a48',
          fontFamily: premium.type.sans, color: premium.text.primary,
          display: 'flex', flexDirection: 'column',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="pool-panel"
      >
        <div className="flex items-baseline justify-between mb-3">
          <h2 style={{ fontFamily: premium.type.display, fontSize: 17 }}>파일 풀</h2>
          <span style={{ fontSize: 11, color: premium.text.muted }} data-testid="pool-summary">
            {describePool(summary)}
          </span>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            style={{ ...field, flex: 1 }} value={search} autoFocus
            placeholder="파일 · 클립 · 트랙 이름으로 찾기"
            onChange={(e) => setSearch(e.target.value)}
            data-testid="pool-search"
          />
          <select style={field} value={filter}
            onChange={(e) => setFilter(e.target.value as PoolFilter)} data-testid="pool-filter">
            {(Object.keys(POOL_FILTER_LABELS) as PoolFilter[]).map((f) => (
              <option key={f} value={f}>{POOL_FILTER_LABELS[f]}</option>
            ))}
          </select>
          <select style={field} value={sort} onChange={(e) => setSort(e.target.value as PoolSort)}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>

        <div className="rounded overflow-auto flex-1" style={{ background: '#1d1d28', minHeight: 200 }}>
          <div className="flex gap-2 px-3 py-1 sticky top-0"
            style={{ background: '#22222e', fontSize: 10, color: premium.text.muted }}>
            <span style={{ flex: 1 }}>파일</span>
            <span style={{ width: 56 }}>길이</span>
            <span style={{ width: 56 }}>쓰는 양</span>
            <span style={{ width: 44 }}>클립</span>
            <span style={{ width: 60 }}>상태</span>
          </div>
          {shown.map((entry) => (
            <div key={entry.fileId}>
              <button
                className="w-full flex gap-2 px-3 py-1 text-left items-center"
                style={{ fontSize: 11, background: open === entry.fileId ? '#26263a' : 'transparent' }}
                onClick={() => setOpen(open === entry.fileId ? null : entry.fileId)}
                data-testid={`pool-row-${entry.fileId}`}
              >
                <span style={{ flex: 1, color: entry.unused ? premium.text.muted : premium.text.primary }}>
                  {entry.name}
                </span>
                <span style={{ width: 56, fontFamily: 'monospace', color: premium.text.muted }}>
                  {mmss(entry.durationSec)}
                </span>
                <span style={{ width: 56, fontFamily: 'monospace', color: premium.accent.light }}>
                  {mmss(entry.usedSec)}
                </span>
                <span style={{ width: 44, fontFamily: 'monospace', color: premium.text.muted }}>
                  {entry.uses.length}
                </span>
                <span style={{
                  width: 60, fontSize: 10,
                  color: entry.missing ? '#e07070' : entry.unused ? '#e0a050' : premium.text.muted,
                }}>
                  {entry.missing ? '없어짐' : entry.unused ? '안 씀' : '사용중'}
                </span>
              </button>
              {open === entry.fileId && (
                <div className="px-6 pb-2" style={{ fontSize: 10, color: premium.text.muted }}>
                  <div style={{ fontFamily: 'monospace', marginBottom: 3 }}>{entry.path}</div>
                  {entry.uses.length === 0 && <div>이 파일을 쓰는 클립이 없습니다.</div>}
                  {entry.uses.map((use) => (
                    <button
                      key={use.clipId}
                      className="block text-left"
                      style={{ color: use.active ? premium.accent.light : premium.text.muted }}
                      onClick={() => {
                        seek(use.startSec);
                        setSelection({ startSec: use.startSec, endSec: use.startSec, trackIds: [use.trackId] });
                      }}
                    >
                      {use.trackName} · {use.clipName} · {mmss(use.startSec)}
                      {use.active ? '' : ' (다른 테이크)'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="px-3 py-6 text-center" style={{ fontSize: 11, color: premium.text.muted }}>
              해당하는 파일이 없습니다.
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mt-3">
          <span style={{ fontSize: 11, color: premium.text.muted }}>
            {shown.length !== pool.length && `${shown.length} / ${pool.length}개 표시`}
          </span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 rounded text-sm"
              style={{
                background: '#2a2a36',
                color: summary.unused > 0 ? '#e0a050' : premium.text.muted,
              }}
              onClick={cleanUp}
              title="다른 테이크에서 쓰는 파일은 남깁니다"
              data-testid="pool-cleanup"
            >
              안 쓰는 파일 {summary.unused}개 제거
            </button>
            <button
              className="px-3 py-1.5 rounded text-sm"
              style={{ background: premium.accent.base, color: '#101018', fontWeight: 600 }}
              onClick={onClose}
            >닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
