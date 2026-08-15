// LouiCharacterViews — the last five: De-click, Exciter, Tape, Imager,
// Export.
//
// These are the modules where a plot has to be chosen carefully, because
// what they do is not a frequency response:
//
//   • De-click repairs single events. There is no curve — there is a count
//     and a length, so the display shows the repair window at scale.
//   • The Exciter ADDS harmonics. Drawing its "response" would be a lie;
//     what it has is an amount per band, so that is what is drawn.
//   • Tape has a real response (head bump, gap loss) and a real wobble, so
//     it gets a curve plus a note about the part a curve cannot show.
//   • The Imager works on width, not level, so its axis is width.
//   • Export has no processing at all — it has a decision, and the display
//     is the consequence of that decision spelled out.

import React from 'react';
import {
  AXIS_PAD as PAD,
  AXIS_MAJOR_HZ,
  AXIS_MINOR_HZ,
  AXIS_MIN_HZ,
  AXIS_MAX_HZ,
  hzToX,
  fmtAxisHz,
  fmtHz,
} from './spectrum-axis.js';
import type { ParameterValue } from '../../../audio/parameters/index.js';
import type { RealtimePreviewMetrics } from '../../../audio/realtime-preview-store.js';
import { MASTER_NATIVE_BIT_DEPTH } from '../../../audio/chain-config.js';
import { surface, text, typography, space, radius, meter } from '../../../theme/loui-theme.js';

const HEIGHT = 180;

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

function Shell(props: { children: React.ReactNode; disabled?: boolean | undefined }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      opacity: props.disabled ? 0.45 : 1,
    }}>
      {props.children}
    </div>
  );
}

function Box(props: { width: number; height?: number; children: React.ReactNode }) {
  const h = props.height ?? HEIGHT;
  return (
    <div style={{
      width: '100%', height: h,
      background: surface.well, border: `1px solid ${surface.border}`,
      borderRadius: radius.panel, overflow: 'hidden',
    }}>
      <svg width={props.width} height={h} style={{ display: 'block' }}>{props.children}</svg>
    </div>
  );
}

