// DraggableParametricEqEditor — free parametric EQ overlay (Phase 1).
//
// Renders an SVG curve + draggable dots over the spectrum canvas.
// Interactions:
//   • Click on empty area      → add a new bell band at that freq/gain
//   • Drag a dot               → adjust frequency (x) + gain (y)
//   • Shift+drag a dot         → adjust Q only (vertical = wider/narrower)
//   • Wheel on a dot           → adjust Q (visible bandwidth widens/narrows)
//   • Right-click a dot        → delete the band
//   • Double-click a dot       → cycle filter type (bell → lowshelf → highshelf → highpass → lowpass → bell)
//
// Phase 1: pure visualization — the curve and dots reflect the band list
// but the audible audio is NOT affected.  The Phase 2 commit will wire
// the bands into the native DSP via dynamic BiquadFilter nodes.

import React, { useRef } from 'react';
import {
  type ParametricEqBand,
  type ParametricBandType,
  parametricEqCurveDb,
  bandPointDb,
  defaultBand,
  clampFrequency,
  clampGainDb,
  clampQ,
  MIN_FREQ_HZ,
  MAX_FREQ_HZ,
  MAX_BANDS,
} from '../../../audio/modules/parametric-eq-model.js';
import { text, typography } from '../../../theme/loui-theme.js';

export interface DraggableParametricEqEditorProps {
  width: number;
  height: number;
  bands: ParametricEqBand[];
  sampleRate?: number;
  dbRange?: number;
  onChange: (bands: ParametricEqBand[]) => void;
  /** When true, hide the curve dots (read-only display).  Defaults to false. */
  readOnly?: boolean;
}

const TYPE_COLORS: Record<ParametricBandType, string> = {
  highpass:  '#60A5FA',
  lowshelf:  '#FBBF24',
  bell:      '#A78BFA',
  highshelf: '#22D3EE',
  lowpass:   '#F87171',
};

const TYPE_LABEL: Record<ParametricBandType, string> = {
  highpass:  'HP',
  lowshelf:  'LS',
  bell:      'PK',
  highshelf: 'HS',
  lowpass:   'LP',
};

const TYPE_CYCLE: ParametricBandType[] = ['bell', 'lowshelf', 'highshelf', 'highpass', 'lowpass'];

function freqToX(f: number, width: number): number {
  const logMin = Math.log10(MIN_FREQ_HZ);
  const logMax = Math.log10(MAX_FREQ_HZ);
  const t = (Math.log10(Math.max(MIN_FREQ_HZ, Math.min(MAX_FREQ_HZ, f))) - logMin) / (logMax - logMin);
  return t * width;
}
function xToFreq(x: number, width: number): number {
  const logMin = Math.log10(MIN_FREQ_HZ);
  const logMax = Math.log10(MAX_FREQ_HZ);
  const t = Math.max(0, Math.min(1, x / Math.max(1, width)));
  return Math.pow(10, logMin + t * (logMax - logMin));
}
function gainToY(db: number, height: number, dbRange: number): number {
  // Centre = 0 dB, top = +dbRange, bottom = -dbRange.
  const t = (db + dbRange) / (2 * dbRange);
  return height - t * height;
}
function yToGain(y: number, height: number, dbRange: number): number {
  const t = Math.max(0, Math.min(1, (height - y) / Math.max(1, height)));
  return -dbRange + t * 2 * dbRange;
}

interface DragState {
  bandId: string;
  /** When true, vertical movement adjusts Q instead of gain (Shift+drag). */
  qOnly: boolean;
  /** Starting Q for Q-only drag, so we have a stable reference. */
  startQ: number;
  startY: number;
}

