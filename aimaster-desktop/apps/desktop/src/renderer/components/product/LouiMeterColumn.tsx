// LouiMeterColumn — right-rail meter cluster.
//
// Vertical stack of the two production V2 meter panels:
//   • LoudnessMeterPanelV2 — momentary / short-term / integrated / TP
//   • StereoScopePanel     — correlation needle + categorical verdict
//
// Each panel is wrapped in a Loui-themed `MeterPanelShell` for visual
// consistency with the rest of the product layout (theme-token border,
// header typography, inner padding).

import React from 'react';
import { surface, text, typography, radius, space } from '../../theme/loui-theme.js';
import { LoudnessMeterPanelV2 } from '../LoudnessMeterPanelV2.js';
import { StereoScopePanel } from '../StereoScopePanel.js';
import { NativeLoudnessMeter, NativeStereoMeter, NativeLevelsMeter } from './modules/NativeMeterCards.js';
import { LouiLoudnessHistory } from './modules/LouiLoudnessHistory.js';
import { NativeBandMeter } from './modules/NativeBandMeter.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

export interface LouiMeterColumnProps {
  session?: AnalyzerSession | null;
  /** Optional target LUFS — colour-codes the integrated readout. */
  targetLufs?: number;
}

function PanelShell({
  title,
  subtitle,
  children,
  description,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
    }}>
      <div
        title={description}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['3'],
          borderBottom: `1px solid ${surface.border}`,
          cursor: description ? 'help' : 'default',
        }}
      >
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.md,
          fontWeight: typography.weight.semi,
          color: text.primary,
        }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ padding: space['3'] }}>
        {children}
      </div>
    </div>
  );
}

export function LouiMeterColumn(props: LouiMeterColumnProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: space['3'],
      minHeight: 0,
      height: '100%',
      overflowY: 'auto',
    }}>
      {/* Native meters are the always-on base (never an empty card).  The
          WASM BS.1770 panels render above them when a session has data. */}
      <PanelShell title="Loudness" subtitle="Momentary · Short · Integ · Peak"
        description="음량 미터. Momentary(순간)·Short-term(단기)·Integrated(평균) 음량과 Peak/True Peak를 dBFS로 표시합니다.">

        <NativeLoudnessMeter />
        <div style={{ marginTop: 10 }}
             title="단기(≈3초) 음량의 시간축 그래프. 점선은 타깃 LUFS — 곡 내내 타깃 근처에서 출렁이는 폭이 다이내믹입니다.">
          <LouiLoudnessHistory {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})} />
        </div>
        {props.session && (
          <div style={{ marginTop: 10 }}>
            <LoudnessMeterPanelV2
              session={props.session}
              tickRate="30Hz"
              {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})}
            />
          </div>
        )}
      </PanelShell>
      <PanelShell title="Stereo" subtitle="Correlation · M/S · Width"
        description="스테레오 미터. 좌/우 레벨, Mid/Side 비율, 좌우 폭(Width%), 위상 상관도(Φ: +1 모노~ -1 역상)를 표시합니다.">

        <NativeStereoMeter />
        {props.session && (
          <div style={{ marginTop: 10 }}>
            <StereoScopePanel session={props.session} />
          </div>
        )}
      </PanelShell>
      <PanelShell title="Levels" subtitle="RMS · Peak · Headroom · Clip"
        description="출력 레벨. 처리 후 출력 RMS, 좌/우 Peak(홀드), 남은 헤드룸(dB), 클리핑 여부를 표시합니다.">

        <NativeLevelsMeter />
      </PanelShell>
      <PanelShell title="Bands" subtitle="Sub · Low · Mid · High · Air"
        description="6밴드 RMS 미터. Sub(20-80Hz)부터 Air(12-20kHz)까지 각 대역의 실시간 출력 레벨을 표시합니다.">

        <NativeBandMeter />
      </PanelShell>
    </div>
  );
}
