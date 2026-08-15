// LouiToneDynamicsViews — displays for the rest of the chain.
//
// Same contract as the restoration views: draw what the engine reports,
// and when it reports nothing, say so. Three shapes recur here, so they
// are built once and shared:
//
//   • a curve on the frequency ruler   (Stabilizer, Dynamic EQ, Low End Focus)
//   • per-band bars with a live figure (Impact)
//   • gain reduction over time         (Limiter, Maximizer)
//
// The time display is the one that needed a decision. A limiter's whole
// character is in how its reduction moves — a number that says "−4.1 dB"
// tells you nothing about whether it is breathing or clamped. So it keeps
// a rolling history, like every mastering limiter's meter does.

import React, { useMemo } from 'react';
import {
  AXIS_PAD as PAD,
  AXIS_MAJOR_HZ,
  AXIS_MINOR_HZ,
  AXIS_MIN_HZ,
  AXIS_MAX_HZ,
  hzToX,
  fmtAxisHz,
  fmtHz,
  logBandHz,
} from './spectrum-axis.js';
import type { ParameterValue } from '../../../audio/parameters/index.js';
import type { RealtimePreviewMetrics } from '../../../audio/realtime-preview-store.js';
import { surface, text, typography, space, radius, meter } from '../../../theme/loui-theme.js';

const HEIGHT = 190;

function num(v: Record<string, ParameterValue>, id: string, fallback: number): number {
  const x = v[id];
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}
function str(v: Record<string, ParameterValue>, id: string, fallback: string): string {
  const x = v[id];
  return typeof x === 'string' ? x : fallback;
}
function boolOf(v: Record<string, ParameterValue>, id: string, fallback: boolean): boolean {
  const x = v[id];
  return typeof x === 'boolean' ? x : fallback;
}

// ── Frames ───────────────────────────────────────────────────────────────

function Caption(props: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: typography.family.sans, fontSize: typography.size.xs,
      color: text.muted, lineHeight: 1.6,
    }}>
      {props.children}
    </span>
  );
}

function Panel(props: { children: React.ReactNode; disabled?: boolean | undefined }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      opacity: props.disabled ? 0.45 : 1,
    }}>
      {props.children}
    </div>
  );
}

