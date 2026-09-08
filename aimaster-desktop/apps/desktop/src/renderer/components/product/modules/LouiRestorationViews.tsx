// LouiRestorationViews — displays for the modules whose work is invisible.
//
// A compressor at least moves a meter. De-hum, de-noise, de-essing and
// tonal matching all do their job in the frequency domain, where a row of
// numbers tells you nothing: "Frequency 60, Harmonics 8, Depth 12" does not
// answer "is it on my hum, and is it eating my bass?" The reference tools
// for each of these — X-Hum, Denoiser, Pro-DS, Reference — answer that with
// a picture, and so does each view here.
//
// The rule they all follow: draw what the engine reports, and when the
// engine reports nothing, say so instead of drawing a plausible zero. A
// noise profile that has not been learned is not a flat line at -140 — it
// is an absent measurement, and the panel says "not learned yet".

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
function bool(v: Record<string, ParameterValue>, id: string, fallback: boolean): boolean {
  const x = v[id];
  return typeof x === 'boolean' ? x : fallback;
}

/**
 * A number that may arrive as an enum string.
 *
 * De-hum's mains frequency is a two-value chip row ('50' / '60'), so reading
 * it with the plain numeric accessor silently returned the fallback and drew
 * a 60 Hz comb for a 50 Hz setting — a picture that disagreed with the
 * audio in the one place this display exists to be trusted.
 */
