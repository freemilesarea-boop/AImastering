// LouiSnapshotSlots — 1~8 numbered slots for fast parameter snapshots.
//
// Volatile (in-memory) snapshot store for quick A/B/C... comparisons.
// Capture current parameter state into a slot with Shift+1..8, recall
// the snapshot with 1..8.  Cleared on page navigation away — these are
// throwaway compare buffers, NOT durable presets (use Custom Presets
// for those, with a name + localStorage persistence).
//
// Visual: a row of 8 chips.  Filled chips can be recalled or cleared.

import React from 'react';
import { surface, text, typography, radius, meter } from '../../../theme/loui-theme.js';
import type { AllModulesParameterState } from '../../../audio/parameters/parameter-state.js';

export interface SnapshotSlot {
  state: AllModulesParameterState;
  presetId: string | undefined;
  capturedAt: number;
}

export type SnapshotSlots = (SnapshotSlot | null)[]; // length-8

export const SNAPSHOT_COUNT = 8;

export function emptySnapshots(): SnapshotSlots {
  return Array.from({ length: SNAPSHOT_COUNT }, () => null);
}

function fmtTime(epoch: number): string {
  const ms = Date.now() - epoch;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

export interface LouiSnapshotSlotsProps {
  slots: SnapshotSlots;
  /** Slot the user most recently recalled — highlighted distinctly. */
  activeSlot: number | null;
  onSave: (idx: number) => void;
  onRecall: (idx: number) => void;
  onClear: (idx: number) => void;
}

export function LouiSnapshotSlots(props: LouiSnapshotSlotsProps) {
  return (
    <div
      title="스냅샷 슬롯 1~8: Shift+숫자=저장, 숫자=불러오기. 페이지를 떠나면 사라지는 빠른 비교 버퍼입니다."
      style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
    >
      <span style={{
        fontFamily: typography.family.mono, fontSize: 9, color: text.muted,
        letterSpacing: '0.06em', marginRight: 2,
      }}>SNAP</span>
      {props.slots.map((slot, i) => {
        const filled = slot !== null;
        const isActive = filled && props.activeSlot === i;
        return (
          <div
            key={i}
            style={{ position: 'relative', display: 'inline-flex' }}
            onContextMenu={(e) => {
              if (!filled) return;
              e.preventDefault();
              props.onClear(i);
            }}
          >
            <button
              type="button"
              onClick={() => (filled ? props.onRecall(i) : props.onSave(i))}
              title={filled
                ? `슬롯 ${i + 1} — ${fmtTime(slot!.capturedAt)} 전 저장됨. 클릭=불러오기, 우클릭=삭제, Shift+${i + 1}=덮어쓰기`
                : `슬롯 ${i + 1} 비어있음. 클릭=현재 상태 저장 (Shift+${i + 1}과 동일)`}
              style={{
                width: 22, height: 22, lineHeight: '20px',
                fontFamily: typography.family.mono, fontSize: 10, fontWeight: 600,
                borderRadius: radius.chip,
                border: `1px solid ${isActive ? meter.warn.foreground : (filled ? surface.border : surface.border)}`,
                background: isActive
                  ? meter.warn.background
                  : (filled ? surface.well : 'transparent'),
                color: isActive ? meter.warn.foreground : (filled ? text.primary : text.muted),
                cursor: 'pointer',
                padding: 0,
                textAlign: 'center',
                transition: 'background 120ms, color 120ms, border-color 120ms',
              }}
            >
              {i + 1}
            </button>
          </div>
        );
      })}
    </div>
  );
}