export function DraggableParametricEqEditor(props: DraggableParametricEqEditorProps) {
  const { width, height, bands, sampleRate = 48000, dbRange = 18, onChange } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  if (width <= 0 || height <= 0) return null;

  // Build the curve path (110 samples, log-frequency).
  const steps = 130;
  let curveD = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = Math.pow(10, Math.log10(MIN_FREQ_HZ) + t * (Math.log10(MAX_FREQ_HZ) - Math.log10(MIN_FREQ_HZ)));
    const x = (t * width);
    const dbVal = parametricEqCurveDb(bands, f, sampleRate);
    const y = Math.max(2, Math.min(height - 2, gainToY(dbVal, height, dbRange)));
    curveD += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }

  function localXY(e: React.MouseEvent | React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function commit(next: ParametricEqBand[]) {
    onChange(next);
  }

  function onDotPointerDown(e: React.PointerEvent<SVGCircleElement>, band: ParametricEqBand) {
    e.stopPropagation();
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const { y } = localXY(e);
    dragRef.current = { bandId: band.id, qOnly: e.shiftKey, startQ: band.q, startY: y };
  }

  function onSvgPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localXY(e);
    const next = bands.map((b) => {
      if (b.id !== drag.bandId) return b;
      if (drag.qOnly) {
        // Vertical movement maps to Q: up = wider (lower Q), down = narrower (higher Q).
        const dy = y - drag.startY;
        const factor = Math.pow(2, dy / 60);
        return { ...b, q: clampQ(drag.startQ * factor) };
      }
      const nextFreq = clampFrequency(xToFreq(x, width));
      const nextGain = (b.type === 'highpass' || b.type === 'lowpass')
        ? 0  // cut/pass filters ignore gain
        : clampGainDb(yToGain(y, height, dbRange));
      return { ...b, frequencyHz: nextFreq, gainDb: nextGain };
    });
    commit(next);
  }

  function onSvgPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { (e.target as Element).releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }

  function onSvgClick(e: React.MouseEvent<SVGSVGElement>) {
    // Click on empty area = add a band.  Dot clicks bubble-stop via onDotPointerDown.
    if (props.readOnly) return;
    if (bands.length >= MAX_BANDS) return;
    if ((e.target as Element).tagName === 'circle') return;
    const { x, y } = localXY(e);
    const freq = clampFrequency(xToFreq(x, width));
    const gain = clampGainDb(yToGain(y, height, dbRange));
    const newBand = defaultBand(freq, gain);
    commit([...bands, newBand]);
  }

  function onDotContextMenu(e: React.MouseEvent<SVGCircleElement>, band: ParametricEqBand) {
    e.preventDefault();
    e.stopPropagation();
    commit(bands.filter((b) => b.id !== band.id));
  }

  function onDotWheel(e: React.WheelEvent<SVGCircleElement>, band: ParametricEqBand) {
    e.preventDefault();
    e.stopPropagation();
    const factor = Math.pow(2, e.deltaY / 200);
    const next = bands.map((b) => b.id === band.id ? { ...b, q: clampQ(b.q * factor) } : b);
    commit(next);
  }

  function onDotDoubleClick(e: React.MouseEvent<SVGCircleElement>, band: ParametricEqBand) {
    e.stopPropagation();
    const idx = TYPE_CYCLE.indexOf(band.type);
    const nextType = TYPE_CYCLE[(idx + 1) % TYPE_CYCLE.length]!;
    const next = bands.map((b) => b.id === band.id ? { ...b, type: nextType } : b);
    commit(next);
  }

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      onClick={onSvgClick}
      onPointerMove={onSvgPointerMove}
      onPointerUp={onSvgPointerUp}
      onPointerCancel={onSvgPointerUp}
      style={{ position: 'absolute', inset: 0, cursor: bands.length < MAX_BANDS ? 'crosshair' : 'default' }}
    >
      {/* 0 dB centre line */}
      <line
        x1={0} x2={width} y1={height / 2} y2={height / 2}
        stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3"
      />
      {/* Curve */}
      <path
        d={curveD}
        fill="none"
        stroke="rgba(167,139,250,0.9)"
        strokeWidth={1.5}
        pointerEvents="none"
      />
      {/* Band dots */}
      {bands.map((b) => {
        const cx = freqToX(b.frequencyHz, width);
        const cy = (b.type === 'highpass' || b.type === 'lowpass')
          ? gainToY(0, height, dbRange) // cut/pass: anchor on 0 dB line
          : gainToY(bandPointDb(b, bands, sampleRate), height, dbRange);
        const color = TYPE_COLORS[b.type];
        const opacity = b.enabled ? 1 : 0.4;
        // Q-visualization ring radius (bigger = wider Q).
        const ring = Math.max(6, Math.min(28, 28 / Math.sqrt(b.q)));
        return (
          <g key={b.id} style={{ opacity }}>
            <circle
              cx={cx} cy={cy} r={ring}
              fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={1}
              pointerEvents="none"
            />
            <circle
              cx={cx} cy={cy} r={6}
              fill={color}
              stroke="#0c1014" strokeWidth={1}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => onDotPointerDown(e, b)}
              onContextMenu={(e) => onDotContextMenu(e, b)}
              onWheel={(e) => onDotWheel(e, b)}
              onDoubleClick={(e) => onDotDoubleClick(e, b)}
            >
              <title>
                {`${TYPE_LABEL[b.type]} @ ${Math.round(b.frequencyHz)} Hz · ${b.gainDb >= 0 ? '+' : ''}${b.gainDb.toFixed(1)} dB · Q ${b.q.toFixed(2)}\n드래그=주파수/게인, Shift+드래그=Q, 휠=Q, 더블클릭=타입, 우클릭=삭제`}
              </title>
            </circle>
            <text
              x={cx} y={cy - ring - 4}
              fontFamily={typography.family.mono} fontSize={9}
              fill={color} textAnchor="middle"
              pointerEvents="none"
            >
              {TYPE_LABEL[b.type]}
            </text>
          </g>
        );
      })}
      {/* Empty-state hint */}
      {bands.length === 0 && (
        <text
          x={width / 2} y={height / 2 - 8}
          fontFamily={typography.family.sans} fontSize={11}
          fill={text.muted} textAnchor="middle"
          pointerEvents="none"
        >
          스펙트럼 위 빈 곳을 클릭해 EQ 밴드를 추가하세요
        </text>
      )}
      {/* Out-of-bounds bands counter */}
      {bands.length >= MAX_BANDS && (
        <text
          x={width - 6} y={12}
          fontFamily={typography.family.mono} fontSize={9}
          fill={text.muted} textAnchor="end"
          pointerEvents="none"
        >
          {bands.length}/{MAX_BANDS}
        </text>
      )}
    </svg>
  );
}
