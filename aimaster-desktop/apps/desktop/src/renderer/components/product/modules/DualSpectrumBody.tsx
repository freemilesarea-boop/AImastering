// DualSpectrumBody — stacked PRE / POST spectrum canvases.
//
// Renders two NativeSpectrumCanvas instances in a 50/50 vertical split.
// Top half = "PRE" (the source file's spectrum, via the secondary analyser).
// Bottom half = "POST" (whatever the primary element is playing).
//
// Both canvases read real AnalyserNodes — no fake data, no copies.  If the
// secondary analyser hasn't connected yet, the PRE half shows the same
// "음원을 불러오면…" hint as the standalone view.

import React from 'react';
import { surface, text, typography } from '../../../theme/loui-theme.js';
import { NativeSpectrumCanvas } from './NativeSpectrumCanvas.js';

export interface DualSpectrumBodyProps {
  preAnalyser: AnalyserNode | null;
  postAnalyser: AnalyserNode | null;
  preStatus?: 'idle' | 'connected' | 'error';
}

function Label({ text: label, color }: { text: string; color: string }) {
  return (
    <div style={{
      position: 'absolute', top: 6, left: 8,
      fontFamily: typography.family.mono, fontSize: 9, letterSpacing: '0.10em',
      color, pointerEvents: 'none',
      textShadow: '0 1px 2px rgba(0,0,0,0.5)',
    }}>
      {label}
    </div>
  );
}

export function DualSpectrumBody({ preAnalyser, postAnalyser, preStatus }: DualSpectrumBodyProps) {
  return (
    <div style={{
      position: 'relative', flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {/* PRE — source spectrum */}
      <div style={{
        position: 'relative', flex: 1, minHeight: 0,
        borderRadius: 10, overflow: 'hidden',
        background: surface.well,
      }}>
        <NativeSpectrumCanvas analyser={preAnalyser} color="rgba(96,165,250,0.85)" />
        <Label text="PRE · 원본" color="rgba(96,165,250,0.95)" />
        {!preAnalyser && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: text.muted, fontFamily: typography.family.sans, fontSize: typography.size.sm, pointerEvents: 'none',
          }}>
            {preStatus === 'error' ? '원본 분석기 오류' : '원본 로딩 중…'}
          </div>
        )}
      </div>
      {/* POST — what the user is hearing */}
      <div style={{
        position: 'relative', flex: 1, minHeight: 0,
        borderRadius: 10, overflow: 'hidden',
        background: surface.well,
      }}>
        <NativeSpectrumCanvas analyser={postAnalyser} color="rgba(167,139,250,0.85)" />
        <Label text="POST · 마스터" color="rgba(167,139,250,0.95)" />
      </div>
    </div>
  );
}
