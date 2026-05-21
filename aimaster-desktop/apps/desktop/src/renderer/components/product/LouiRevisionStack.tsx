// LouiRevisionStack — the version (revision) stack for one source file
// (M3-REVISION-WORKFLOW).
//
// Lets the user keep, compare, and export multiple mastering versions of
// the same upload: select active, play, save WAV / format, rename,
// favorite, delete, and "이 설정으로 편집" (load a revision's settings back
// into the editor), plus "새 버전 만들기" to render the current settings.
//
// Pure presentational — every action is a callback.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';
import { loui, louiAlpha } from '../../theme/loui-home.js';
import { formatMetrics, formatOptionsSummary } from '../../audio/revisions/revision-logic.js';
import type { MasteringRevision } from '../../audio/revisions/revision-types.js';

export interface LouiRevisionStackProps {
  revisions: MasteringRevision[];
  activeId: string;
  /** A new revision is currently rendering. */
  creating?: boolean;
  /** Error from the last create attempt. */
  createError?: string | null;
  /** Current edit settings duplicate an existing revision. */
  duplicateWarning?: boolean;
  /** Experimental Rust offline render backend is enabled. */
  experimental?: boolean;
  /** Resolve a preset id → display name (optional). */
  presetNameFor?: (presetId: string) => string;
  onSelect?: (id: string) => void;
  onSaveWav?: (id: string) => void;
  onSaveFormat?: (id: string) => void;
  onRename?: (id: string, label: string) => void;
  onDelete?: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onLoadSettings?: (id: string) => void;
  onCreateRevision?: () => void;
}