/** The shared log ruler, for the views that plot against frequency. */
function FreqGrid(props: { width: number; height: number }) {
  return (
    <>
      {AXIS_MINOR_HZ.map((hz) => (
        <line key={`m${hz}`} x1={hzToX(hz, props.width)} x2={hzToX(hz, props.width)}
          y1={PAD.top} y2={props.height - PAD.bottom}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}
      {AXIS_MAJOR_HZ.map((hz) => {
        const x = hzToX(hz, props.width);
        const anchor = hz === AXIS_MIN_HZ ? 'start' : hz === AXIS_MAX_HZ ? 'end' : 'middle';
        return (
          <g key={hz}>
            <line x1={x} x2={x} y1={PAD.top} y2={props.height - PAD.bottom}
              stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
            <text x={x} y={props.height - 6} textAnchor={anchor}
              fill="rgba(255,255,255,0.38)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {fmtAxisHz(hz)}
            </text>
          </g>
        );
      })}
    </>
  );
}

// ── 1. De-click ──────────────────────────────────────────────────────────

/**
 * The repair window, at scale, against a click.
 *
 * De-click has no frequency response and no meter — it finds an impulse and
 * interpolates across it. The two controls are "how far above the local
 * level counts" and "how long a repair may be", and both are about a single
 * short event, so the display draws that event: a spike, the guard either
 * side, and the span that would be rewritten, in milliseconds.
 */
export function DeclickView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const sensitivity = num(props.values, 'sensitivity', 50);
  const maxRun = num(props.values, 'maxRunSamples', 24);
  const ms = (maxRun / 48) ;
  const H = 150;
  const mid = H / 2;
  const centre = props.width / 2;
  // 1 ms of audio drawn across a fifth of the panel, so the repair span is
  // shown at a readable scale rather than as a hairline.
  const pxPerMs = (props.width - PAD.left - PAD.right) / 5;
  const halfSpan = (ms / 2) * pxPerMs;

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width} height={H}>
        <line x1={PAD.left} x2={props.width - PAD.right} y1={mid} y2={mid}
          stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
        {/* A plausible waveform, with one impulse in it. */}
        <path
          d={Array.from({ length: 200 }, (_, i) => {
            const x = PAD.left + (i / 199) * (props.width - PAD.left - PAD.right);
            const t = (i / 199) * 10;
            const y = mid - Math.sin(t * 2.1) * 26 - Math.sin(t * 0.7) * 12;
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
          }).join('')}
          fill="none" stroke="rgba(148,163,184,0.45)" strokeWidth={1.2}
        />
        <line x1={centre} x2={centre} y1={mid - 58} y2={mid + 58}
          stroke="#F87171" strokeWidth={2} />
        {/* The span that would be rewritten. */}
        <rect x={centre - halfSpan} y={PAD.top} width={halfSpan * 2} height={H - PAD.top - 24}
          fill="rgba(52,211,153,0.14)" stroke="rgba(52,211,153,0.5)" strokeWidth={1} />
        <text x={centre} y={H - 8} textAnchor="middle"
          fill="rgba(52,211,153,0.9)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          {`복구 구간 ${ms.toFixed(2)} ms (${maxRun.toFixed(0)} 샘플)`}
        </text>
        {/* Where the detector's bar sits, as a share of the local level. */}
        <line
          x1={PAD.left} x2={props.width - PAD.right}
          y1={mid - 58 + (sensitivity / 100) * 34} y2={mid - 58 + (sensitivity / 100) * 34}
          stroke="rgba(251,191,36,0.6)" strokeWidth={1} strokeDasharray="4 3"
        />
        <text x={PAD.left + 4} y={mid - 62 + (sensitivity / 100) * 34}
          fill="rgba(251,191,36,0.85)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          {`감지선 (민감도 ${sensitivity.toFixed(0)})`}
        </text>
      </Box>
      <Caption>
        빨간 선처럼 순간적으로 튀는 잡음을 찾아, 초록 구간만큼을 앞뒤 파형으로 부드럽게 이어 붙입니다.
        노란 점선(감지선)을 내리면 더 작은 잡음까지 잡지만, 드럼의 정상적인 타격까지 잡음으로 오해할 수 있습니다.
        복구 구간보다 긴 손상은 건드리지 않습니다.
      </Caption>
    </Shell>
  );
}

// ── 2. Exciter ───────────────────────────────────────────────────────────

const BAND_LABELS = ['Low  저역', 'Low mid  중저역', 'High mid  중고역', 'High  고역'];
const MODE_KO: Record<string, string> = {
  warm: 'Warm — 두툼하고 부드럽게',
  retro: 'Retro — 거칠고 옛날 기기처럼',
  tape: 'Tape — 테이프처럼 둥글게',
  tube: 'Tube — 진공관처럼 따뜻하게',
  triode: 'Triode — 진공관 중에서도 섬세하게',
};

/**
 * Amount per band, on the frequency ruler.
 *
 * An exciter ADDS harmonics; it has no magnitude response to plot, and
 * drawing one would suggest it boosts what is already there. What it does
 * have is a per-band amount and a set of crossovers, so the bands are drawn
 * where they actually sit in frequency, filled by how hard each is driven.
 */
