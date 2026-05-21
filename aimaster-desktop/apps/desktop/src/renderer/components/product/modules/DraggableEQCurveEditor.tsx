// DraggableEQCurveEditor — interactive EQ curve (OZONE-MODULE-NEXT-5).
//
// The read-only EQCurveOverlay made draggable: grab a band point and move
// it (Low Cut = horizontal frequency; Low Shelf / Presence / Air = vertical
// gain; Output = vertical gain on the right edge).  Each move emits a
// clamped/quantised parameter value via `onChange`, which the caller writes
// to the parameter state — that flows LIVE to the Rust chain via the
// existing rAF → updateConfig path (no fake audio).  Curve uses the exact
// RBJ model (eq-curve-model); labelled "approximate".
//
// 1차: frequency + gain (no Q).  Double-click a point = reset.  Arrow keys
// nudge the focused band.

import React, { useRef, useState } from 'react';
import { loui, louiAlpha } from '../../../theme/loui-home.js';
import {
  buildEqCurveModel, eqCurveDb, bandPointDb, type BandModel,
} from '../../../audio/modules/eq-curve-model.js';
import {
  EQ_BAND_DRAG, dragToValue, freqToX, gainToY, type EqBandId, type EqGeom,
} from '../../../audio/modules/eq-drag-model.js';
import type { EqBands } from './EQCurveOverlay.js';

export interface DraggableEQCurveEditorProps {
  width: number;
  height: number;
  bands: EqBands;
  sampleRate?: number;
  minHz?: number;
  maxHz?: number;
  dbRange?: number;
  bypassed?: boolean;
  /** Fired continuously during drag / keyboard nudge with a clamped value. */
  onChange?: (paramId: string, value: number) => void;
  /** Optional reset for a band (double-click) — defaults to onChange(default). */
  onReset?: (paramId: string, value: number) => void;
  showLabels?: boolean;
}

const DRAG_BANDS: EqBandId[] = ['lowCut', 'lowShelf', 'presence', 'air', 'output'];