function numOrEnum(v: Record<string, ParameterValue>, id: string, fallback: number): number {
  const x = v[id];
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ── Shared frame ─────────────────────────────────────────────────────────

/** The panel every view draws inside: log ruler, dB ruler, caption. */
function Frame(props: {
  width: number;
  minDb: number;
  maxDb: number;
  dbTicks: number[];
  children: (yFor: (db: number) => number) => React.ReactNode;
  caption: React.ReactNode;
  live?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const { width, minDb, maxDb } = props;
  const yFor = (db: number): number => {
    const t = (maxDb - Math.max(minDb, Math.min(maxDb, db))) / (maxDb - minDb);
    return PAD.top + t * (HEIGHT - PAD.top - PAD.bottom);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'], opacity: props.disabled ? 0.45 : 1 }}>
      <div style={{
        width: '100%',
        height: HEIGHT,
        background: surface.well,
        border: `1px solid ${surface.border}`,
        borderRadius: radius.panel,
        overflow: 'hidden',
      }}>
        <svg width={width} height={HEIGHT} style={{ display: 'block' }}>
          {AXIS_MINOR_HZ.map((hz) => (
            <line
              key={`m${hz}`} x1={hzToX(hz, width)} x2={hzToX(hz, width)}
              y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="rgba(255,255,255,0.04)" strokeWidth={1}
            />
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
      <span style={{
        fontFamily: typography.family.sans, fontSize: typography.size.xs,
        color: text.muted, lineHeight: 1.6,
      }}>
        {props.caption}
      </span>
    </div>
  );
}

/** A polyline through a folded band curve. */
function bandPath(
  values: readonly number[],
  width: number,
  yFor: (db: number) => number,
): string {
  let d = '';
  for (let i = 0; i < values.length; i++) {
    const x = hzToX(logBandHz(i, values.length), width);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yFor(values[i]!).toFixed(1)}`;
  }
  return d;
}

/** Shown when a display has no measurement to draw. */
function NoData(props: { width: number; label: string }) {
  return (
    <text
      x={props.width / 2} y={HEIGHT / 2} textAnchor="middle"
      fill="rgba(255,255,255,0.30)"
      style={{ fontFamily: typography.family.sans, fontSize: 11 }}
    >
      {props.label}
    </text>
  );
}

// ── 1. De-hum ────────────────────────────────────────────────────────────

/**
 * The notch comb, drawn exactly.
 *
 * This is a pure function of the parameters — a cascade of narrow peaking
 * cuts at f0 and its harmonics — so it needs no live data to be truthful.
 * What it answers is the only question that matters when setting a de-hummer:
 * are the notches landing on the hum, and how much programme material sits
 * under them.
 */
export function DehumView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const f0 = numOrEnum(v, 'frequencyHz', 60);
  const harmonics = Math.round(num(v, 'harmonics', 8));
  const depth = num(v, 'depthDb', 0);
  const q = num(v, 'q', 30);
  const adaptive = bool(v, 'adaptive', true);

  const path = useMemo(() => {
    const pts = 700;
    const gains: number[] = [];
    for (let i = 0; i < pts; i++) {
      const hz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, i / (pts - 1));
      let sum = 0;
      for (let h = 1; h <= harmonics; h++) {
        const f = f0 * h;
        if (f > AXIS_MAX_HZ) break;
        // Peaking-filter magnitude, the same form the engine builds.
        const w = hz / f;
        const denom = (1 - w * w) * (1 - w * w) + (w / q) * (w / q);
        const A = Math.pow(10, -depth / 40);
        const numr = (1 - w * w) * (1 - w * w) + (w * A / q) * (w * A / q);
        const dmr = (1 - w * w) * (1 - w * w) + (w / (A * q)) * (w / (A * q));
        sum += denom > 0 ? 10 * Math.log10(numr / dmr) : 0;
      }
      gains.push(sum);
    }
    return { gains, pts };
  }, [f0, harmonics, depth, q]);

  const noneApplied = depth <= 0.01;

  return (
    <Frame
      width={props.width} minDb={-36} maxDb={6} dbTicks={[-30, -24, -18, -12, -6, 0]}
      disabled={props.disabled}
      caption={
        noneApplied
          ? '깊이가 0이라 노치가 걸리지 않습니다. Depth를 올리면 곡선이 내려갑니다.'
          : `${fmtHz(f0)} Hz 기본파 + 배음 ${harmonics}개 · Q ${q.toFixed(0)} · 최대 −${depth.toFixed(1)} dB`
            + (adaptive ? ' · 어댑티브: 배음별 깊이는 실제 험 에너지에 따라 이보다 얕아질 수 있습니다' : '')
      }
    >
      {(yFor) => (
        <>
          {/* Harmonic markers, so it is obvious where the comb sits. */}
          {Array.from({ length: harmonics }, (_, i) => f0 * (i + 1))
            .filter((f) => f <= AXIS_MAX_HZ)
            .map((f, i) => (
              <line
                key={f} x1={hzToX(f, props.width)} x2={hzToX(f, props.width)}
                y1={PAD.top} y2={HEIGHT - PAD.bottom}
                stroke={i === 0 ? 'rgba(251,191,36,0.35)' : 'rgba(251,191,36,0.14)'}
                strokeWidth={1}
              />
            ))}
          <path
            d={path.gains.map((g, i) => {
              const hz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, i / (path.pts - 1));
              return `${i === 0 ? 'M' : 'L'}${hzToX(hz, props.width).toFixed(1)},${yFor(g).toFixed(1)}`;
            }).join('')}
            fill="none" stroke="#FBBF24" strokeWidth={1.6}
          />
          {props.metrics.running && props.metrics.dehumDepthDb > 0.05 && (
            <text
              x={PAD.left + 6} y={PAD.top + 12}
              fill={meter.accent.foreground}
              style={{ fontFamily: typography.family.mono, fontSize: 10 }}
            >
              {`지금 −${props.metrics.dehumDepthDb.toFixed(1)} dB`}
            </text>
          )}
        </>
      )}
    </Frame>
  );
}

// ── 2. De-noise ──────────────────────────────────────────────────────────

/**
 * The learned noise floor against the live signal.
 *
 * This is the Denoiser display: you can see whether the profile sits under
 * the music (good) or through it (about to eat the mix). The threshold
 * offset is drawn as a second line, because that — not the raw profile — is
 * the level the mask actually compares against.
 */
export function DenoiseView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const reduction = num(v, 'reductionDb', 0);
  const thresholdDb = num(v, 'thresholdDb', 0);
  const auto = bool(v, 'autoProfile', true);
  const profile = props.metrics.denoiseProfileDb;
  const hasProfile = profile.length > 4 && profile.some((x) => x > -139);

  return (
    <Frame
      width={props.width} minDb={-100} maxDb={0} dbTicks={[-80, -60, -40, -20, 0]}
      disabled={props.disabled}
      caption={
        !hasProfile
          ? (auto
            ? '노이즈 프로파일을 아직 추정하지 못했습니다 — 재생을 시작하면 최소통계 추정이 채워집니다.'
            : '프로파일이 없습니다. 조용한 구간에서 Learn을 실행하세요.')
          : `노란 선이 엔진이 노이즈로 보는 레벨, 점선이 threshold ${thresholdDb >= 0 ? '+' : ''}${thresholdDb.toFixed(1)} dB를 더한 판정선입니다. `
            + `최대 감쇠 ${reduction.toFixed(1)} dB.`
      }
    >
      {(yFor) => (
        <>
          {!hasProfile ? (
            <NoData width={props.width} label="프로파일 없음" />
          ) : (
            <>
              <path
                d={bandPath(profile, props.width, yFor)}
                fill="none" stroke="#FBBF24" strokeWidth={1.6}
              />
              <path
                d={bandPath(profile.map((p) => p + thresholdDb), props.width, yFor)}
                fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1}
                strokeDasharray="4 3"
              />
              {/* Everything below the decision line is what gets masked. */}
              <path
                d={`${bandPath(profile.map((p) => p + thresholdDb), props.width, yFor)}`
                  + `L${(props.width - PAD.right).toFixed(1)},${(HEIGHT - PAD.bottom).toFixed(1)}`
                  + `L${PAD.left.toFixed(1)},${(HEIGHT - PAD.bottom).toFixed(1)}Z`}
                fill="rgba(251,191,36,0.08)" stroke="none"
              />
            </>
          )}
        </>
      )}
    </Frame>
  );
}

// ── 3. De-esser ──────────────────────────────────────────────────────────

const GR_HISTORY = 120;

/**
 * Where it listens, and when it fires.
 *
 * Pro-DS shows sibilance as bursts against the waveform; the same
 * information here is a rolling strip of gain reduction, because that is
 * what the chain reports. The band it works on is drawn on the ruler, so
 * "it is ducking, but on the wrong syllable" and "it is ducking the whole
 * top end" are distinguishable at a glance.
 */
export function DeessView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const freq = num(v, 'frequencyHz', 6500);
  const range = num(v, 'rangeDb', 6);
  const wideband = bool(v, 'wideband', false);
  const gr = props.metrics.deessGrDb;

  // A short rolling history, kept in a ref-like state that only advances
  // when the store ticks — ten samples a second, twelve seconds of memory.
  const historyRef = React.useRef<number[]>([]);
  React.useEffect(() => {
    const h = historyRef.current;
    h.push(gr);
    if (h.length > GR_HISTORY) h.shift();
  }, [gr, props.metrics.updatedAt]);
  const history = historyRef.current;

  const plotW = props.width - PAD.left - PAD.right;
  const maxGr = Math.max(range, 6);

  return (
    <Frame
      width={props.width} minDb={-maxGr} maxDb={0} dbTicks={[-maxGr, -maxGr / 2, 0].map((d) => Math.round(d))}
      disabled={props.disabled}
      caption={
        wideband
          ? `${fmtHz(freq)} Hz 위를 감지해 전대역을 ${range.toFixed(1)} dB까지 낮춥니다 (와이드밴드).`
          : `${fmtHz(freq)} Hz 위 고역만 최대 ${range.toFixed(1)} dB 낮춥니다. 아래 스트립은 최근 12초의 감쇠량입니다.`
      }
    >
      {(yFor) => (
        <>
          {/* The band it acts on. */}
          <rect
            x={hzToX(freq, props.width)} y={PAD.top}
            width={Math.max(0, props.width - PAD.right - hzToX(freq, props.width))}
            height={HEIGHT - PAD.top - PAD.bottom}
            fill="rgba(34,211,238,0.07)"
          />
          <line
            x1={hzToX(freq, props.width)} x2={hzToX(freq, props.width)}
            y1={PAD.top} y2={HEIGHT - PAD.bottom}
            stroke="rgba(34,211,238,0.5)" strokeWidth={1}
          />
          {/* Gain reduction over time, newest at the right. */}
          {history.length > 1 && (
            <path
              d={history.map((g, i) => {
                const x = PAD.left + (i / (GR_HISTORY - 1)) * plotW;
                return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yFor(-g).toFixed(1)}`;
              }).join('')}
              fill="none" stroke={meter.accent.foreground} strokeWidth={1.4}
            />
          )}
          <text
            x={props.width - PAD.right - 4} y={PAD.top + 12} textAnchor="end"
            fill={gr > 0.05 ? meter.accent.foreground : 'rgba(255,255,255,0.30)'}
            style={{ fontFamily: typography.family.mono, fontSize: 10 }}
          >
            {props.metrics.running ? `−${gr.toFixed(1)} dB` : '정지'}
          </text>
        </>
      )}
    </Frame>
  );
}