export function ExciterView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const mode = str(v, 'mode', 'warm');
  const xo = [
    num(v, 'crossover1Hz', 120),
    num(v, 'crossover2Hz', 800),
    num(v, 'crossover3Hz', 5000),
  ];
  const amounts = [0, 1, 2, 3].map((i) => num(v, `band${i}Pct`, 0));
  const drive = num(v, 'driveDb', 0);
  const edges = [AXIS_MIN_HZ, ...xo, AXIS_MAX_HZ];
  const anyOn = amounts.some((a) => a > 0.5);

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width}>
        <FreqGrid width={props.width} height={HEIGHT} />
        {amounts.map((amt, i) => {
          const x0 = hzToX(edges[i]!, props.width);
          const x1 = hzToX(edges[i + 1]!, props.width);
          const h = (amt / 100) * (HEIGHT - PAD.top - PAD.bottom - 16);
          return (
            <g key={i}>
              <rect x={x0} y={HEIGHT - PAD.bottom - h} width={Math.max(0, x1 - x0)} height={h}
                fill="rgba(167,139,250,0.30)" stroke="rgba(167,139,250,0.6)" strokeWidth={1} />
              <text x={(x0 + x1) / 2} y={HEIGHT - PAD.bottom - h - 5} textAnchor="middle"
                fill={amt > 0.5 ? text.secondary : text.disabled}
                style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
                {`${amt.toFixed(0)}%`}
              </text>
              <text x={(x0 + x1) / 2} y={PAD.top + 11} textAnchor="middle"
                fill="rgba(255,255,255,0.30)"
                style={{ fontFamily: typography.family.sans, fontSize: 8 }}>
                {BAND_LABELS[i]?.split('  ')[1] ?? ''}
              </text>
            </g>
          );
        })}
      </Box>
      <Caption>
        {anyOn
          ? `막대 높이는 그 대역에 더해지는 배음의 양입니다. ${MODE_KO[mode] ?? mode} · 드라이브 ${drive.toFixed(1)} dB. `
          : '모든 대역이 0% 입니다 — 지금은 아무 색도 입히지 않습니다. '}
        엑사이터는 있는 소리를 키우는 게 아니라 <strong style={{ color: text.tertiary }}>없던 배음을 더합니다</strong>.
        대역마다 음량이 자동으로 맞춰지므로 커지지 않고 색만 바뀝니다.
      </Caption>
    </Shell>
  );
}

// ── 3. Tape ──────────────────────────────────────────────────────────────

const TAPE_SPEED_KO: Record<string, string> = {
  '7.5ips': '7.5 ips — 가장 진하고 저음이 크게 부풀어요',
  '15ips': '15 ips — 균형 잡힌 표준',
  '30ips': '30 ips — 가장 깨끗하고 색이 옅어요',
};

/**
 * The response tape actually has, plus a note about the part it does not.
 *
 * Head bump and gap loss are a real magnitude response and are drawn as
 * one. Wow and flutter are a pitch wobble over time — no magnitude plot can
 * show them, so the caption says what that control does instead of leaving
 * the user to assume the curve covers it.
 */
