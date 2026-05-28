// LouiCustomPresetSection — user-created preset list inside the preset
// slide-over.  Saves a snapshot of the current parameter state under a
// user-chosen name and lets the user reload it later (or delete it).
//
// All persistence lives in `custom-preset-storage.ts` (localStorage); this
// component is the thin UI on top.

import React from 'react';
import { surface, text, typography, space, radius, meter } from '../../theme/loui-theme.js';
import type { AllModulesParameterState } from '../../audio/parameters/parameter-state.js';
import {
  listCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
  sanitisePresetName,
  type CustomPreset,
} from '../../audio/presets/custom-preset-storage.js';

export interface LouiCustomPresetSectionProps {
  /** Current parameter state — captured verbatim when the user clicks save. */
  currentState: AllModulesParameterState;
  /** Called with the chosen preset's stored state.  Caller wires to replaceState. */
  onApply: (state: AllModulesParameterState, presetName: string) => void;
  /** Bumped each time the slide-over opens so the list refreshes. */
  refreshKey?: number;
}

function fmtDate(epoch: number): string {
  const d = new Date(epoch);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${m}월 ${day}일 ${hh}:${mm}`;
}

export function LouiCustomPresetSection(props: LouiCustomPresetSectionProps) {
  const [items, setItems] = React.useState<CustomPreset[]>(() => listCustomPresets());
  const [composing, setComposing] = React.useState(false);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Refresh from storage whenever the slide-over re-opens.
  React.useEffect(() => {
    setItems(listCustomPresets());
  }, [props.refreshKey]);

  // Auto-focus the input when the compose form opens.
  React.useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  const handleSave = () => {
    const clean = sanitisePresetName(name);
    if (!clean) { setError('이름을 입력해주세요.'); return; }
    const saved = saveCustomPreset(clean, props.currentState);
    if (!saved) { setError('저장에 실패했습니다.'); return; }
    setItems(listCustomPresets());
    setName('');
    setComposing(false);
    setError(null);
  };

  const handleDelete = (id: string) => {
    if (!deleteCustomPreset(id)) return;
    setItems(listCustomPresets());
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      padding: space['3'], borderRadius: radius.panel,
      background: surface.panel, border: `1px solid ${surface.border}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space['2'],
      }}>
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.sm,
          fontWeight: typography.weight.semi, color: text.primary,
          letterSpacing: '-0.005em',
        }}>
          내 프리셋
        </span>
        {!composing && (
          <button
            type="button"
            onClick={() => { setComposing(true); setError(null); }}
            style={{
              fontFamily: typography.family.sans, fontSize: typography.size.xs,
              fontWeight: typography.weight.medium,
              padding: '4px 10px', borderRadius: radius.chip,
              border: `1px solid ${meter.accent.foreground}`,
              background: 'rgba(167,139,250,0.10)', color: text.primary,
              cursor: 'pointer',
            }}
          >
            현재 설정 저장
          </button>
        )}
      </div>

      {composing && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: space['2'],
          padding: space['2'], borderRadius: radius.chip,
          background: surface.well, border: `1px solid ${surface.border}`,
        }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="프리셋 이름 (예: My KPOP Master)"
            value={name}
            maxLength={60}
            onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
              if (e.key === 'Escape') { e.preventDefault(); setComposing(false); setName(''); setError(null); }
            }}
            style={{
              fontFamily: typography.family.sans, fontSize: typography.size.sm,
              padding: '6px 10px', borderRadius: radius.chip,
              border: `1px solid ${surface.border}`, background: surface.background,
              color: text.primary, outline: 'none',
            }}
          />
          {error && (
            <span style={{ fontSize: typography.size.xs, color: meter.warn.foreground }}>{error}</span>
          )}
          <div style={{ display: 'flex', gap: space['2'], justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => { setComposing(false); setName(''); setError(null); }}
              style={{
                fontFamily: typography.family.sans, fontSize: typography.size.xs,
                padding: '4px 10px', borderRadius: radius.chip,
                border: `1px solid ${surface.border}`,
                background: 'transparent', color: text.secondary,
                cursor: 'pointer',
              }}
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={{
                fontFamily: typography.family.sans, fontSize: typography.size.xs,
                fontWeight: typography.weight.semi,
                padding: '4px 12px', borderRadius: radius.chip,
                border: `1px solid ${meter.accent.foreground}`,
                background: 'rgba(167,139,250,0.18)', color: text.primary,
                cursor: 'pointer',
              }}
            >
              저장
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && !composing && (
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: text.muted,
        }}>
          저장된 프리셋이 없습니다. 현재 설정을 저장해 다음에 다시 불러올 수 있습니다.
        </span>
      )}

      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it) => (
            <div
              key={it.id}
              style={{
                display: 'flex', alignItems: 'center', gap: space['2'],
                padding: '6px 10px',
                borderRadius: radius.chip,
                background: surface.well,
                border: `1px solid ${surface.border}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={{
                  fontFamily: typography.family.sans, fontSize: typography.size.sm,
                  fontWeight: typography.weight.medium, color: text.primary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {it.name}
                </span>
                <span style={{
                  fontFamily: typography.family.mono, fontSize: 10, color: text.muted,
                }}>
                  {fmtDate(it.createdAt)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => props.onApply(it.state, it.name)}
                style={{
                  fontFamily: typography.family.sans, fontSize: typography.size.xs,
                  padding: '4px 10px', borderRadius: radius.chip,
                  border: `1px solid ${meter.accent.foreground}`,
                  background: 'rgba(167,139,250,0.10)', color: text.primary,
                  cursor: 'pointer',
                }}
              >
                불러오기
              </button>
              <button
                type="button"
                onClick={() => handleDelete(it.id)}
                aria-label={`${it.name} 삭제`}
                title="삭제"
                style={{
                  fontFamily: typography.family.sans, fontSize: typography.size.xs,
                  width: 26, height: 26, borderRadius: radius.chip,
                  border: `1px solid ${surface.border}`,
                  background: 'transparent', color: text.tertiary,
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                  <path d="M3 4h10M6 4V2.5a1 1 0 011-1h2a1 1 0 011 1V4M4 4l1 9.5a1 1 0 001 .9h4a1 1 0 001-.9L12 4" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
