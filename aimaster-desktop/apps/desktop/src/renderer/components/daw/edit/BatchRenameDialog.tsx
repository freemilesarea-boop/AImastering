// Batch rename — twelve names in one pass, previewed before any of them move.
//
// The rules live in daw/edit/batch-rename.ts and are pure; this is the window
// onto them.  The one design decision here is that the PREVIEW is the main
// content, not a footnote: the list of "from → to" is what the user reads to
// decide, and hiding it behind an Apply button turns a bulk rename into a
// gamble on twelve things at once.
//
// Names that would not change are drawn dimmed rather than hidden, so the
// count in the list matches the count that was selected — a preview that
// silently drops rows is how you end up wondering which four of your twelve
// tracks it missed.

import React, { useMemo, useState } from 'react';
import { useDawStore, type RenameTarget } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import { renameTrack } from '../../../daw/model/track-header.js';
import { renameClip } from '../../../daw/edit/clip-dsp.js';
import {
  DEFAULT_RENAME, describeRename, planRename, type RenameKind, type RenameOptions,
} from '../../../daw/edit/batch-rename.js';

const KIND_TABS: { kind: RenameKind; label: string }[] = [
  { kind: 'pattern', label: '번호 패턴' },
  { kind: 'replace', label: '찾아 바꾸기' },
  { kind: 'affix',   label: '앞뒤 붙이기' },
];

const field = {
  background: '#1d1d28', border: '1px solid #3a3a48', borderRadius: 4,
  padding: '4px 8px', fontSize: 12, color: premium.text.primary,
} as const;

export default function BatchRenameDialog({
  target, onClose,
}: { target: RenameTarget; onClose: () => void }) {
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const [options, setOptions] = useState<RenameOptions>({
    kind: 'pattern',
    pattern: target.kind === 'track' ? 'Track #' : 'Take #',
    ...DEFAULT_RENAME,
  });

  const set = <K extends keyof RenameOptions>(key: K, value: RenameOptions[K]): void =>
    setOptions((o) => ({ ...o, [key]: value }));

  const plan = useMemo(() => planRename(target.items, options), [target.items, options]);

  const run = (): void => {
    if (plan.changed === 0) { notify('바뀌는 이름이 없습니다', 'warning'); return; }
    const byId = new Map(target.items.map((i) => [i.id, i]));
    apply((s) => plan.lines.reduce((acc, line) => {
      if (line.same) return acc;
      const item = byId.get(line.id);
      if (!item) return acc;
      return target.kind === 'track'
        ? renameTrack(acc, line.id, line.to)
        : item.trackId ? renameClip(acc, item.trackId, line.id, line.to) : acc;
    }, s));
    notify(`${describeRename(plan)}`, 'success');
    onClose();
  };

  const what = target.kind === 'track' ? '트랙' : '클립';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-lg border p-5"
        style={{
          minWidth: 520, background: '#15151d', borderColor: '#3a3a48',
          fontFamily: premium.type.sans, color: premium.text.primary,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="batch-rename"
      >
        <h2 style={{ fontFamily: premium.type.display, fontSize: 17, marginBottom: 2 }}>
          이름 일괄 변경 — {what} {target.items.length}개
        </h2>
        <p style={{ fontSize: 11, color: premium.text.muted, marginBottom: 12 }}>
          번호는 <b>고른 순서</b>대로 1부터 붙습니다. <code>#</code> 개수가 자릿수예요 —
          <code>Gtr ##</code> 이면 <code>Gtr 01</code>.
        </p>

        <div className="flex gap-1 mb-3">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.kind}
              className="px-3 py-1 rounded text-xs"
              style={{
                background: options.kind === tab.kind ? premium.accent.base : '#2a2a36',
                color: options.kind === tab.kind ? '#101018' : premium.text.secondary,
                fontWeight: options.kind === tab.kind ? 600 : 400,
              }}
              onClick={() => set('kind', tab.kind)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {options.kind === 'pattern' && (
          <div className="flex items-center gap-2 mb-3">
            <input
              style={{ ...field, flex: 1 }} value={options.pattern ?? ''}
              onChange={(e) => set('pattern', e.target.value)}
              placeholder="Gtr ##"
              data-testid="rename-pattern"
            />
            <label style={{ fontSize: 11, color: premium.text.muted }}>시작</label>
            <input
              type="number" style={{ ...field, width: 64 }} value={options.start ?? 1}
              onChange={(e) => set('start', Number(e.target.value))}
            />
            <label style={{ fontSize: 11, color: premium.text.muted }}>증가</label>
            <input
              type="number" style={{ ...field, width: 64 }} value={options.step ?? 1}
              onChange={(e) => set('step', Number(e.target.value))}
            />
          </div>
        )}

        {options.kind === 'replace' && (
          <div className="flex items-center gap-2 mb-3">
            <input
              style={{ ...field, flex: 1 }} value={options.find ?? ''}
              onChange={(e) => set('find', e.target.value)}
              placeholder="찾을 글자"
              data-testid="rename-find"
            />
            <span style={{ color: premium.text.muted }}>→</span>
            <input
              style={{ ...field, flex: 1 }} value={options.replace ?? ''}
              onChange={(e) => set('replace', e.target.value)}
              placeholder="바꿀 글자 (비우면 삭제)"
              data-testid="rename-replace"
            />
            <label className="flex items-center gap-1" style={{ fontSize: 11, color: premium.text.muted }}>
              <input
                type="checkbox" checked={options.ignoreCase ?? false}
                onChange={(e) => set('ignoreCase', e.target.checked)}
              />
              대소문자 무시
            </label>
          </div>
        )}

        {options.kind === 'affix' && (
          <div className="flex items-center gap-2 mb-3">
            <input
              style={{ ...field, flex: 1 }} value={options.prefix ?? ''}
              onChange={(e) => set('prefix', e.target.value)}
              placeholder="앞에 붙일 글자"
            />
            <span style={{ fontSize: 11, color: premium.text.muted }}>기존 이름</span>
            <input
              style={{ ...field, flex: 1 }} value={options.suffix ?? ''}
              onChange={(e) => set('suffix', e.target.value)}
              placeholder="뒤에 붙일 글자"
            />
          </div>
        )}

        <div
          className="rounded mb-3 overflow-auto"
          style={{ background: '#1d1d28', maxHeight: 240 }}
          data-testid="rename-preview"
        >
          {plan.lines.map((line) => (
            <div
              key={line.id}
              className="flex items-center gap-2 px-3 py-1"
              style={{
                fontSize: 12,
                fontFamily: premium.type.mono ?? 'monospace',
                opacity: line.same ? 0.4 : 1,
              }}
            >
              <span style={{ flex: 1, color: premium.text.muted }}>{line.from}</span>
              <span style={{ color: premium.text.muted }}>→</span>
              <span
                style={{ flex: 1, color: plan.duplicates.includes(line.to) ? '#e0a050' : premium.accent.light }}
              >
                {line.to}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <span
            style={{ fontSize: 12, color: plan.duplicates.length > 0 ? '#e0a050' : premium.text.secondary }}
            data-testid="rename-summary"
          >
            {describeRename(plan)}
          </span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 rounded text-sm"
              style={{ background: '#2a2a36', color: premium.text.secondary }}
              onClick={onClose}
            >
              취소
            </button>
            <button
              className="px-4 py-1.5 rounded text-sm"
              style={{ background: premium.accent.base, color: '#101018', fontWeight: 600 }}
              onClick={run}
              data-testid="rename-apply"
            >
              적용
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