// ── 4. Reference Match ───────────────────────────────────────────────────

/**
 * Your curve against the reference's, and the distance between them.
 *
 * The match percentage is derived here rather than reported by the engine,
 * and it is defined plainly: the mean absolute band difference, mapped so
 * that 0 dB of difference is 100 % and 12 dB is 0 %. A number like that is
 * only worth showing if its definition is written down, which is why it is
 * in this comment and in the caption.
 */
/** How the reference is loaded, supplied by the page. */
export interface MatchReferenceControls {
  /** File name of the loaded reference, or null. */
  name: string | null;
  /** Open a picker and measure whatever is chosen. */
  onChoose: () => void;
  /** Forget the current reference. */
  onClear: () => void;
  /** True while a reference is being decoded and measured. */
  busy: boolean;
  /** Why the last attempt failed, if it did. */
  error: string | null;
}

export function MatchView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  targetCurveDb?: readonly number[] | undefined;
  reference?: MatchReferenceControls | undefined;
  disabled?: boolean | undefined;
}) {
  const source = props.metrics.tonalCurveDb;
  const target = props.targetCurveDb ?? [];
  const amount = num(props.values, 'amountPct', 50);
  const maxMove = num(props.values, 'maxMoveDb', 3);

  const hasSource = source.length > 4 && source.some((x) => x > -139);
  const hasTarget = target.length > 4;

  const matchPct = useMemo(() => {
    if (!hasSource || !hasTarget) return null;
    const n = Math.min(source.length, target.length);
    // Both curves are relative shapes; comparing them without removing
    // their level difference would report a loudness gap as a tonal one.
    let sm = 0; let tm = 0;
    for (let i = 0; i < n; i++) { sm += source[i]!; tm += target[i]!; }
    sm /= n; tm /= n;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += Math.abs((source[i]! - sm) - (target[i]! - tm));
    return Math.max(0, Math.min(100, 100 * (1 - acc / n / 12)));
  }, [source, target, hasSource, hasTarget]);

  // Drawn as deviation from each curve's own mean, for the same reason.
  const centred = (c: readonly number[]): number[] => {
    if (c.length === 0) return [];
    const m = c.reduce((a, b) => a + b, 0) / c.length;
    return c.map((x) => x - m);
  };

  const ref = props.reference;

  return (
    <>
    {/* Loading a reference is the first step and it had no control at all —
        the panel said "no reference" and offered no way to supply one. */}
    {ref && (
      <div style={{
        display: 'flex', alignItems: 'center', gap: space['2'], flexWrap: 'wrap',
        paddingInline: space['3'], paddingBlock: space['2'],
        marginBottom: space['2'],
        background: surface.well,
        border: `1px solid ${hasTarget ? surface.border : `${meter.warn.foreground}44`}`,
        borderRadius: radius.panel,
      }}>
        <button
          type="button"
          onClick={ref.onChoose}
          disabled={ref.busy || props.disabled}
          className="no-drag"
          style={{
            appearance: 'none',
            cursor: ref.busy || props.disabled ? 'wait' : 'pointer',
            paddingInline: space['3'], paddingBlock: 5,
            borderRadius: radius.chip,
            border: `1px solid ${meter.accent.foreground}77`,
            background: `${meter.accent.foreground}18`,
            color: meter.accent.foreground,
            fontFamily: typography.family.sans, fontSize: typography.size.xs,
            whiteSpace: 'nowrap',
          }}
        >
          {ref.busy
            ? '분석 중…'
            : hasTarget ? '레퍼런스 바꾸기' : '레퍼런스 곡 불러오기'}
        </button>
        {hasTarget && !ref.busy && (
          <button
            type="button"
            onClick={ref.onClear}
            className="no-drag"
            style={{
              appearance: 'none', cursor: 'pointer',
              paddingInline: space['2'], paddingBlock: 5,
              borderRadius: radius.chip,
              border: `1px solid ${surface.border}`,
              background: 'transparent',
              color: text.muted,
              fontFamily: typography.family.sans, fontSize: typography.size.xs,
              whiteSpace: 'nowrap',
            }}
          >
            해제
          </button>
        )}
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: ref.error ? meter.warn.foreground : text.muted,
          lineHeight: 1.6, flex: 1, minWidth: 200,
        }}>
          {ref.error
            ? `레퍼런스를 읽지 못했습니다: ${ref.error}`
            : ref.busy
              ? '레퍼런스 곡의 음색 균형을 재고 있습니다. 곡 중간 90초를 분석합니다.'
              : ref.name
                ? `기준: ${ref.name}`
                : '닮고 싶은 완성된 곡을 하나 고르세요 (WAV·MP3·FLAC 등). 그 곡의 음색 균형만 가져오고, 소리를 복사하지는 않습니다.'}
        </span>
      </div>
    )}

    <Frame
      width={props.width} minDb={-12} maxDb={12} dbTicks={[-9, -6, -3, 0, 3, 6, 9]}
      disabled={props.disabled}
      caption={
        !hasTarget
          ? '레퍼런스 커브가 없습니다. 레퍼런스를 지정하기 전에는 이 모듈이 아무 일도 하지 않습니다.'
          : !hasSource
            // The curve is measured BY the spectral stage, so "press play"
            // would be wrong advice while the module is bypassed — nothing
            // is measuring.
            ? '내 곡의 톤 커브가 아직 없습니다 — 이 모듈을 켜고 재생하면 측정이 시작됩니다.'
            : `보라 = 내 곡, 파랑 = 레퍼런스. 각자의 평균을 뺀 상대 곡선이라 음량 차가 톤 차이로 보이지 않습니다. `
              + `일치도는 밴드별 차이의 평균을 12 dB 기준으로 환산한 값입니다 · 적용 ${amount.toFixed(0)}% · 밴드당 최대 ${maxMove.toFixed(1)} dB`
      }
    >
      {(yFor) => (
        <>
          {!hasTarget ? (
            <NoData width={props.width} label="레퍼런스 없음" />
          ) : (
            <>
              <path d={bandPath(centred(target), props.width, yFor)}
                fill="none" stroke="#38BDF8" strokeWidth={1.6} />
              {hasSource && (
                <path d={bandPath(centred(source), props.width, yFor)}
                  fill="none" stroke="#A78BFA" strokeWidth={1.8} />
              )}
              {matchPct !== null && (
                <text
                  x={props.width / 2} y={PAD.top + 12} textAnchor="middle"
                  fill={matchPct > 80 ? meter.safe.foreground : meter.warn.foreground}
                  style={{ fontFamily: typography.family.mono, fontSize: 11 }}
                >
                  {`일치 ${matchPct.toFixed(0)}%`}
                </text>
              )}
            </>
          )}
        </>
      )}
    </Frame>
    </>
  );
}

