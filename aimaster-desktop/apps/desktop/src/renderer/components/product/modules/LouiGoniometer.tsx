// LouiGoniometer — Lissajous / phase-scope canvas.
//
// Plots M = (L+R)·0.5 on the vertical axis and S = (L-R)·0.5 on the
// horizontal axis each frame, with trace-persistence (partial clear) for
// the smear characteristic of hardware goniometers.
//
// Mono → vertical line.  Balanced stereo → oval.  Out-of-phase → horizontal
// line (indicates mono-incompatibility).
//
// Reads from the shared NativeAnalysers — no WASM, no fake data.

import React, { useEffect, useRef } from 'react';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

export function LouiGoniometer({ size = 88 }: { size?: number }) {
  const media = useMediaElement();
  const { analysers, status } = useNativeAnalyzer(media);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const lBuf = new Float32Array(1024);
    const rBuf = new Float32Array(1024);

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const cx = px / 2;
      const scale = cx * 0.88;

      // Trace persistence — partial clear each frame for smear effect.
      ctx.fillStyle = 'rgba(8,12,8,0.20)';
      ctx.fillRect(0, 0, px, px);

      // Faint axis guides (vertical = mono reference, horizontal = side).
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 6);
      ctx.lineTo(cx, px - 6);
      ctx.moveTo(6, cx);
      ctx.lineTo(px - 6, cx);
      ctx.stroke();

      if (analysers?.left && analysers?.right) {
        const n = Math.min(analysers.left.fftSize, lBuf.length);
        analysers.left.getFloatTimeDomainData(lBuf.subarray(0, n));
        analysers.right.getFloatTimeDomainData(rBuf.subarray(0, n));
        ctx.fillStyle = '#4ade80'; // green-400
        for (let i = 0; i < n; i++) {
          const l = lBuf[i] ?? 0;
          const r = rBuf[i] ?? 0;
          const m = (l + r) * 0.5; // mid
          const s = (l - r) * 0.5; // side
          const x = cx + s * scale;
          const y = cx - m * scale;
          ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
        }
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafRef.current); };
  // Re-wire only when analysers change; size is stable at mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysers, size]);

  return (
    <div
      title="위상 스코프 (Goniometer). 세로=Mid(L+R), 가로=Side(L-R). 수직선=모노, 타원=정상 스테레오, 수평선=역위상(모노 호환성 불량)."
      style={{
        position: 'relative',
        width: size,
        height: size,
        background: '#080c08',
        borderRadius: 4,
        overflow: 'hidden',
        flexShrink: 0,
        opacity: status === 'connected' ? 1 : 0.35,
        transition: 'opacity 300ms',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: size, height: size }} />
    </div>
  );
}