export function TapeView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const speed = str(v, 'speed', '15ips');
  const drive = num(v, 'driveDb', 0);
  const bias = num(v, 'bias', 0.5);
  const mix = num(v, 'mixPct', 100);
  const wow = num(v, 'wowFlutterPct', 0);

  // Slower tape bumps lower and rolls off earlier — the shape the engine
  // builds from the speed setting.
  const bumpHz = speed === '7.5ips' ? 55 : speed === '30ips' ? 110 : 80;
  const rollHz = speed === '7.5ips' ? 9000 : speed === '30ips' ? 18_000 : 13_000;
  const bumpDb = (speed === '7.5ips' ? 2.4 : speed === '30ips' ? 0.8 : 1.5) * (0.4 + bias);
  const lossDb = (speed === '7.5ips' ? -3.0 : speed === '30ips' ? -1.0 : -2.0);
  const wet = Math.min(1, Math.max(0, mix / 100));

  const minDb = -8;
  const maxDb = 8;
  const yFor = (db: number): number => {
    const t = (maxDb - Math.max(minDb, Math.min(maxDb, db))) / (maxDb - minDb);
    return PAD.top + t * (HEIGHT - PAD.top - PAD.bottom);
  };

  const path = React.useMemo(() => {
    const pts = 300;
    let d = '';
    for (let i = 0; i <= pts; i++) {
      const hz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, i / pts);
      const bump = bumpDb / (1 + Math.pow((hz / bumpHz - bumpHz / hz) * 1.1, 2));
      const loss = lossDb - lossDb / (1 + Math.pow(hz / rollHz, 2));
      d += `${i === 0 ? 'M' : 'L'}${hzToX(hz, props.width).toFixed(1)},${yFor((bump + loss) * wet).toFixed(1)}`;
    }
    return d;
  }, [bumpDb, bumpHz, lossDb, rollHz, wet, props.width]);

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width}>
        <FreqGrid width={props.width} height={HEIGHT} />
        {[-6, -3, 0, 3, 6].map((db) => (
          <g key={db}>
            <line x1={PAD.left} x2={props.width - PAD.right} y1={yFor(db)} y2={yFor(db)}
              stroke={db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'} strokeWidth={1} />
            <text x={props.width - PAD.right + 4} y={yFor(db) + 3}
              fill="rgba(255,255,255,0.32)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#FBBF24" strokeWidth={1.8} />
        <text x={hzToX(bumpHz, props.width)} y={yFor(bumpDb * wet) - 8} textAnchor="middle"
          fill="rgba(251,191,36,0.9)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          헤드 범프
        </text>
        <text x={hzToX(rollHz, props.width)} y={yFor(lossDb * wet) + 14} textAnchor="middle"
          fill="rgba(251,191,36,0.7)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          고역 감쇠
        </text>
      </Box>
      <Caption>
        {`${TAPE_SPEED_KO[speed] ?? speed} · 드라이브 ${drive.toFixed(1)} dB · 섞기 ${mix.toFixed(0)}%. `}
        곡선은 테이프가 만드는 <strong style={{ color: text.tertiary }}>주파수 변화</strong>입니다 — 저음이 살짝 부풀고 고음이 깎입니다.
        {wow > 0.01
          ? ` 떨림 ${wow.toFixed(1)}% 는 음정이 미세하게 흔들리는 효과라 이 곡선에는 나타나지 않습니다.`
          : ' 떨림은 0이라 음정 흔들림은 없습니다.'}
      </Caption>
    </Shell>
  );
}

// ── 4. Imager ────────────────────────────────────────────────────────────

/**
 * Width per band, on the frequency ruler, with the mono fold marked.
 *
 * The axis here is width, not level, because that is the only thing this
 * module changes. 100 % is the middle line — the track as it arrived — so
 * narrowing and widening read as movement in opposite directions rather
 * than as "more" and "less" of something.
 */
export function ImagerView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const overall = num(v, 'widthPct', 100);
  const lowMono = num(v, 'lowMonoHz', 120);
  const bands = [
    num(v, 'bandLowPct', 100),
    num(v, 'bandMidLowPct', 100),
    num(v, 'bandMidHighPct', 100),
    num(v, 'bandHighPct', 100),
  ];
  // The imager's own band split, fixed in the engine.
  const edges = [AXIS_MIN_HZ, 120, 800, 5000, AXIS_MAX_HZ];

  const minPct = 0;
  const maxPct = 200;
  const yFor = (pct: number): number => {
    const t = (maxPct - Math.max(minPct, Math.min(maxPct, pct))) / (maxPct - minPct);
    return PAD.top + t * (HEIGHT - PAD.top - PAD.bottom);
  };

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width}>
        <FreqGrid width={props.width} height={HEIGHT} />
        {[0, 50, 100, 150, 200].map((pct) => (
          <g key={pct}>
            <line x1={PAD.left} x2={props.width - PAD.right} y1={yFor(pct)} y2={yFor(pct)}
              stroke={pct === 100 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.05)'} strokeWidth={1} />
            <text x={props.width - PAD.right + 4} y={yFor(pct) + 3}
              fill="rgba(255,255,255,0.32)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {pct}
            </text>
          </g>
        ))}
        {/* Below the fold frequency the sides are summed to the middle. */}
        <rect x={PAD.left} y={PAD.top}
          width={Math.max(0, hzToX(lowMono, props.width) - PAD.left)}
          height={HEIGHT - PAD.top - PAD.bottom}
          fill="rgba(96,165,250,0.12)" />
        <line x1={hzToX(lowMono, props.width)} x2={hzToX(lowMono, props.width)}
          y1={PAD.top} y2={HEIGHT - PAD.bottom}
          stroke="rgba(96,165,250,0.6)" strokeWidth={1} />
        <text x={hzToX(lowMono, props.width) + 4} y={PAD.top + 11}
          fill="rgba(96,165,250,0.9)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          {`↤ ${fmtHz(lowMono)} Hz 아래는 모노`}
        </text>
        {bands.map((pct, i) => {
          const x0 = hzToX(edges[i]!, props.width);
          const x1 = hzToX(edges[i + 1]!, props.width);
          // Overall width multiplies each band's own setting.
          const effective = (pct / 100) * (overall / 100) * 100;
          return (
            <g key={i}>
              <line x1={x0} x2={x1} y1={yFor(effective)} y2={yFor(effective)}
                stroke={meter.accent.foreground} strokeWidth={2.4} />
              <text x={(x0 + x1) / 2} y={yFor(effective) - 6} textAnchor="middle"
                fill={Math.abs(effective - 100) > 1 ? text.secondary : text.disabled}
                style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
                {`${effective.toFixed(0)}%`}
              </text>
            </g>
          );
        })}
      </Box>
      <Caption>
        가운데 줄(100%)이 원본 그대로입니다. 위로 가면 좌우로 넓어지고, 아래로 가면 가운데로 모입니다.
        파란 구간은 좌우를 합쳐 <strong style={{ color: text.tertiary }}>모노로 만드는 저역</strong>입니다 — 저음이 좌우로 흩어지면
        힘이 빠지고 클럽·라디오에서 문제가 생기므로 표준적으로 모아 둡니다.
        전체 폭 {overall.toFixed(0)}% 가 각 대역 설정에 곱해집니다.
      </Caption>
    </Shell>
  );
}