// ── 4b. Hiss Gate ────────────────────────────────────────────────────────

/**
 * The gate's working region, and where its threshold sits.
 *
 * What this deliberately does NOT do is draw a spectrum behind the
 * threshold line. The chain reports a long-term average per curve BAND;
 * the gate decides per FFT BIN, and a band holds dozens of bins, so the two
 * numbers differ by however much energy is spread across that band. Drawing
 * one against the other would put the user's spectrum confidently above a
 * line it is actually below — the exact class of picture that disagrees
 * with the audio, which is worse than no picture.
 *
 * So it draws what is known exactly: the corner frequency, the region the
 * gate can act in, how deep it may go, and — in words — that the number is
 * per bin and therefore far lower than a meter reads.
 */
export function HissGateView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const lowHz = num(v, 'lowHz', 2500);
  const thresholdDb = num(v, 'thresholdDb', -72);
  const rangeDb = num(v, 'rangeDb', 18);
  const amount = num(v, 'amountPct', 60);
  // The reduction the settings actually allow, so the panel states the real
  // ceiling rather than the slider's.
  const maxCut = Math.min(rangeDb, rangeDb) * (amount / 100);

  const minDb = -110;
  const maxDb = -30;

  return (
    <Frame
      width={props.width} minDb={minDb} maxDb={maxDb}
      dbTicks={[-100, -90, -80, -70, -60, -50, -40]}
      disabled={props.disabled}
      caption={
        <>
          {`${fmtHz(lowHz)} 위쪽에서만 동작합니다. 한 주파수의 크기가 기준선(${thresholdDb.toFixed(0)} dBFS)보다 `}
          {`작으면 잡음으로 보고 최대 ${maxCut.toFixed(0)} dB까지 눌러 없앱니다. `}
          <strong style={{ color: text.tertiary }}>기준선 위로 올라오는 소리는 그대로 둡니다.</strong>
          {' 이 숫자는 주파수 한 칸당 크기라 음량계보다 훨씬 낮습니다 — 인트로 잡음이 남으면 기준선을 올리고, 여린 소리가 사라지면 내리세요.'}
        </>
      }
    >
      {(yFor) => {
        const x0 = hzToX(Math.max(AXIS_MIN_HZ, lowHz), props.width);
        const xEnd = hzToX(AXIS_MAX_HZ, props.width);
        const yTh = yFor(thresholdDb);
        const yFloor = yFor(minDb);
        const yCut = yFor(thresholdDb - maxCut);
        return (
          <>
            {/* Everything under the threshold, inside the working range —
                the region the gate can touch at all. */}
            <rect
              x={x0} y={yTh} width={Math.max(0, xEnd - x0)} height={Math.max(0, yFloor - yTh)}
              fill="rgba(248,113,113,0.10)"
            />
            {/* How far down it may push, drawn as a depth rather than
                described, because "18 dB" means nothing against a scale
                the user cannot see. */}
            <rect
              x={x0} y={yTh} width={Math.max(0, xEnd - x0)} height={Math.max(0, yCut - yTh)}
              fill="rgba(248,113,113,0.18)"
            />
            <line
              x1={x0} x2={xEnd} y1={yTh} y2={yTh}
              stroke={meter.warn.foreground} strokeWidth={1.5}
            />
            <text
              x={xEnd - 4} y={yTh - 5} textAnchor="end"
              fill={meter.warn.foreground}
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}
            >
              {`잡음 기준 ${thresholdDb.toFixed(0)} dBFS`}
            </text>
            <text
              x={x0 + 6} y={(yTh + yCut) / 2 + 3}
              fill="rgba(255,255,255,0.55)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}
            >
              {`최대 -${maxCut.toFixed(0)} dB`}
            </text>
            {/* The corner: left of it the gate is inert. */}
            <line
              x1={x0} x2={x0} y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="rgba(255,255,255,0.30)" strokeWidth={1} strokeDasharray="4 3"
            />
            <text
              x={x0 + 4} y={PAD.top + 11}
              fill="rgba(255,255,255,0.5)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}
            >
              {`${fmtHz(lowHz)} 위`}
            </text>
            <text
              x={x0 - 6} y={PAD.top + 11} textAnchor="end"
              fill="rgba(255,255,255,0.32)"
              style={{ fontFamily: typography.family.sans, fontSize: 9 }}
            >
              건드리지 않음
            </text>
          </>
        );
      }}
    </Frame>
  );
}

