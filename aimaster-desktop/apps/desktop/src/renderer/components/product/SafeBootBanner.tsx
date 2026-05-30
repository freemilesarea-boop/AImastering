// SafeBootBanner — surfaces SAFE_BOOT disabled-feature state at the top
// of ProductPage so the user knows what's currently off and can flip a
// flag + reload with one click.
//
// Hidden when every flag is on (= "fully restored").  Otherwise shows
// each disabled flag with an enable button.  Clicking it persists the
// new state and reloads the renderer immediately so the change applies.

import React from 'react';
import { isEnabled } from '../../audio/safe-boot-flags.js';

const FLAGS: { name: 'wasmAnalyzer' | 'realtimeMasteringGraph'; label: string; describe: string }[] = [
  {
    name: 'wasmAnalyzer',
    label: 'WASM Analyzer',
    describe: '정밀 LUFS / TP / 스펙트럼 (worklet + WASM 로드)',
  },
  {
    name: 'realtimeMasteringGraph',
    label: 'Realtime Mastering',
    describe: 'EQ · Dynamics · Imager · Limiter 실시간 미리듣기 (worklet)',
  },
];

export function SafeBootBanner() {
  const disabled = FLAGS.filter((f) => !isEnabled(f.name));
  if (disabled.length === 0) return null;

  const enable = (name: string) => {
    const w = window as unknown as {
      __SAFE_BOOT__?: { enable: (n: string) => void };
    };
    w.__SAFE_BOOT__?.enable(name);
    // Reload immediately so the new flag takes effect.
    setTimeout(() => window.location.reload(), 100);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      paddingInline: 16, paddingBlock: 6,
      background: 'rgba(245,158,11,0.10)',
      borderBottom: '1px solid rgba(245,158,11,0.30)',
      fontFamily: 'ui-monospace, "SF Mono", monospace',
      fontSize: 10, color: '#fbbf24',
      letterSpacing: '0.04em',
      flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 600 }}>SAFE BOOT</span>
      <span style={{ color: '#92400e' }}>· 비활성 기능:</span>
      {disabled.map((f) => (
        <button
          key={f.name}
          type="button"
          onClick={() => enable(f.name)}
          title={`${f.describe} — 활성화 후 새로고침`}
          style={{
            fontFamily: 'inherit', fontSize: 10,
            padding: '2px 8px', borderRadius: 4,
            border: '1px solid rgba(245,158,11,0.45)',
            background: 'rgba(245,158,11,0.18)',
            color: '#fbbf24', cursor: 'pointer',
          }}
        >
          {f.label} 켜기
        </button>
      ))}
      <span style={{ color: '#92400e', marginLeft: 'auto', fontSize: 9 }}>
        활성화 시 renderer가 죽으면 그 기능이 crash 원인입니다.
      </span>
    </div>
  );
}
