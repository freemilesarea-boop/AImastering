// The analyser you open, rather than the one behind an EQ curve.
//
// The same arithmetic draws the backdrop in `EqCurveEditor`, and this is not
// that picture made bigger.  Behind a curve the question is "what is that
// whistle" and the answer is the fast line with its hold.  Opened on its own
// the question is "is this balanced", and answering it needs two more things:
//
//   · the AVERAGE, converging over seconds rather than following the moment.
//     It is the line a mix is judged against, and it is also exactly what the
//     match EQ compares when it takes a reference.
//   · the GONIOMETER, because two mixes with identical spectra can be
//     mono-compatible and unlistenable respectively, and no magnitude display
//     separates them.  Vertical is mono, round is wide, horizontal will
//     vanish the moment anything sums it.
//
// The maths is in `analyzer-view.ts`, including the one that is easy to get
// wrong: the average is taken in POWER, not in decibels.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInsertSpectrum } from '../../../hooks/useInsertSpectrum.js';
import { useInsertScope } from '../../../hooks/useInsertScope.js';
import {
  DEFAULT_SCALE, SPECTRUM_SLOPES, dbToY,
} from '../../../daw/model/spectrum-view.js';
import {
  averageSeconds, correlationNote, peakBand,
} from '../../../daw/model/analyzer-view.js';
import { premium } from '../../../theme/premium.js';
import type { TrackId } from '../../../daw/model/types.js';

const GRID = 'rgba(255,255,255,0.06)';
const LABEL = 'rgba(210,210,220,0.55)';

export interface AnalyzerViewProps {
  trackId: TrackId;
  insertId: string | null;
  params: Record<string, number>;
  bypassed: boolean;
  playing: boolean;
  width: number;
  height: number;
}

const TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];