/** A plot on the shared frequency ruler. */
function FreqFrame(props: {
  width: number;
  minDb: number;
  maxDb: number;
  dbTicks: number[];
  children: (yFor: (db: number) => number) => React.ReactNode;
}) {
  const { width, minDb, maxDb } = props;
  const yFor = (db: number): number => {
    const t = (maxDb - Math.max(minDb, Math.min(maxDb, db))) / (maxDb - minDb);
    return PAD.top + t * (HEIGHT - PAD.top - PAD.bottom);
  };
  return (
    <div style={{
      width: '100%', height: HEIGHT,
      background: surface.well, border: `1px solid ${surface.border}`,
      borderRadius: radius.panel, overflow: 'hidden',
    }}>
      <svg width={width} height={HEIGHT} style={{ display: 'block' }}>
        {AXIS_MINOR_HZ.map((hz) => (
          <line key={`m${hz}`} x1={hzToX(hz, width)} x2={hzToX(hz, width)}
            y1={PAD.top} y2={HEIGHT - PAD.bottom}
            stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        ))}
        {AXIS_MAJOR_HZ.map((hz) => {
          const x = hzToX(hz, width);
          const anchor = hz === AXIS_MIN_HZ ? 'start' : hz === AXIS_MAX_HZ ? 'end' : 'middle';
          return (
            <g key={hz}>
              <line x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom}
                stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
              <text x={x} y={HEIGHT - 6} textAnchor={anchor}
                fill="rgba(255,255,255,0.38)"
                style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
                {fmtAxisHz(hz)}
              </text>
            </g>
          );
        })}
        {props.dbTicks.map((db) => (
          <g key={db}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yFor(db)} y2={yFor(db)}
              stroke={db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'} strokeWidth={1} />
            <text x={width - PAD.right + 4} y={yFor(db) + 3}
              fill="rgba(255,255,255,0.32)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        {props.children(yFor)}
      </svg>
    </div>
  );
}

// ── Rolling history ──────────────────────────────────────────────────────

const HISTORY_LEN = 200;

/**
 * A fixed-length ring of the last reading.
 *
 * Kept in a ref and appended in an effect keyed on the store's tick, so a
 * history that is twenty seconds long costs one array and no re-render
 * beyond the one the metrics already caused.
 */
function useHistory(value: number, tick: number): number[] {
  const ref = React.useRef<number[]>([]);
  React.useEffect(() => {
    const h = ref.current;
    h.push(value);
    if (h.length > HISTORY_LEN) h.shift();
  }, [value, tick]);
  return ref.current;
}

// ── 1. Stabilizer ────────────────────────────────────────────────────────

/**
 * The measured tonal curve against the tilt it is being pulled towards.
 *
 * A tilt target is a straight line on a log axis — that is what makes it a
 * tilt — so the target is drawn as one, anchored at 1 kHz. Both curves are
 * shown relative to their own mean, because a loudness difference is not a
 * tonal one and drawing it as though it were would send the user chasing
 * an imaginary imbalance.
 */
export function StabilizerView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const tilt = num(props.values, 'tiltDbPerOct', -1.5);
  const amount = num(props.values, 'amountPct', 40);
  const maxMove = num(props.values, 'maxMoveDb', 3);
  const source = props.metrics.tonalCurveDb;
  const has = source.length > 4 && source.some((x) => x > -139);

  const centred = useMemo(() => {
    if (!has) return [];
    const m = source.reduce((a, b) => a + b, 0) / source.length;
    return source.map((x) => x - m);
  }, [source, has]);

  // The target, as dB per octave from 1 kHz, then centred the same way.
  const target = useMemo(() => {
    const n = 32;
    const raw = Array.from({ length: n }, (_, i) => Math.log2(logBandHz(i, n) / 1000) * tilt);
    const m = raw.reduce((a, b) => a + b, 0) / n;
    return raw.map((x) => x - m);
  }, [tilt]);

  const pathOf = (vals: readonly number[], yFor: (db: number) => number): string =>
    vals.map((v, i) => {
      const x = hzToX(logBandHz(i, vals.length), props.width);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yFor(v).toFixed(1)}`;
    }).join('');

  return (
    <Panel disabled={props.disabled}>
      <FreqFrame width={props.width} minDb={-15} maxDb={15} dbTicks={[-12, -6, 0, 6, 12]}>
        {(yFor) => (
          <>
            <path d={pathOf(target, yFor)} fill="none" stroke="#38BDF8" strokeWidth={1.6} strokeDasharray="5 3" />
            {has ? (
              <path d={pathOf(centred, yFor)} fill="none" stroke="#A78BFA" strokeWidth={1.8} />
            ) : (
              <text x={props.width / 2} y={HEIGHT / 2} textAnchor="middle"
                fill="rgba(255,255,255,0.30)"
                style={{ fontFamily: typography.family.sans, fontSize: 11 }}>
                측정 없음 — 이 모듈을 켜면 커브가 채워집니다
              </text>
            )}
          </>
        )}
      </FreqFrame>
      <Caption>
        {`파랑 점선 = 목표 기울기 ${tilt.toFixed(2)} dB/oct (1 kHz 기준), 보라 = 측정된 내 곡. `}
        {`둘 다 자기 평균을 뺀 상대 곡선입니다 · 적용 ${amount.toFixed(0)}% · 밴드당 최대 ${maxMove.toFixed(1)} dB`}
      </Caption>
    </Panel>
  );
}

// ── 2. Dynamic EQ ────────────────────────────────────────────────────────

const DYN_EQ_BANDS = 6;
const BAND_COLORS = ['#60A5FA', '#FBBF24', '#A78BFA', '#22D3EE', '#34D399', '#F87171'];

/**
 * Six bands on the ruler, each drawn at the gain it is applying RIGHT NOW.
 *
 * A dynamic EQ's static settings are not its curve — the whole point is
 * that the curve moves with the signal. So the shape drawn is the band's
 * filter at the engine's reported live gain, and the faint outline behind
 * it is the full range that band may travel. When the preview is stopped
 * there is no live gain, and the bands are drawn as outlines only.
 */
export function DynamicEqView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const live = props.metrics.running && !props.metrics.bypass;
  const gains = props.metrics.dynamicEqGainsDb;

  const bands = useMemo(() => Array.from({ length: DYN_EQ_BANDS }, (_, i) => {
    const p = `band${i}`;
    return {
      index: i,
      enabled: boolOf(v, `${p}Enabled`, false),
      shape: str(v, `${p}Shape`, 'bell'),
      mode: str(v, `${p}Mode`, 'down'),
      hz: num(v, `${p}FrequencyHz`, 1000),
      q: num(v, `${p}Q`, 1),
      rangeDb: num(v, `${p}RangeDb`, 6),
      thresholdDb: num(v, `${p}ThresholdDb`, -20),
      liveDb: gains[i] ?? 0,
    };
  }), [v, gains]);

  const active = bands.filter((b) => b.enabled);

  /** Bell/shelf magnitude, matching the engine's filter shapes. */
  const shapeDbAt = (b: (typeof bands)[number], hz: number, gainDb: number): number => {
    if (Math.abs(gainDb) < 1e-6) return 0;
    const w = hz / Math.max(1, b.hz);
    if (b.shape === 'lowShelf') return gainDb / (1 + Math.pow(w, 2));
    if (b.shape === 'highShelf') return gainDb - gainDb / (1 + Math.pow(w, 2));
    const bw = (w - 1 / w) * Math.max(0.1, b.q);
    return gainDb / (1 + bw * bw);
  };

  const curveFor = (b: (typeof bands)[number], gainDb: number, yFor: (db: number) => number): string => {
    const pts = 240;
    let d = '';
    for (let i = 0; i <= pts; i++) {
      const hz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, i / pts);
      d += `${i === 0 ? 'M' : 'L'}${hzToX(hz, props.width).toFixed(1)},${yFor(shapeDbAt(b, hz, gainDb)).toFixed(1)}`;
    }
    return d;
  };

  return (
    <Panel disabled={props.disabled}>
      <FreqFrame width={props.width} minDb={-12} maxDb={12} dbTicks={[-9, -6, -3, 0, 3, 6, 9]}>
        {(yFor) => (
          <>
            {active.length === 0 ? (
              <text x={props.width / 2} y={HEIGHT / 2} textAnchor="middle"
                fill="rgba(255,255,255,0.30)"
                style={{ fontFamily: typography.family.sans, fontSize: 11 }}>
                활성 밴드 없음 — 숫자 조정에서 밴드를 켜세요
              </text>
            ) : active.map((b) => {
              const colour = BAND_COLORS[b.index % BAND_COLORS.length]!;
              // How far this band CAN travel, in the direction it works.
              const reach = b.mode === 'up' ? b.rangeDb : -b.rangeDb;
              return (
                <g key={b.index}>
                  <path d={curveFor(b, reach, yFor)} fill="none"
                    stroke={colour} strokeOpacity={0.28} strokeWidth={1} strokeDasharray="3 3" />
                  {live && (
                    <path d={curveFor(b, b.liveDb, yFor)} fill="none" stroke={colour} strokeWidth={2} />
                  )}
                  <circle cx={hzToX(b.hz, props.width)} cy={yFor(live ? b.liveDb : 0)} r={4}
                    fill={colour} stroke="rgba(10,10,14,0.85)" strokeWidth={1.5} />
                  <text x={hzToX(b.hz, props.width)} y={yFor(live ? b.liveDb : 0) - 8} textAnchor="middle"
                    fill={colour} style={{ fontFamily: typography.family.mono, fontSize: 8 }}>
                    {b.index + 1}
                  </text>
                </g>
              );
            })}
          </>
        )}
      </FreqFrame>
      <Caption>
        {active.length === 0
          ? '밴드를 켜면 여기에 나타납니다. 점선은 그 밴드가 움직일 수 있는 최대 범위입니다.'
          : live
            ? '실선 = 지금 적용 중인 곡선, 점선 = 그 밴드의 최대 이동 범위. 다이나믹 EQ는 곡선이 신호에 따라 움직입니다.'
            : '재생을 시작하면 실선이 신호를 따라 움직입니다. 지금은 최대 범위(점선)만 표시됩니다.'}
      </Caption>
    </Panel>
  );
}

// ── 3. Impact ────────────────────────────────────────────────────────────

const IMPACT_BAND_LABELS = ['Low', 'Low mid', 'High mid', 'High'];

/**
 * Per-band transient shaping, as bars either side of zero.
 *
 * Positive sharpens the attack, negative softens it, and the direction is
 * the whole control — so the display is a signed bar per band rather than a
 * curve, which would imply a frequency response this module does not have.
 */
export function ImpactView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const live = props.metrics.running && !props.metrics.bypass;
  const bands = IMPACT_BAND_LABELS.map((label, i) => ({ label, pct: num(v, `band${i}Pct`, 0) }));
  const anyOn = bands.some((b) => Math.abs(b.pct) > 0.5);
  const history = useHistory(props.metrics.impactMoveDb, props.metrics.updatedAt);

  const H = 150;
  const mid = H / 2;
  const colW = (props.width - PAD.left - PAD.right) / bands.length;

  return (
    <Panel disabled={props.disabled}>
      <div style={{
        width: '100%', height: H,
        background: surface.well, border: `1px solid ${surface.border}`,
        borderRadius: radius.panel, overflow: 'hidden',
      }}>
        <svg width={props.width} height={H} style={{ display: 'block' }}>
          <line x1={PAD.left} x2={props.width - PAD.right} y1={mid} y2={mid}
            stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
          {bands.map((b, i) => {
            const x = PAD.left + i * colW;
            const h = (Math.abs(b.pct) / 100) * (mid - 14);
            const up = b.pct >= 0;
            return (
              <g key={b.label}>
                <rect
                  x={x + colW * 0.22} y={up ? mid - h : mid}
                  width={colW * 0.56} height={Math.max(0, h)}
                  fill={up ? 'rgba(52,211,153,0.55)' : 'rgba(248,113,113,0.55)'}
                />
                <text x={x + colW / 2} y={H - 6} textAnchor="middle"
                  fill="rgba(255,255,255,0.38)"
                  style={{ fontFamily: typography.family.sans, fontSize: 9 }}>
                  {b.label}
                </text>
                <text x={x + colW / 2} y={up ? mid - h - 4 : mid + h + 11} textAnchor="middle"
                  fill={Math.abs(b.pct) > 0.5 ? text.secondary : text.disabled}
                  style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
                  {`${b.pct > 0 ? '+' : ''}${b.pct.toFixed(0)}%`}
                </text>
              </g>
            );
          })}
          <text x={props.width - PAD.right - 2} y={14} textAnchor="end"
            fill="rgba(255,255,255,0.30)"
            style={{ fontFamily: typography.family.mono, fontSize: 8 }}>
            {'어택 강조 ↑ / 완화 ↓'}
          </text>
          {/* What it is actually doing to the transient, over time. */}
          {live && history.length > 1 && (
            <path
              d={history.map((g, i) => {
                const x = PAD.left + (i / (HISTORY_LEN - 1)) * (props.width - PAD.left - PAD.right);
                return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(mid - (g / 6) * (mid - 14)).toFixed(1)}`;
              }).join('')}
              fill="none" stroke={meter.accent.foreground} strokeWidth={1.2} strokeOpacity={0.8}
            />
          )}
        </svg>
      </div>
      <Caption>
        {!anyOn
          ? '모든 밴드가 0% 입니다 — 이 모듈은 지금 아무 일도 하지 않습니다.'
          : `막대는 밴드별 설정, 가로선은 실제 적용량(${live ? `${props.metrics.impactMoveDb >= 0 ? '+' : ''}${props.metrics.impactMoveDb.toFixed(2)} dB` : '정지'})입니다. `
            + '트랜지언트 셰이퍼라 주파수 응답이 아니라 시간 포락선을 바꿉니다.'}
      </Caption>
    </Panel>
  );
}

