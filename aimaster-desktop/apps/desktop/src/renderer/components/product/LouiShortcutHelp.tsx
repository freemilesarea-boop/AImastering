// LouiShortcutHelp — "?" key overlay listing all keyboard shortcuts.
//
// Full-screen semi-transparent backdrop with a centered card.
// Closes on: Escape, second "?", or click outside the card.

import React, { useEffect } from 'react';
import { surface, text, typography, radius, space } from '../../theme/loui-theme.js';

// Modifier key label — Cmd on macOS, Ctrl elsewhere.
const MOD = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'
  ? '⌘'
  : 'Ctrl';

interface ShortcutRow {
  keys: string[];
  desc: string;
}

const GROUPS: { title: string; rows: ShortcutRow[] }[] = [
  {
    title: '재생',
    rows: [
      { keys: ['Space'], desc: '재생 / 일시정지' },
      { keys: ['Shift', 'drag'], desc: '루프 구간 설정 (파형 위)' },
      { keys: ['L'], desc: '루프 on/off 토글' },
    ],
  },
  {
    title: 'A/B 비교',
    rows: [
      { keys: ['B'], desc: 'Before / After 전환' },
      { keys: ['PRE/POST'], desc: '스펙트럼 헤더의 PRE/POST 버튼 — 듀얼 스펙트럼 표시' },
    ],
  },
  {
    title: 'Free EQ (실시간 들림)',
    rows: [
      { keys: ['FREE EQ'], desc: '헤더 토글 — 자유 파라메트릭 EQ 활성화 (실시간 프리뷰 반영)' },
      { keys: ['click'], desc: '빈 곳 클릭 → 새 밴드 추가' },
      { keys: ['drag'], desc: '노드 드래그 → 주파수 / 게인' },
      { keys: ['Shift', 'drag'], desc: '노드 → Q 조절' },
      { keys: ['wheel'], desc: '노드 위 휠 → Q 조절' },
      { keys: ['dbl'], desc: '더블클릭 → 필터 타입 순환' },
      { keys: ['R-click'], desc: '우클릭 → 밴드 삭제' },
    ],
  },
  {
    title: '편집',
    rows: [
      { keys: [MOD, 'Z'], desc: '실행 취소 (Undo)' },
      { keys: [MOD, 'Shift', 'Z'], desc: '다시 실행 (Redo) — Mac' },
      { keys: [MOD, 'Y'], desc: '다시 실행 (Redo) — Win' },
    ],
  },
  {
    title: '세션 / 파일',
    rows: [
      { keys: [MOD, 'S'], desc: '세션 저장 (.louisession)' },
      { keys: [MOD, 'O'], desc: '세션 불러오기' },
      { keys: [MOD, 'E'], desc: '마스터 WAV 내보내기' },
    ],
  },
  {
    title: '스냅샷 (1~8)',
    rows: [
      { keys: ['1', '~', '8'], desc: '슬롯 N 불러오기 (빠른 A/B/C 비교)' },
      { keys: ['Shift', '1', '~', '8'], desc: '현재 파라미터를 슬롯 N에 저장' },
    ],
  },
  {
    title: '기타',
    rows: [
      { keys: ['?'], desc: '단축키 도움말 열기 / 닫기' },
      { keys: ['Esc'], desc: '도움말 닫기' },
    ],
  },
];

function KeyChip({ label }: { label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 24,
      padding: '2px 7px',
      borderRadius: 5,
      border: `1px solid ${surface.border}`,
      background: surface.well,
      fontFamily: typography.family.mono,
      fontSize: 11,
      color: text.secondary,
      letterSpacing: '0.03em',
      lineHeight: 1.6,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

export function LouiShortcutHelp({ onClose }: { onClose: () => void }) {
  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
      }}
    >
      {/* Card — click inside doesn't close */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: surface.panel,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.panel,
          padding: `${space['5']} ${space['6']}`,
          maxWidth: 440,
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: space['4'],
        }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.lg,
            fontWeight: typography.weight.semi,
            color: text.primary,
          }}>
            키보드 단축키
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            style={{
              background: 'none',
              border: 'none',
              color: text.muted,
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Groups */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space['4'] }}>
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div style={{
                fontFamily: typography.family.sans,
                fontSize: typography.size.xs,
                fontWeight: typography.weight.semi,
                color: text.muted,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                marginBottom: space['2'],
              }}>
                {group.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {group.rows.map((row) => (
                  <div key={row.desc} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: space['3'],
                  }}>
                    <span style={{
                      fontFamily: typography.family.sans,
                      fontSize: typography.size.sm,
                      color: text.secondary,
                      flex: 1,
                    }}>
                      {row.desc}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {row.keys.map((k, i) => (
                        <React.Fragment key={k}>
                          {i > 0 && (
                            <span style={{
                              fontFamily: typography.family.mono,
                              fontSize: 10,
                              color: text.muted,
                            }}>+</span>
                          )}
                          <KeyChip label={k} />
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: space['4'],
          paddingTop: space['3'],
          borderTop: `1px solid ${surface.border}`,
          fontFamily: typography.family.mono,
          fontSize: 10,
          color: text.muted,
          textAlign: 'center',
        }}>
          ESC 또는 바깥 클릭으로 닫기
        </div>
      </div>
    </div>
  );
}