// ── 5. Harshness Control (Spectral Shaper) ───────────────────────────────

/**
 * The band it watches and how far a peak must stick out to be pulled down.
 *
 * The one thing this display deliberately does NOT do is claim to show what
 * is being reduced. The module works per FFT frame on per-bin excess, and
 * the chain does not report that; drawing the post-chain spectrum and
 * calling the dips "the shaper working" would be a picture of the result
 * dressed up as a picture of the cause. What is drawn is exactly what is
 * known: the operating range, the threshold, and how wide a neighbourhood
 * each bin is measured against.
 */
export function HarshnessView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const lowHz = num(v, 'lowHz', 1000);
  const highHz = num(v, 'highHz', 12_000);
  const thresholdDb = num(v, 'thresholdDb', 6);
  const amount = num(v, 'amountPct', 50);
  const blur = Math.round(num(v, 'blurBins', 12));

  const x0 = hzToX(Math.min(lowHz, highHz), props.width);
  const x1 = hzToX(Math.max(lowHz, highHz), props.width);

  return (
    <Frame
      width={props.width} minDb={0} maxDb={24} dbTicks={[6, 12, 18]}
      disabled={props.disabled}
      caption={
        `${fmtHz(lowHz)}–${fmtHz(highHz)} Hz 구간에서, 주변 ${blur}빈 평균보다 ${thresholdDb.toFixed(1)} dB 이상 튀어나온 성분만 `
        + `그 초과분의 ${amount.toFixed(0)}%만큼 끌어내립니다. 고정 노치가 아니라 프레임마다 다시 판단합니다.`
      }
    >
      {(yFor) => (
        <>
          <rect
            x={x0} y={PAD.top} width={Math.max(0, x1 - x0)}
            height={HEIGHT - PAD.top - PAD.bottom}
            fill="rgba(167,139,250,0.10)"
          />
          {[x0, x1].map((x, i) => (
            <line key={i} x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="rgba(167,139,250,0.5)" strokeWidth={1} />
          ))}
          {/* The threshold, as a height above the local neighbourhood. */}
          <line
            x1={x0} x2={x1} y1={yFor(thresholdDb)} y2={yFor(thresholdDb)}
            stroke="#A78BFA" strokeWidth={1.6}
          />
          <text
            x={(x0 + x1) / 2} y={yFor(thresholdDb) - 5} textAnchor="middle"
            fill="#A78BFA"
            style={{ fontFamily: typography.family.mono, fontSize: 10 }}
          >
            {`+${thresholdDb.toFixed(1)} dB 초과분`}
          </text>
          <text
            x={PAD.left + 6} y={HEIGHT - PAD.bottom - 6}
            fill="rgba(255,255,255,0.30)"
            style={{ fontFamily: typography.family.mono, fontSize: 9 }}
          >
            주변 평균 = 0
          </text>
        </>
      )}
    </Frame>
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/** Module ids that have a restoration view. */
export const RESTORATION_VIEW_MODULES = new Set([
  'dehum', 'denoise', 'deess', 'hiss-gate', 'match-eq', 'spectral-shaper',
]);

/**
 * Measures its own width so callers do not have to.  The views draw SVG at
 * an explicit pixel width — a percentage would stretch the log axis and put
 * 1 kHz somewhere other than where the ruler says it is.
 */
export function RestorationView(props: {
  moduleId: string;
  values: Record<string, ParameterValue>;
  metrics: RealtimePreviewMetrics;
  targetCurveDb?: readonly number[] | undefined;
  reference?: MatchReferenceControls | undefined;
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

  return <div ref={wrapRef}><RestorationViewInner {...props} width={width} /></div>;
}

function RestorationViewInner(props: {
  moduleId: string;
  values: Record<string, ParameterValue>;
  metrics: RealtimePreviewMetrics;
  width: number;
  targetCurveDb?: readonly number[] | undefined;
  reference?: MatchReferenceControls | undefined;
  disabled?: boolean | undefined;
}) {
  const common = {
    values: props.values,
    width: props.width,
    metrics: props.metrics,
    ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
  };
  switch (props.moduleId) {
    case 'dehum': return <DehumView {...common} />;
    case 'denoise': return <DenoiseView {...common} />;
    case 'deess': return <DeessView {...common} />;
    case 'match-eq': return <MatchView {...common} targetCurveDb={props.targetCurveDb} reference={props.reference} />;
    case 'hiss-gate': return <HissGateView {...common} />;
    case 'spectral-shaper': return <HarshnessView {...common} />;
    default: return null;
  }
}