// ── 4. Low End Focus ─────────────────────────────────────────────────────

/**
 * The band it works on, and the trim it applies there.
 *
 * Punchy and Smooth are opposite treatments of the same band, so the mode
 * is named in the caption rather than implied by a curve shape — the
 * contrast control changes envelope behaviour, which a magnitude plot
 * cannot show. What the plot does show honestly is the crossover and the
 * static gain, which is the part that IS a frequency response.
 */
export function LowEndFocusView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const mode = str(v, 'mode', 'punchy');
  const hz = num(v, 'frequencyHz', 120);
  const contrast = num(v, 'contrastPct', 0);
  const gainDb = num(v, 'gainDb', 0);
  const live = props.metrics.running && !props.metrics.bypass;
  const moveDb = props.metrics.lowEndFocusMoveDb;

  return (
    <Panel disabled={props.disabled}>
      <FreqFrame width={props.width} minDb={-12} maxDb={12} dbTicks={[-9, -6, -3, 0, 3, 6, 9]}>
        {(yFor) => (
          <>
            <rect x={PAD.left} y={PAD.top}
              width={Math.max(0, hzToX(hz, props.width) - PAD.left)}
              height={HEIGHT - PAD.top - PAD.bottom}
              fill="rgba(96,165,250,0.10)" />
            <line x1={hzToX(hz, props.width)} x2={hzToX(hz, props.width)}
              y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="rgba(96,165,250,0.55)" strokeWidth={1} />
            {/* Static trim below the crossover; flat above it. */}
            <path
              d={`M${PAD.left},${yFor(gainDb)}L${hzToX(hz, props.width).toFixed(1)},${yFor(gainDb)}`
                + `L${hzToX(hz, props.width).toFixed(1)},${yFor(0)}L${(props.width - PAD.right).toFixed(1)},${yFor(0)}`}
              fill="none" stroke="#60A5FA" strokeWidth={1.8}
            />
            {live && Math.abs(moveDb) > 0.01 && (
              <line
                x1={PAD.left} x2={hzToX(hz, props.width)}
                y1={yFor(gainDb + moveDb)} y2={yFor(gainDb + moveDb)}
                stroke={meter.accent.foreground} strokeWidth={1.4} strokeDasharray="4 3"
              />
            )}
            <text x={PAD.left + 6} y={PAD.top + 12}
              fill="rgba(255,255,255,0.34)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {`${mode === 'punchy' ? 'Punchy' : 'Smooth'} · ${fmtHz(hz)} Hz 아래`}
            </text>
          </>
        )}
      </FreqFrame>
      <Caption>
        {`${fmtHz(hz)} Hz 아래에 트림 ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB. `}
        {`대비 ${contrast.toFixed(0)}% 는 포락선을 바꾸는 값이라 이 곡선에는 나타나지 않습니다 — `}
        {live && Math.abs(moveDb) > 0.01
          ? `점선이 지금 실제로 적용 중인 ${(gainDb + moveDb).toFixed(1)} dB 입니다.`
          : '재생하면 점선으로 실제 적용량이 표시됩니다.'}
      </Caption>
    </Panel>
  );
}

