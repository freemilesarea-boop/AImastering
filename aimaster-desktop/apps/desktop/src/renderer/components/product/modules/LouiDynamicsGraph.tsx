// LouiDynamicsGraph — see what the compressor is doing, at a glance.
//
// "Threshold −5 dB, ratio 8.3:1, attack 71 ms" is a specification, not a
// picture. Every hardware-modelled compressor puts two things on its panel
// instead: a transfer curve — input level in, output level out, with the
// bend at the threshold — and a gain-reduction meter showing how hard it is
// working right now. This is both.
//
// The curve is drawn from `dynamics-graph-model`, which mirrors the gain
// computers in the Rust modules. The meter is live from the audio thread.
//
// The one honest limitation, stated in the panel rather than hidden: the
// curve is the STEADY STATE. Attack and release decide how long the audio
// takes to arrive at it, and no static plot shows that — which is exactly
// why the live marker matters. It sits at the level the chain is actually
// reducing right now, so a slow attack shows up as a marker that lags the
// music instead of a number that does not move.

import React, { useMemo } from 'react';
import {
  type DynamicsCurve,
  type DynamicsGraphSpec,
  outputDbFor,
  inputDbForReduction,
  DYN_MIN_DB,
  DYN_MAX_DB,
} from '../../../audio/modules/dynamics-graph-model.js';
import { surface, text, typography, space, radius, meter } from '../../../theme/loui-theme.js';

export interface LouiDynamicsGraphProps {
  spec: DynamicsGraphSpec;
  /** Live gain reduction per curve, in dB (positive = reducing). */
  reductionDb: readonly number[];
  /** True when the preview is running — an idle meter must not read as 0 dB. */
  live: boolean;
  disabled?: boolean;
  /**
   * Write a working starting point.
   *
   * Offered rather than applied: the neutral defaults are what keep the
   * module bit-transparent until asked, and silently moving parameters
   * when somebody flips a toggle is how a session ends up sounding
   * different for reasons nobody can point at.
   */
  onSetUp?: (() => void) | undefined;
}

const SIZE = 176;
const PAD = 24;
const GRID = [-60, -48, -36, -24, -12, 0];
/** Ruler ticks.  Every 20 dB — enough to place the threshold, few enough
 *  to stay legible in a cell this size. */
const LABELLED_DB = [-60, -40, -20, 0];
/** Full scale of the reduction meter, in dB. */
const METER_MAX_DB = 20;

function toX(db: number): number {
  return PAD + ((db - DYN_MIN_DB) / (DYN_MAX_DB - DYN_MIN_DB)) * (SIZE - PAD * 2);
}
function toY(db: number): number {
  return SIZE - PAD - ((db - DYN_MIN_DB) / (DYN_MAX_DB - DYN_MIN_DB)) * (SIZE - PAD * 2);
}

function curvePath(curve: DynamicsCurve): string {
  const steps = 120;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const inDb = DYN_MIN_DB + (i / steps) * (DYN_MAX_DB - DYN_MIN_DB);
    const outDb = Math.max(DYN_MIN_DB, Math.min(DYN_MAX_DB, outputDbFor(curve, inDb)));
    d += `${i === 0 ? 'M' : 'L'}${toX(inDb).toFixed(1)},${toY(outDb).toFixed(1)}`;
  }
  return d;
}