// ── 5. Export ────────────────────────────────────────────────────────────

const FORMAT_KO: Record<string, string> = {
  wav: 'WAV — 무손실, 배포·보관용',
  mp3: 'MP3 — 용량이 작지만 음질이 조금 깎입니다',
  flac: 'FLAC — 무손실 압축',
};

/**
 * What the file will be, and what that decision costs.
 *
 * Export does no processing, so there is nothing to plot. What it has is a
 * consequence: a bit depth below the chain's own resolution throws away
 * information, and dither is the thing that decides whether that shows up
 * as a harsh edge or as a whisper of noise. The display states that as a
 * chain of steps, because the failure mode here is a user shipping 16-bit
 * with dither off and never knowing why the quiet parts sound gritty.
 */
export function ExportView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  metrics: RealtimePreviewMetrics;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const format = str(v, 'format', 'wav');
  const rate = str(v, 'sampleRate', '48000');
  const depth = str(v, 'bitDepth', '24');
  const dither = str(v, 'dither', 'tpdf');
  const autoBlank = boolOf(v, 'ditherAutoBlank', true);
  const depthNum = Number(depth);
  const reduces = Number.isFinite(depthNum) && depthNum < MASTER_NATIVE_BIT_DEPTH;
  const ditherOn = dither !== 'none' && reduces;

  const Step = (p: { label: string; value: string; tone?: 'ok' | 'warn' | 'muted' }) => (
    <div style={{
      flex: '1 1 120px', minWidth: 0,
      padding: space['3'],
      background: surface.panel,
      border: `1px solid ${p.tone === 'warn' ? 'rgba(251,191,36,0.4)' : surface.border}`,
      borderRadius: radius.chip,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{
        fontFamily: typography.family.sans, fontSize: 9,
        color: text.muted, letterSpacing: '0.1em', textTransform: 'uppercase',
      }}>
        {p.label}
      </span>
      <span style={{
        fontFamily: typography.family.mono, fontSize: typography.size.sm,
        color: p.tone === 'warn' ? meter.warn.foreground
          : p.tone === 'ok' ? meter.safe.foreground : text.secondary,
      }}>
        {p.value}
      </span>
    </div>
  );

  return (
    <Shell disabled={props.disabled}>
      <div style={{ display: 'flex', gap: space['2'], flexWrap: 'wrap' }}>
        <Step label="형식 format" value={format.toUpperCase()} />
        <Step label="샘플레이트 rate" value={`${(Number(rate) / 1000).toFixed(1)} kHz`} />
        <Step
          label="비트 심도 depth"
          value={`${depth}-bit`}
          {...(reduces ? { tone: 'warn' as const } : {})}
        />
        <Step
          label="디더 dither"
          value={ditherOn ? dither.toUpperCase() : reduces ? '꺼짐' : '불필요'}
          {...(reduces && !ditherOn ? { tone: 'warn' as const } : ditherOn ? { tone: 'ok' as const } : {})}
        />
      </div>
      <Caption>
        {FORMAT_KO[format] ?? format}
        {'. '}
        {reduces
          ? ditherOn
            ? `내부 ${MASTER_NATIVE_BIT_DEPTH}비트에서 ${depth}비트로 줄이면서 디더를 씁니다 — 줄일 때 생기는 거친 왜곡이 아주 작은 잡음으로 바뀌어 귀에 거슬리지 않습니다.`
              + (autoBlank ? ' 완전한 무음에서는 그 잡음도 끕니다.' : ' 무음 구간에서도 디더 잡음이 계속 나갑니다.')
            : `내부 ${MASTER_NATIVE_BIT_DEPTH}비트에서 ${depth}비트로 줄이는데 디더가 꺼져 있습니다 — 조용한 부분이 거칠게 들릴 수 있습니다. 16비트로 내보낼 때는 켜는 편이 좋습니다.`
          : `${depth}비트는 내부 처리(${MASTER_NATIVE_BIT_DEPTH}비트)보다 낮지 않으므로 버려지는 정보가 없고, 디더도 필요 없습니다.`}
      </Caption>
    </Shell>
  );
}

