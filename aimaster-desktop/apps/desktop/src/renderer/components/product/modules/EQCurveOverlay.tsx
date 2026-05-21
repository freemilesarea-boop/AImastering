// EQCurveOverlay — precise EQ response curve + active band dots
// (OZONE-MODULE-NEXT-2).
//
// Uses `eq-curve-model.ts` (RBJ-cookbook magnitudes matching the real Rust
// preview EQ band layout) to draw the tone curve over the spectrum, plus a
// FabFilter/Ozone-style point per band (Low Cut / Low Shelf / Presence /
// Air / Output) with value labels.  Still a *visualization* (overlays a
// dBFS spectrum, omits the adaptive harshness dip) — labelled "approximate"
// in the UI.  No DSP / audio change.

import React from 'react';
import { loui, louiAlpha } from '../../../theme/loui-home.js';
import {
  buildEqCurveModel, eqCurveDb, bandPointDb,
  type BandModel,
} from '../../../audio/modules/eq-curve-model.js';

export interface EqBands {
  lowCutHz: number;
  lowShelfDb: number;
  presenceDb: number;
  airDb: number;
  outputGainDb: number;
}

export interface EQCurveOverlayProps {
  width: number;
  height: number;
  bands: EqBands;
  sampleRate?: number;
  minHz?: number;
  maxHz?: number;
  dbRange?: number;
  bypassed?: boolean;
  /** Highlight a band (e.g. the open EQ panel band). */
  selectedBandId?: string;
  /** Click a band dot. */
  onSelectBand?: (id: string) => void;
  /** Force value labels on/off (default: shown when width ≥ 460). */
  showLabels?: boolean;
}

const logF = (f: number, min: number, max: number) =>
  (Math.log10(f) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));

const WARN_GAIN_DB = 4;

function fmtBandLabel(b: BandModel): string {
  if (b.id === 'lowCut') return `${Math.round(b.frequency)} Hz`;
  const g = b.gainDb >= 0 ? `+${b.gainDb.toFixed(1)}` : b.gainDb.toFixed(1);
  return `${b.label} ${g}`;
}

export function EQCurveOverlay({
  width, height, bands, sampleRate = 48000,
  minHz = 20, maxHz = 20000, dbRange = 12, bypassed = false,
  selectedBandId, onSelectBand, showLabels,
}: EQCurveOverlayProps) {
  if (width <= 0 || height <= 0) return null;
  const model = buildEqCurveModel(bands, bypassed, sampleRate);
  const labelsOn = showLabels ?? width >= 460;
  const dbToY = (db: number) => Math.max(3, Math.min(height - 3, height / 2 - (db / dbRange) * (height / 2)));

  // Curve path.
  const steps = 110;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = Math.pow(10, Math.log10(minHz) + t * (Math.log10(maxHz) - Math.log10(minHz)));
    const x = logF(f, minHz, maxHz) * width;
    const y = dbToY(eqCurveDb(f, model));
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }

  const hot = !bypassed && model.outputGainDb >= WARN_GAIN_DB;
  const curveStroke = bypassed ? louiAlpha.lav(0.22) : hot ? loui.warningAmber : loui.primaryLavender;

  // Curve fill (subtle, only when active).
  const fillD = bypassed ? '' : `${d}L${width},${dbToY(0)} L0,${dbToY(0)} Z`;

  const freqBands = model.bands.filter((b) => b.type !== 'output');
  const outputBand = model.bands.find((b) => b.id === 'output');

  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
      {/* 0 dB reference */}
      <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.10)" strokeWidth={1} strokeDasharray="3 4" />

      {!bypassed && (
        <path d={fillD} fill={louiAlpha.lav(0.06)} stroke="none" />
      )}
      <path d={d} fill="none" stroke={curveStroke} strokeWidth={2} strokeLinejoin="round" />

      {/* Output gain indicator — a tick + label on the right edge. */}
      {outputBand && outputBand.enabled && !bypassed && (
        <g>
          <line x1={width - 10} y1={dbToY(model.outputGainDb)} x2={width} y2={dbToY(model.outputGainDb)} stroke={outputBand.color} strokeWidth={2} />
          {labelsOn && (
            <text x={width - 12} y={dbToY(model.outputGainDb) - 4} textAnchor="end"
                  fill={outputBand.color} fontSize={10} fontFamily="ui-monospace">
              {fmtBandLabel(outputBand)}
            </text>
          )}
        </g>
      )}

      {/* Band dots. */}
      {freqBands.map((b) => {
        const x = logF(Math.max(minHz, Math.min(maxHz, b.frequency)), minHz, maxHz) * width;
        const y = dbToY(bandPointDb(b, model));
        const selected = b.id === selectedBandId;
        const dim = bypassed || !b.enabled;
        const r = selected ? 6 : 4.5;
        return (
          <g key={b.id} style={{ pointerEvents: onSelectBand ? 'auto' : 'none', cursor: onSelectBand ? 'pointer' : 'default' }}
             onClick={onSelectBand ? () => onSelectBand(b.id) : undefined}>
            {selected && !dim && <circle cx={x} cy={y} r={r + 4} fill="none" stroke={b.color} strokeWidth={1} opacity={0.5} />}
            <circle
              cx={x} cy={y} r={r}
              fill={dim ? 'rgba(255,255,255,0.10)' : b.color}
              stroke={dim ? 'rgba(255,255,255,0.20)' : '#0E0E14'}
              strokeWidth={1}
              style={dim ? {} : { filter: `drop-shadow(0 0 5px ${b.color})` }}
            />
            {labelsOn && b.enabled && !bypassed && (
              <text x={x} y={y - 9} textAnchor="middle" fill={b.color} fontSize={10} fontFamily="ui-monospace">
                {fmtBandLabel(b)}
              </text>
            )}
          </g>
        );
      })}

      {/* Approximate / bypass note */}
      <text x={8} y={14} fill={bypassed ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.34)'} fontSize={9} fontFamily="ui-monospace">
        {bypassed ? 'EQ bypassed' : 'EQ curve · approximate'}
      </text>
    </svg>
  );
}