/** One compressor: its curve, its meter, its numbers. */
function CurveCell(props: {
  label: string;
  curve: DynamicsCurve;
  reductionDb: number;
  live: boolean;
}) {
  const { curve, reductionDb, live } = props;
  const path = useMemo(() => curvePath(curve), [curve]);
  const markerIn = live ? inputDbForReduction(curve, reductionDb) : null;
  const working = curve.ratio > 1.001;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      padding: space['3'],
      background: surface.well,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space['2'] }}>
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: text.secondary, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          {props.label}
        </span>
        <span style={{
          fontFamily: typography.family.mono, fontSize: typography.size.xs,
          color: working ? text.tertiary : text.disabled, fontVariantNumeric: 'tabular-nums',
        }}>
          {working ? `${curve.ratio.toFixed(1)}:1` : 'off'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: space['3'] }}>
        <svg width={SIZE} height={SIZE} style={{ flexShrink: 0 }}>
          {GRID.map((db) => (
            <g key={db}>
              <line
                x1={toX(db)} x2={toX(db)} y1={PAD} y2={SIZE - PAD}
                stroke={db === LABELLED_DB[1] ? 'rgba(var(--loui-onsurface-rgb, 255,255,255), 0.09)' : 'rgba(var(--loui-onsurface-rgb, 255,255,255), 0.05)'}
                strokeWidth={1}
              />
              <line
                x1={PAD} x2={SIZE - PAD} y1={toY(db)} y2={toY(db)}
                stroke="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.05)" strokeWidth={1}
              />
            </g>
          ))}
          {/* Both rulers.  Without them the curve has a shape but no scale,
              and "how loud does it start working" is unanswerable. */}
          {LABELLED_DB.map((db) => (
            <g key={`lab${db}`}>
              <text
                x={toX(db)} y={SIZE - PAD + 9}
                textAnchor={db === DYN_MIN_DB ? 'start' : db === DYN_MAX_DB ? 'end' : 'middle'}
                fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.32)"
                style={{ fontFamily: typography.family.mono, fontSize: 7 }}
              >
                {db}
              </text>
              <text
                x={PAD - 3} y={toY(db) + 2} textAnchor="end"
                fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.32)"
                style={{ fontFamily: typography.family.mono, fontSize: 7 }}
              >
                {db}
              </text>
            </g>
          ))}
          {/* Unity — where the curve would sit doing nothing.  Without it a
              gentle ratio looks like a straight line either way. */}
          <line
            x1={toX(DYN_MIN_DB)} y1={toY(DYN_MIN_DB)} x2={toX(DYN_MAX_DB)} y2={toY(DYN_MAX_DB)}
            stroke="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.16)" strokeWidth={1} strokeDasharray="3 3"
          />
          {/* Threshold */}
          {working && (
            <line
              x1={toX(curve.thresholdDb)} x2={toX(curve.thresholdDb)} y1={PAD} y2={SIZE - PAD}
              stroke="rgba(251,191,36,0.45)" strokeWidth={1}
            />
          )}
          <path d={path} fill="none" stroke="var(--loui-meter-accent, #A78BFA)" strokeWidth={2} strokeLinejoin="round" />
          {/* Live operating point */}
          {markerIn !== null && (
            <circle
              cx={toX(markerIn)}
              cy={toY(Math.max(DYN_MIN_DB, Math.min(DYN_MAX_DB, outputDbFor(curve, markerIn))))}
              r={4} fill={meter.accent.foreground} stroke="rgba(var(--loui-surface-rgb, 10,10,14), 0.85)" strokeWidth={1.5}
            />
          )}
          <text
            x={SIZE - PAD} y={11} textAnchor="end"
            fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.24)"
            style={{ fontFamily: typography.family.mono, fontSize: 7 }}
          >
            out ↑ / in → dBFS
          </text>
        </svg>

        {/* Gain-reduction meter — downward, the way every compressor draws it. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space['1'] }}>
          <div style={{
            position: 'relative',
            width: 10, height: SIZE - 28,
            background: surface.panel,
            border: `1px solid ${surface.border}`,
            borderRadius: radius.bar,
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0,
              height: `${Math.min(100, (Math.max(0, reductionDb) / METER_MAX_DB) * 100)}%`,
              background: reductionDb > 12 ? meter.warn.foreground : meter.accent.foreground,
              transition: 'height 80ms linear',
            }} />
          </div>
          <span style={{
            fontFamily: typography.family.mono, fontSize: 9,
            color: live && reductionDb > 0.05 ? text.secondary : text.disabled,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {live ? `−${Math.max(0, reductionDb).toFixed(1)}` : '—'}
          </span>
          <span style={{ fontFamily: typography.family.mono, fontSize: 8, color: text.muted }}>GR</span>
        </div>
      </div>

      <span style={{
        fontFamily: typography.family.mono, fontSize: typography.size.xs,
        color: text.muted, fontVariantNumeric: 'tabular-nums',
      }}>
        {`th ${curve.thresholdDb.toFixed(1)} dB`}
        {curve.makeupDb !== 0 && ` · mk ${curve.makeupDb >= 0 ? '+' : ''}${curve.makeupDb.toFixed(1)}`}
        {curve.mixPct < 100 && ` · mix ${curve.mixPct.toFixed(0)}%`}
        {curve.mode === 'expand' && ' · expand'}
      </span>
    </div>
  );
}

export function LouiDynamicsGraph(props: LouiDynamicsGraphProps) {
  const { spec, reductionDb, live, disabled } = props;
  // A compressor at 1:1 is a straight wire. Switching the module on and
  // hearing nothing reads as a broken module rather than as a neutral one,
  // and the reason is four graphs down the page where the ratio lives —
  // so it gets said here, where the "off" is.
  const idle = spec.curves.every((c) => c.curve.ratio <= 1.001);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'], opacity: disabled ? 0.45 : 1 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${SIZE + 70}px, 1fr))`,
        gap: space['2'],
      }}>
        {spec.curves.map((c, i) => (
          <CurveCell
            key={c.label}
            label={c.label}
            curve={c.curve}
            reductionDb={reductionDb[i] ?? 0}
            live={live}
          />
        ))}
      </div>

      {idle && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: space['3'], flexWrap: 'wrap',
          paddingInline: space['3'], paddingBlock: space['2'],
          background: surface.well,
          border: `1px solid ${meter.warn.foreground}44`,
          borderRadius: radius.panel,
        }}>
          <span style={{
            fontFamily: typography.family.sans, fontSize: typography.size.xs,
            color: text.secondary, lineHeight: 1.6, flex: 1, minWidth: 220,
          }}>
            <strong style={{ color: meter.warn.foreground }}>지금은 아무 일도 하지 않습니다.</strong>
            {' '}
            {spec.curves.length > 1
              ? '모든 밴드의 Ratio가 1:1이라 소리가 그대로 지나갑니다.'
              : 'Ratio가 1:1이라 소리가 그대로 지나갑니다.'}
            {' '}Ratio를 올리고 Threshold를 신호가 닿는 높이까지 내리면 그때부터 눌리기 시작합니다.
            <span style={{ color: text.muted }}>
              {' '}(Ratio 1:1 = 압축 없음. 모듈을 켜도 이 값이면 바뀌는 게 없는 것이 정상입니다.)
            </span>
          </span>
          {props.onSetUp && !disabled && (
            <button
              type="button"
              onClick={props.onSetUp}
              className="no-drag"
              style={{
                appearance: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                paddingInline: space['3'], paddingBlock: 5,
                borderRadius: radius.chip,
                border: `1px solid ${meter.warn.foreground}77`,
                background: `${meter.warn.foreground}18`,
                color: meter.warn.foreground,
                fontFamily: typography.family.sans, fontSize: typography.size.xs,
              }}
            >
              기본값으로 시작하기
            </button>
          )}
        </div>
      )}

      <span style={{
        fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted,
      }}>
        곡선은 정상 상태입니다 — 어택·릴리스는 이 곡선에 도달하는 속도를 정하며, 그건 점(현재 동작점)이 보여줍니다.
      </span>
    </div>
  );
}