// ── 6. Delay ─────────────────────────────────────────────────────────────

const TIME_VIEW_MS = 2400;

/** Time ruler shared by the two space modules. */
function TimeGrid(props: { width: number; height: number; spanMs: number }) {
  const ticks = props.spanMs > 1500 ? [0, 500, 1000, 1500, 2000] : [0, 100, 200, 300, 400, 500];
  const xFor = (ms: number) =>
    PAD.left + (ms / props.spanMs) * (props.width - PAD.left - PAD.right);
  return (
    <>
      {ticks.filter((t) => t <= props.spanMs).map((ms) => (
        <g key={ms}>
          <line x1={xFor(ms)} x2={xFor(ms)} y1={PAD.top} y2={props.height - PAD.bottom}
            stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
          <text x={xFor(ms)} y={props.height - 6} textAnchor={ms === 0 ? 'start' : 'middle'}
            fill="rgba(255,255,255,0.38)"
            style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
            {ms === 0 ? '0' : `${ms}ms`}
          </text>
        </g>
      ))}
    </>
  );
}

/**
 * Where the repeats land, and how loud each one is.
 *
 * A delay is a time effect, so the axis is time. Each repeat is drawn at
 * its own arrival and its own level — feedback and the loop's filtering
 * both show up as the stems getting shorter, which is the thing you are
 * actually setting. The two channels are drawn separately, because the
 * stereo offset is what makes this a width tool rather than an echo.
 */