// ── 5. Bass Control ──────────────────────────────────────────────────────

/**
 * There is no DSP behind this module.
 *
 * Drawing a plausible-looking panel for a module with no processing is the
 * one thing a display must never do: it would be indistinguishable from a
 * working one, and the user would spend time tuning nothing.
 */
export function BassControlView() {
  return (
    <Panel>
      <div style={{
        width: '100%', height: 120,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: surface.well, border: `1px dashed ${surface.border}`,
        borderRadius: radius.panel,
      }}>
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.sm, color: text.muted,
        }}>
          아직 DSP가 없는 모듈입니다 — 표시할 처리 결과가 없습니다
        </span>
      </div>
      <Caption>
        이 자리의 작업은 현재 <strong style={{ color: text.tertiary }}>Low End Focus</strong> 와
        {' '}<strong style={{ color: text.tertiary }}>Multiband Dynamics</strong> 의 저역 밴드가 담당합니다.
        전용 모듈이 생기기 전까지 그쪽을 쓰세요. 동작하지 않는 화면을 그럴듯하게 그려두면
        없는 기능을 조정하며 시간을 쓰게 되므로 그렇게 하지 않았습니다.
      </Caption>
    </Panel>
  );
}

// ── 6/7. Limiter and Maximizer ───────────────────────────────────────────