function fmt(bandId: EqBandId, value: number): string {
  if (bandId === 'lowCut') return `${Math.round(value)} Hz`;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

export function DraggableEQCurveEditor(props: DraggableEQCurveEditorProps) {
  const { width, height, bands, sampleRate = 48000, minHz = 20, maxHz = 20000, dbRange = 12, bypassed = false } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<EqBandId | null>(null);
  const [hover, setHover] = useState<EqBandId | null>(null);

  if (width <= 0 || height <= 0) return null;
  const geom: EqGeom = { width, height, minHz, maxHz, dbRange };
  const model = buildEqCurveModel(bands, bypassed, sampleRate);
  const labelsOn = props.showLabels ?? width >= 460;

  // Curve path.
  const steps = 110;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = Math.pow(10, Math.log10(minHz) + t * (Math.log10(maxHz) - Math.log10(minHz)));
    const x = freqToX(f, geom);
    const y = Math.max(3, Math.min(height - 3, gainGuard(eqCurveDb(f, model), geom)));
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }

  function valueFor(bandId: EqBandId): number {
    switch (bandId) {
      case 'lowCut': return bands.lowCutHz;
      case 'lowShelf': return bands.lowShelfDb;
      case 'presence': return bands.presenceDb;
      case 'air': return bands.airDb;
      case 'output': return bands.outputGainDb;
    }
  }

  function dotXY(bandId: EqBandId): { x: number; y: number } {
    const spec = EQ_BAND_DRAG[bandId];
    if (bandId === 'output') {
      return { x: width - 8, y: clampY(gainToY(bands.outputGainDb, geom)) };
    }
    const fx = spec.fixedFreq ?? bands.lowCutHz;
    const bandModel: BandModel | undefined = model.bands.find((b) => idFor(b.id) === bandId);
    const yDb = bandModel ? bandPointDb(bandModel, model) : eqCurveDb(fx, model);
    return { x: freqToX(bandId === 'lowCut' ? Math.max(minHz, Math.min(maxHz, bands.lowCutHz)) : fx, geom), y: clampY(gainGuard(yDb, geom)) };
  }
  function clampY(y: number): number { return Math.max(4, Math.min(height - 4, y)); }

  // ── Drag handling (window listeners while a band is grabbed) ──────────
  function beginDrag(bandId: EqBandId, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (bypassed) return;
    setActive(bandId);
    const move = (ev: PointerEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const r = dragToValue(bandId, px, py, geom);
      props.onChange?.(r.paramId, r.value);
    };
    const up = () => {
      setActive(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resetBand(bandId: EqBandId) {
    const spec = EQ_BAND_DRAG[bandId];
    (props.onReset ?? props.onChange)?.(spec.paramId, spec.defaultValue);
  }

  function keyNudge(bandId: EqBandId, e: React.KeyboardEvent) {
    const spec = EQ_BAND_DRAG[bandId];
    let delta = 0;
    if (spec.axis === 'y') { if (e.key === 'ArrowUp') delta = spec.step; else if (e.key === 'ArrowDown') delta = -spec.step; }
    else { if (e.key === 'ArrowRight') delta = spec.step; else if (e.key === 'ArrowLeft') delta = -spec.step; }
    if (delta === 0) return;
    e.preventDefault();
    const cur = valueFor(bandId);
    const next = Math.max(spec.min, Math.min(spec.max, Math.round((cur + delta) / spec.step) * spec.step));
    props.onChange?.(spec.paramId, next);
  }

  return (
    <svg ref={svgRef} width={width} height={height} style={{ position: 'absolute', inset: 0, touchAction: 'none', pointerEvents: 'none' }}>
      <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.10)" strokeWidth={1} strokeDasharray="3 4" />
      {!bypassed && <path d={`${d}L${width},${gainToY(0, geom)} L0,${gainToY(0, geom)} Z`} fill={louiAlpha.lav(0.06)} />}
      <path d={d} fill="none" stroke={bypassed ? louiAlpha.lav(0.22) : loui.primaryLavender} strokeWidth={2} strokeLinejoin="round" />

      {DRAG_BANDS.map((bandId) => {
        const b = model.bands.find((x) => idFor(x.id) === bandId)!;
        const { x, y } = dotXY(bandId);
        const isActive = active === bandId;
        const isHover = hover === bandId;
        const r = isActive ? 7 : isHover ? 6 : 5;
        return (
          <g key={bandId} style={{ pointerEvents: bypassed ? 'none' : 'all', cursor: bypassed ? 'default' : (EQ_BAND_DRAG[bandId].axis === 'x' ? 'ew-resize' : 'ns-resize') }}>
            {/* Larger invisible hit target */}
            <circle cx={x} cy={y} r={14} fill="transparent"
              tabIndex={bypassed ? -1 : 0}
              onPointerDown={(e) => beginDrag(bandId, e)}
              onDoubleClick={() => resetBand(bandId)}
              onMouseEnter={() => setHover(bandId)}
              onMouseLeave={() => setHover((h) => (h === bandId ? null : h))}
              onKeyDown={(e) => keyNudge(bandId, e)}
            />
            <circle cx={x} cy={y} r={r}
              fill={bypassed ? 'rgba(255,255,255,0.10)' : b.color}
              stroke="#0E0E14" strokeWidth={1}
              style={bypassed ? {} : { filter: `drop-shadow(0 0 ${isActive ? 7 : 4}px ${b.color})` }}
            />
            {(isActive || (isHover && labelsOn)) && !bypassed && (
              <g pointerEvents="none">
                <rect x={x - 26} y={y - 26} width={52} height={15} rx={3} fill="rgba(0,0,0,0.6)" />
                <text x={x} y={y - 15} textAnchor="middle" fill="#fff" fontSize={10} fontFamily="ui-monospace">
                  {fmt(bandId, valueFor(bandId))}
                </text>
              </g>
            )}
          </g>
        );
      })}

      <text x={8} y={14} pointerEvents="none" fill="rgba(255,255,255,0.34)" fontSize={9} fontFamily="ui-monospace">
        {bypassed ? 'EQ bypassed' : 'EQ · drag points · approximate'}
      </text>
    </svg>
  );
}

// Map the curve model's band id (lowCut/lowShelf/presence/air/output) to the
// drag band id (identical strings) — helper to keep types narrow.
function idFor(modelId: BandModel['id']): EqBandId { return modelId; }
function gainGuard(db: number, g: EqGeom): number { return gainToY(Number.isFinite(db) ? db : 0, g); }