export function DelayView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const mix = num(v, 'mixPct', 0);
  const timeMs = num(v, 'timeMs', 220);
  const offset = num(v, 'stereoOffsetPct', 12);
  const fbPct = num(v, 'feedbackPct', 25);
  const damping = num(v, 'dampingHz', 6000);
  const lowCut = num(v, 'lowCutHz', 300);
  const pingPong = boolOf(v, 'pingPong', false);

  const H = 180;
  const mid = H / 2;
  const rightMs = timeMs * (1 + Math.max(-50, Math.min(50, offset)) / 100);
  const fb = Math.min(0.95, Math.max(0, fbPct / 100));
  const wet = Math.min(1, Math.max(0, mix / 100));
  const xFor = (ms: number) => PAD.left + (ms / TIME_VIEW_MS) * (props.width - PAD.left - PAD.right);

  // Stems until they fall below audibility or leave the window.
  const stems: Array<{ ms: number; level: number; side: 'l' | 'r' }> = [];
  for (let n = 1; n <= 24; n++) {
    const level = wet * Math.pow(fb, n - 1);
    if (level < 0.004) break;
    const lMs = timeMs * n;
    const rMs = rightMs * n;
    // Ping-pong alternates which side each repeat lands on.
    if (lMs <= TIME_VIEW_MS) stems.push({ ms: lMs, level, side: pingPong && n % 2 === 0 ? 'r' : 'l' });
    if (rMs <= TIME_VIEW_MS) stems.push({ ms: rMs, level, side: pingPong && n % 2 === 0 ? 'l' : 'r' });
  }

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width} height={H}>
        <TimeGrid width={props.width} height={H} spanMs={TIME_VIEW_MS} />
        <line x1={PAD.left} x2={props.width - PAD.right} y1={mid} y2={mid}
          stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
        {/* The dry hit, at full height, so the repeats have a reference. */}
        <line x1={xFor(0)} x2={xFor(0)} y1={mid - (mid - PAD.top - 6)} y2={mid}
          stroke="rgba(255,255,255,0.55)" strokeWidth={2} />
        <text x={xFor(0) + 4} y={PAD.top + 10}
          fill="rgba(255,255,255,0.45)"
          style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          원음
        </text>
        {stems.map((st, i) => {
          const h = st.level * (mid - PAD.top - 10);
          const up = st.side === 'l';
          return (
            <line
              key={i}
              x1={xFor(st.ms)} x2={xFor(st.ms)}
              y1={up ? mid - h : mid} y2={up ? mid : mid + h}
              stroke={up ? '#A78BFA' : '#38BDF8'} strokeWidth={2}
            />
          );
        })}
        <text x={props.width - PAD.right - 2} y={PAD.top + 10} textAnchor="end"
          fill="#A78BFA" style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          위 = L
        </text>
        <text x={props.width - PAD.right - 2} y={H - PAD.bottom - 4} textAnchor="end"
          fill="#38BDF8" style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
          아래 = R
        </text>
      </Box>
      <Caption>
        {mix <= 0.001
          ? '섞는 양이 0이라 메아리가 들리지 않습니다 — Mix를 올리면 막대가 나타납니다. '
          : `첫 메아리가 ${timeMs.toFixed(0)} ms(오른쪽은 ${rightMs.toFixed(0)} ms) 뒤에 오고, 반복마다 ${fbPct.toFixed(0)}% 만큼 남습니다. `}
        막대 높이가 그 메아리의 크기입니다.
        {` 반복될 때마다 ${fmtHz(damping)} Hz 위와 ${fmtHz(lowCut)} Hz 아래가 깎여 점점 어둡고 가벼워집니다.`}
        {pingPong ? ' 핑퐁이 켜져 있어 좌우를 번갈아 튑니다.' : ''}
      </Caption>
    </Shell>
  );
}

// ── 7. Reverb ────────────────────────────────────────────────────────────

/**
 * The tail's shape in time — pre-delay, then a decay set by size.
 *
 * The envelope is drawn from the same numbers the engine derives its comb
 * feedback from, so a longer size visibly stretches the tail. It is an
 * envelope, not a measured impulse response: the label says "shape", and
 * what it is honestly for is seeing where the tail starts and roughly how
 * long it lasts, which are the two decisions this module asks for.
 */