/**
 * Gain reduction over time, with the ceiling and the loudness figures.
 *
 * A limiter's character lives in how its reduction moves. "−4.1 dB" cannot
 * distinguish a limiter breathing with the music from one clamped flat, so
 * the reading is a rolling history — twenty seconds at the store's ten
 * ticks a second — with the peak of that window called out.
 *
 * The loudness figures come from the monitor's own measurement, so they are
 * only shown while it is measuring; a stale LUFS is worse than none.
 */
export function LimiterView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  maximizer?: boolean;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const ceiling = num(v, 'ceilingDbtp', -1);
  const targetLufs = num(v, 'targetLufs', -14);
  const isp = boolOf(v, 'isp', true);
  const m = props.metrics;
  const live = m.running && !m.bypass;
  const history = useHistory(m.limiterGrDb, m.updatedAt);

  const H = 168;
  const MAX_GR = 12;
  const yFor = (gr: number): number =>
    PAD.top + (Math.min(MAX_GR, Math.max(0, gr)) / MAX_GR) * (H - PAD.top - PAD.bottom);
  const plotW = props.width - PAD.left - PAD.right;
  const windowPeak = history.length > 0 ? Math.max(...history) : 0;

  return (
    <Panel disabled={props.disabled}>
      <div style={{
        width: '100%', height: H,
        background: surface.well, border: `1px solid ${surface.border}`,
        borderRadius: radius.panel, overflow: 'hidden',
      }}>
        <svg width={props.width} height={H} style={{ display: 'block' }}>
          {[0, 3, 6, 9, 12].map((gr) => (
            <g key={gr}>
              <line x1={PAD.left} x2={props.width - PAD.right} y1={yFor(gr)} y2={yFor(gr)}
                stroke={gr === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'} strokeWidth={1} />
              <text x={props.width - PAD.right + 4} y={yFor(gr) + 3}
                fill="rgba(255,255,255,0.32)"
                style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
                {gr === 0 ? '0' : `-${gr}`}
              </text>
            </g>
          ))}
          {/* Reduction, filled downwards from unity. */}
          {history.length > 1 && (
            <path
              d={`M${PAD.left},${yFor(0)}`
                + history.map((g, i) => {
                  const x = PAD.left + (i / (HISTORY_LEN - 1)) * plotW;
                  return `L${x.toFixed(1)},${yFor(g).toFixed(1)}`;
                }).join('')
                + `L${(PAD.left + ((history.length - 1) / (HISTORY_LEN - 1)) * plotW).toFixed(1)},${yFor(0)}Z`}
              fill="rgba(167,139,250,0.22)" stroke={meter.accent.foreground} strokeWidth={1.2}
            />
          )}
          <text x={PAD.left + 6} y={H - 6}
            fill="rgba(255,255,255,0.30)"
            style={{ fontFamily: typography.family.mono, fontSize: 8 }}>
            {`최근 ${(HISTORY_LEN / 10).toFixed(0)}초 · GR dB`}
          </text>
          <text x={props.width - PAD.right - 2} y={H - 6} textAnchor="end"
            fill={live ? text.secondary : text.disabled}
            style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
            {live ? `지금 −${m.limiterGrDb.toFixed(1)} · 구간 최대 −${windowPeak.toFixed(1)}` : '정지'}
          </text>
        </svg>
      </div>
      <Caption>
        {props.maximizer
          ? `목표 ${targetLufs.toFixed(1)} LUFS 까지 밀어 올리고, 천장 ${ceiling.toFixed(1)} dBTP 를 넘지 않습니다`
          : `천장 ${ceiling.toFixed(1)} dBTP${isp ? ' · 트루 피크(ISP) 보호 켜짐' : ' · 샘플 피크만 감시'}`}
        {live && Number.isFinite(m.wetLufs)
          ? ` · 현재 ${m.wetLufs.toFixed(1)} LUFS (체인 추가 ${m.loudnessDeltaDb >= 0 ? '+' : ''}${m.loudnessDeltaDb.toFixed(1)} dB)`
          : ' · 재생하면 실측 라우드니스가 표시됩니다'}
      </Caption>
    </Panel>
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export const TONE_DYN_VIEW_MODULES = new Set([
  'stabilizer', 'dynamic-eq', 'impact', 'low-end-focus', 'limiter',
]);

/** Registry ids that have a view but no parameter module of their own. */
export const REGISTRY_ONLY_VIEWS = new Set(['bass-control']);

export function ToneDynamicsView(props: {
  moduleId: string;
  /** The rack row, which distinguishes Limiter from Maximizer. */
  registryId?: string;
  values: Record<string, ParameterValue>;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(720);
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 720);
    return () => ro.disconnect();
  }, []);

  const common = {
    values: props.values,
    width,
    metrics: props.metrics,
    disabled: props.disabled,
  };

  let body: React.ReactNode = null;
  switch (props.moduleId) {
    case 'stabilizer': body = <StabilizerView {...common} />; break;
    case 'dynamic-eq': body = <DynamicEqView {...common} />; break;
    case 'impact': body = <ImpactView {...common} />; break;
    case 'low-end-focus': body = <LowEndFocusView {...common} />; break;
    case 'limiter':
      body = <LimiterView {...common} maximizer={props.registryId === 'maximizer'} />;
      break;
    default:
      if (props.registryId === 'bass-control') body = <BassControlView />;
      break;
  }

  return <div ref={wrapRef}>{body}</div>;
}