export function AnalyzerView(props: AnalyzerViewProps): React.ReactElement {
  const { trackId, insertId, params, bypassed, playing, width, height } = props;
  const slopeIndex = Math.round(params['slope'] ?? 2);
  const slope = SPECTRUM_SLOPES[Math.max(0, Math.min(SPECTRUM_SLOPES.length - 1, slopeIndex))] ?? 4.5;
  const tau = averageSeconds(params['average'] ?? 1);
  const showHold = (params['hold'] ?? 1) >= 0.5;
  const showScope = (params['scope'] ?? 1) >= 0.5;

  const scopeSide = showScope ? Math.min(Math.round(height * 0.9), 132) : 0;
  const plotWidth = Math.max(1, Math.round(width - scopeSide - (showScope ? 10 : 0)));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const [readout, setReadout] = useState('');

  const { frame, onFrame } = useInsertSpectrum({
    trackId, insertId, columns: plotWidth, enabled: playing,
    slopeDbPerOct: slope, averageTauSec: tau,
  });
  const scope = useInsertScope({ trackId, insertId, enabled: playing && showScope });

  const drawRef = useRef<() => void>(() => {});

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(plotWidth * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotWidth, height);

    const scale = DEFAULT_SCALE;
    const xOf = (hz: number): number =>
      (Math.log(hz / scale.minHz) / Math.log(scale.maxHz / scale.minHz)) * plotWidth;

    ctx.font = '9px ui-monospace, monospace';
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const hz of TICKS) {
      const x = Math.round(xOf(hz)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, height - 4);
    }
    for (let db = scale.topDb; db > scale.bottomDb; db -= 12) {
      const y = Math.round(dbToY(db, height, scale)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(`${db}`, 2, y - 2);
    }

    const f = frame.current;
    if (!f.live) {
      ctx.fillStyle = LABEL;
      ctx.fillText('재생하면 측정합니다', 8, 16);
      return;
    }

    const line = (data: Float32Array, colour: string, lineWidth: number, fill: boolean): void => {
      ctx.beginPath();
      for (let x = 0; x < data.length; x++) {
        const y = dbToY(data[x] ?? scale.bottomDb, height, scale);
        if (x === 0) ctx.moveTo(0, y); else ctx.lineTo(x, y);
      }
      if (fill) {
        ctx.lineTo(plotWidth, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = colour;
        ctx.fill();
        return;
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    };

    const dim = bypassed;
    line(f.display, dim ? 'rgba(140,140,160,0.10)' : 'rgba(230,210,160,0.12)', 1, true);
    if (showHold) line(f.hold, 'rgba(126,200,255,0.40)', 1, false);
    line(f.display, dim ? 'rgba(140,140,160,0.5)' : premium.accent.base, 1.5, false);
    // The average last, and thickest: it is the line the mix is judged on.
    line(f.average, dim ? 'rgba(140,140,160,0.7)' : 'rgba(255,255,255,0.85)', 2, false);

    const peak = peakBand(f.average, scale);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(peak.column + 0.5, 0);
    ctx.lineTo(peak.column + 0.5, height);
    ctx.stroke();

    const hz = peak.hz >= 1000 ? `${(peak.hz / 1000).toFixed(1)} kHz` : `${Math.round(peak.hz)} Hz`;
    setReadout(`평균 최고 ${hz} · ${peak.db.toFixed(1)} dB`);
  }, [frame, plotWidth, height, bypassed, showHold]);

  const drawScope = useCallback(() => {
    const canvas = scopeRef.current;
    if (!canvas || !showScope) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(scopeSide * dpr));
    canvas.height = Math.max(1, Math.floor(scopeSide * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, scopeSide, scopeSide);

    const half = scopeSide / 2;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(half + 0.5, 0); ctx.lineTo(half + 0.5, scopeSide);
    ctx.moveTo(0, half + 0.5); ctx.lineTo(scopeSide, half + 0.5);
    ctx.stroke();
    // The two diagonals are where a single channel alone lands: everything
    // in the left channel only runs up one of them, and that is worth a line
    // because "all of this is on one side" is a thing to be able to see.
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(scopeSide, scopeSide);
    ctx.moveTo(scopeSide, 0); ctx.lineTo(0, scopeSide);
    ctx.stroke();

    const f = scope.frame.current;
    if (!f.live) return;
    ctx.fillStyle = bypassed ? 'rgba(140,140,160,0.5)' : premium.accent.base;
    for (let p = 0; p < f.count; p++) {
      const x = half + (f.points[p * 2] ?? 0) * half;
      const y = half - (f.points[p * 2 + 1] ?? 0) * half;
      ctx.fillRect(x, y, 1.2, 1.2);
    }
  }, [scope.frame, scopeSide, showScope, bypassed]);

  drawRef.current = (): void => { draw(); drawScope(); };

  useEffect(() => {
    onFrame(() => drawRef.current());
    scope.onFrame(() => drawRef.current());
    drawRef.current();
    return () => { onFrame(null); scope.onFrame(null); };
  }, [onFrame, scope]);

  useEffect(() => { drawRef.current(); }, [slope, tau, showHold, showScope, bypassed]);

  const reading = scope.frame.current.reading;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2.5 items-start">
        <canvas
          ref={canvasRef}
          style={{ width: plotWidth, height, display: 'block', borderRadius: 6 }}
        />
        {showScope && (
          <canvas
            ref={scopeRef}
            style={{ width: scopeSide, height: scopeSide, display: 'block', borderRadius: 6 }}
          />
        )}
      </div>
      <div
        className="flex items-center justify-between text-[9px] font-mono"
        style={{ color: premium.text.faint }}
      >
        <span>{readout || `${slope} dB/oct · 평균 ${tau}초`}</span>
        {showScope && (
          <span>
            {`상관 ${reading.correlation.toFixed(2)} · 폭 ${Math.round(reading.widthPct)}% · `}
            {correlationNote(reading.correlation)}
          </span>
        )}
      </div>
    </div>
  );
}

export default AnalyzerView;