export function ReverbView(props: {
  values: Record<string, ParameterValue>;
  width: number;
  disabled?: boolean | undefined;
}) {
  const v = props.values;
  const mix = num(v, 'mixPct', 0);
  const size = num(v, 'sizePct', 55);
  const damping = num(v, 'dampingPct', 50);
  const width = num(v, 'widthPct', 100);
  const pre = num(v, 'preDelayMs', 20);
  const lowCut = num(v, 'lowCutHz', 250);

  const H = 180;
  const base = H - PAD.bottom;
  const xFor = (ms: number) => PAD.left + (ms / TIME_VIEW_MS) * (props.width - PAD.left - PAD.right);

  // Comb feedback → decay, mirroring `Reverb::set_config`.
  const feedback = Math.min(0.98, 0.70 + Math.min(1, Math.max(0, size / 100)) * 0.28);
  // Roughly how long the tail takes to fall 60 dB, from that feedback and
  // the mean comb length.  Approximate, and labelled as such.
  const meanCombMs = 1350 / 44.1;
  const rt60Ms = feedback >= 1 ? TIME_VIEW_MS
    : (Math.log(0.001) / Math.log(feedback)) * meanCombMs;
  const wet = Math.min(1, Math.max(0, mix / 100));

  const path = React.useMemo(() => {
    const pts = 220;
    let d = `M${xFor(0).toFixed(1)},${base.toFixed(1)}`;
    for (let i = 0; i <= pts; i++) {
      const ms = (i / pts) * TIME_VIEW_MS;
      const t = ms - pre;
      // Damping shortens the audible tail as well as darkening it.
      const shorten = 1 - (Math.min(100, Math.max(0, damping)) / 100) * 0.45;
      const amp = t <= 0 ? 0 : wet * Math.exp((-6.9 * t) / Math.max(1, rt60Ms * shorten));
      d += `L${xFor(ms).toFixed(1)},${(base - amp * (base - PAD.top - 10)).toFixed(1)}`;
    }
    return `${d}L${xFor(TIME_VIEW_MS).toFixed(1)},${base.toFixed(1)}Z`;
  }, [pre, rt60Ms, damping, wet, props.width]);

  return (
    <Shell disabled={props.disabled}>
      <Box width={props.width} height={H}>
        <TimeGrid width={props.width} height={H} spanMs={TIME_VIEW_MS} />
        <line x1={PAD.left} x2={props.width - PAD.right} y1={base} y2={base}
          stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
        {/* The dry hit and the gap before the tail. */}
        <line x1={xFor(0)} x2={xFor(0)} y1={PAD.top + 6} y2={base}
          stroke="rgba(255,255,255,0.55)" strokeWidth={2} />
        {pre > 0.5 && (
          <>
            <rect x={xFor(0)} y={PAD.top} width={Math.max(0, xFor(pre) - xFor(0))}
              height={base - PAD.top} fill="rgba(255,255,255,0.04)" />
            <text x={xFor(pre) + 4} y={PAD.top + 11}
              fill="rgba(255,255,255,0.40)"
              style={{ fontFamily: typography.family.mono, fontSize: 9 }}>
              {`시작 지연 ${pre.toFixed(0)} ms`}
            </text>
          </>
        )}
        <path d={path} fill="rgba(167,139,250,0.22)" stroke="#A78BFA" strokeWidth={1.6} />
      </Box>
      <Caption>
        {mix <= 0.001
          ? '섞는 양이 0이라 울림이 들리지 않습니다 — Mix를 올리면 꼬리가 나타납니다. '
          : `원음 뒤 ${pre.toFixed(0)} ms 부터 울림이 시작해 대략 ${(rt60Ms / 1000).toFixed(1)}초에 걸쳐 사라집니다. `}
        {`공간 크기 ${size.toFixed(0)}% · 고역 감쇠 ${damping.toFixed(0)}% · 울림 폭 ${width.toFixed(0)}% · ${fmtHz(lowCut)} Hz 아래는 울리지 않습니다. `}
        이 곡선은 <strong style={{ color: text.tertiary }}>꼬리의 대략적인 모양</strong>이며, 측정된 임펄스 응답이 아닙니다.
      </Caption>
    </Shell>
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export const CHARACTER_VIEW_MODULES = new Set([
  'declick', 'exciter', 'tape', 'imager', 'export', 'delay', 'reverb',
]);

export function CharacterView(props: {
  moduleId: string;
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

  const common = { values: props.values, width, disabled: props.disabled };
  let body: React.ReactNode = null;
  switch (props.moduleId) {
    case 'declick': body = <DeclickView {...common} />; break;
    case 'exciter': body = <ExciterView {...common} />; break;
    case 'tape': body = <TapeView {...common} />; break;
    case 'imager': body = <ImagerView {...common} />; break;
    case 'delay': body = <DelayView {...common} />; break;
    case 'reverb': body = <ReverbView {...common} />; break;
    case 'export': body = <ExportView {...common} metrics={props.metrics} />; break;
    default: break;
  }
  return <div ref={wrapRef}>{body}</div>;
}
