// LouiMasteringVisualizer — the central modular-mastering display
// (OZONE-STYLE-MODULE-SUITE).
//
// Composes the DPR-aware spectrum canvas with the approximate EQ-curve
// overlay in a resize-safe container.  Data is fed via props (the
// analyzer session's FFT frames at ≤30 Hz + the current EQ bands), so the
// component never free-runs a RAF — redraw cost is bounded by the data
// cadence.  See VISUAL_PERFORMANCE_REPORT.md.

import React, { useLayoutEffect, useRef, useState } from 'react';
import { surface, text, typography } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';
import { SpectrumWaveformCanvas } from './SpectrumWaveformCanvas.js';
import { EQCurveOverlay, type EqBands } from './EQCurveOverlay.js';

export interface LouiMasteringVisualizerProps {
  binCentresHz?: number[];
  magnitudeDb?: number[];
  peakHoldDb?: number[];
  /** EQ bands to overlay (approximate curve).  Omit to hide the curve. */
  eqBands?: EqBands;
  eqBypassed?: boolean;
  playhead?: number;
  height?: number;
}

function useSize(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function LouiMasteringVisualizer(props: LouiMasteringVisualizerProps) {
  const height = props.height ?? 260;
  const [ref, size] = useSize();
  const hasData = (props.binCentresHz?.length ?? 0) > 1;
  return (
    <div style={{
      borderRadius: 14, border: `1px solid ${surface.border}`, background: surface.panel,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, letterSpacing: '0.14em', textTransform: 'uppercase', color: loui.softLavender }}>
          Spectrum
        </span>
        {props.eqBands && (
          <span style={{ fontFamily: typography.family.sans, fontSize: 10, color: text.muted }}>
            EQ curve · approximate
          </span>
        )}
      </div>
      <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
        {size.w > 0 && (
          <>
            <SpectrumWaveformCanvas
              width={size.w}
              height={size.h || height}
              binCentresHz={props.binCentresHz ?? []}
              magnitudeDb={props.magnitudeDb ?? []}
              {...(props.peakHoldDb ? { peakHoldDb: props.peakHoldDb } : {})}
              {...(typeof props.playhead === 'number' ? { playhead: props.playhead } : {})}
            />
            {props.eqBands && (
              <EQCurveOverlay
                width={size.w}
                height={size.h || height}
                bands={props.eqBands}
                {...(props.eqBypassed ? { bypassed: true } : {})}
              />
            )}
          </>
        )}
        {!hasData && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: text.muted, fontFamily: typography.family.sans, fontSize: typography.size.sm,
          }}>
            재생을 시작하면 실시간 스펙트럼이 표시됩니다
          </div>
        )}
      </div>
    </div>
  );
}