function fmtTime(ms: number): string {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function MiniBtn({ label, onClick, tone }: { label: string; onClick?: () => void; tone?: 'accent' | 'danger' }) {
  const color = tone === 'danger' ? meter.danger.foreground : tone === 'accent' ? loui.softLavender : text.tertiary;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className="no-drag"
      style={{
        fontFamily: typography.family.sans, fontSize: 11, fontWeight: typography.weight.medium,
        color, padding: '3px 8px', borderRadius: radius.chip,
        border: `1px solid ${surface.border}`, background: 'transparent', cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = surface.well; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

function RevisionCard({
  rev, active, canDelete, presetName, props,
}: {
  rev: MasteringRevision; active: boolean; canDelete: boolean;
  presetName?: string; props: LouiRevisionStackProps;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState(rev.label);
  const commit = () => { setRenaming(false); if (draft !== rev.label) props.onRename?.(rev.id, draft); };
  return (
    <div
      onClick={() => props.onSelect?.(rev.id)}
      style={{
        padding: space['3'], borderRadius: radius.panel, cursor: 'pointer',
        border: `1px solid ${active ? louiAlpha.lav(0.5) : surface.border}`,
        background: active ? `linear-gradient(160deg, ${louiAlpha.lav(0.10)}, ${surface.panel})` : surface.panel,
        boxShadow: active ? `0 0 16px -4px ${loui.glowLavender}` : 'none',
        transition: 'border-color 120ms, box-shadow 120ms',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
        <span style={{
          width: 7, height: 7, borderRadius: 999, flexShrink: 0,
          background: active ? loui.primaryLavender : surface.overlay,
          boxShadow: active ? `0 0 6px ${loui.primaryLavender}` : 'none',
        }} />
        {renaming ? (
          <input
            autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(rev.label); setRenaming(false); } }}
            className="no-drag"
            style={{
              flex: 1, background: surface.well, border: `1px solid ${surface.borderElevated}`,
              borderRadius: 6, color: text.primary, fontSize: typography.size.sm, padding: '2px 6px',
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(rev.label); setRenaming(true); }}
            style={{ flex: 1, fontFamily: typography.family.sans, fontSize: typography.size.sm, fontWeight: typography.weight.semi, color: active ? '#fff' : text.secondary }}
          >
            {rev.label}
            {active && <span style={{ marginLeft: 8, fontSize: 10, color: loui.softLavender }}>현재 버전</span>}
          </span>
        )}
        <button
          type="button"
          aria-label="favorite"
          onClick={(e) => { e.stopPropagation(); props.onToggleFavorite?.(rev.id); }}
          className="no-drag"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: rev.isFavorite ? loui.warningAmber : text.muted, fontSize: 13, lineHeight: 1 }}
        >
          {rev.isFavorite ? '★' : '☆'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.tertiary }}>
        <span style={{ color: text.secondary }}>{formatMetrics(rev.metrics)}</span>
        <span>· {fmtTime(rev.createdAt)}</span>
        {presetName && <span style={{ color: loui.softLavender }}>· {presetName}</span>}
      </div>
      <div style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>
        {formatOptionsSummary(rev.optionsSnapshot)}{rev.formatSummary ? ` · ${rev.formatSummary}` : ''}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        <MiniBtn label="WAV 저장" onClick={() => props.onSaveWav?.(rev.id)} />
        {props.onSaveFormat && <MiniBtn label="형식 저장" onClick={() => props.onSaveFormat?.(rev.id)} />}
        <MiniBtn label="이 설정으로 편집" tone="accent" onClick={() => props.onLoadSettings?.(rev.id)} />
        {canDelete && <MiniBtn label="삭제" tone="danger" onClick={() => props.onDelete?.(rev.id)} />}
      </div>
    </div>
  );
}

export function LouiRevisionStack(props: LouiRevisionStackProps) {
  const { revisions, activeId } = props;
  const canDelete = revisions.length > 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs, fontWeight: typography.weight.medium,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: loui.softLavender,
        }}>
          버전 · {revisions.length}
        </span>
        <button
          type="button"
          onClick={props.onCreateRevision}
          disabled={props.creating}
          className="no-drag"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: typography.family.sans, fontSize: 12, fontWeight: typography.weight.semi,
            color: props.creating ? loui.softLavender : '#0E0E14',
            background: props.creating ? surface.well : `linear-gradient(135deg, ${loui.activeViolet}, ${loui.primaryLavender})`,
            border: props.creating ? `1px solid ${louiAlpha.lav(0.3)}` : 'none',
            borderRadius: radius.chip, padding: '6px 12px', cursor: props.creating ? 'default' : 'pointer',
            boxShadow: props.creating ? 'none' : `0 4px 14px -6px ${loui.glowLavender}`,
          }}
        >
          {props.creating ? (
            <><span className="animate-spin" style={{ width: 11, height: 11, borderRadius: 999, border: `2px solid ${louiAlpha.lav(0.3)}`, borderTopColor: loui.primaryLavender, display: 'inline-block' }} />렌더 중…</>
          ) : '+ 새 버전 만들기'}
        </button>
      </div>

      {props.experimental && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
          <span style={{
            fontFamily: typography.family.sans, fontSize: 9, fontWeight: typography.weight.semi,
            letterSpacing: '0.06em', padding: '2px 5px', borderRadius: 4,
            color: loui.warningAmber, border: `1px solid ${loui.warningAmber}`,
          }}>
            EXPERIMENTAL
          </span>
          <span style={{ fontSize: 10, color: text.muted }}>Rust offline render (falls back to Python)</span>
        </div>
      )}
      {props.duplicateWarning && !props.creating && (
        <div style={{ fontSize: 11, color: loui.warningAmber }}>
          현재 설정과 동일한 버전이 이미 있습니다 — 그래도 새 버전을 만들 수 있습니다.
        </div>
      )}
      {props.createError && (
        <div style={{ fontSize: 11, color: meter.danger.foreground }}>새 버전 생성 실패: {props.createError}</div>
      )}

      {revisions.length === 0 ? (
        <div style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted, lineHeight: 1.5 }}>
          아직 마스터링 버전이 없습니다 — 원본을 들으며 설정을 조정한 뒤 “새 버전 만들기”로 결과를 확인하세요.
        </div>
      ) : revisions.map((rev) => (
        <RevisionCard
          key={rev.id}
          rev={rev}
          active={rev.id === activeId}
          canDelete={canDelete}
          {...(rev.presetId && props.presetNameFor ? { presetName: props.presetNameFor(rev.presetId) } : {})}
          props={props}
        />
      ))}
    </div>
  );
}
