// ReferencePanel — REFERENCE vs YOUR MIX.
//
// The identity feature: load a commercial track, render the session, and the
// argument becomes seven numbers and four overlays.  The table states the
// numbers; the overlays show WHERE they come from, because "HIGH −1.7 dB"
// is only actionable once you can see it is all above 8 k.
//
// Tonal rows are level-normalised, so turning the master down moves LUFS and
// nothing else — see daw/analysis/reference.ts.

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useReferenceStore, type OverlayTab } from '../../../stores/referenceStore.js';
import { formatMetric, spectrumDelta, type ComparisonRow, type ReferenceAnalysis } from '../../../daw/analysis/reference.js';
import { renderSession, sessionRange } from '../../../daw/engine/offline-render.js';
import { decodeContext } from '../../../daw/engine/audio-cache.js';
import { toFileUrl } from '../../../utils/fileUrl.js';
import { premium } from '../../../theme/premium.js';

const TABS: { id: OverlayTab; label: string }[] = [
  { id: 'frequency', label: 'FREQUENCY' },
  { id: 'dynamics', label: 'DYNAMICS' },
  { id: 'stereo', label: 'STEREO' },
  { id: 'tonal', label: 'TONAL BALANCE' },
];

const PLOT = { width: 760, height: 260 };

export default function ReferencePanel() {
  const session = useDawStore((s) => s.session);
  const notify = useAppStore((s) => s.notify);
  const { reference, mix, comparison, suggestions, overlay } = useReferenceStore();
  const setOverlay = useReferenceStore((s) => s.setOverlay);
  const setReference = useReferenceStore((s) => s.setReference);
  const setMix = useReferenceStore((s) => s.setMix);
  const [busy, setBusy] = useState<string | null>(null);

  const loadReference = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) { notify('electronAPI를 사용할 수 없습니다', 'error'); return; }
    const paths = await api.invoke('file:open-dialog-multi') as string[] | null;
    const first = paths?.[0];
    if (!first) return;
    const ctx = decodeContext();
    if (!ctx) { notify('오디오 디코더를 사용할 수 없습니다', 'error'); return; }
    setBusy('레퍼런스 분석 중…');
    try {
      const resp = await fetch(toFileUrl(first));
      const buffer = await ctx.decodeAudioData(await resp.arrayBuffer());
      setReference(buffer, first.split(/[\\/]/).pop() ?? 'REFERENCE');
      notify('레퍼런스를 분석했습니다', 'success');
    } catch (err) {
      notify(`레퍼런스 분석 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify, setReference]);

  const analyzeMix = useCallback(async () => {
    setBusy('믹스 렌더링 중…');
    try {
      const current = useDawStore.getState().session;
      const rendered = await renderSession(current, sessionRange(current));
      setMix(rendered, current.name || 'YOUR MIX');
      notify('현재 믹스를 분석했습니다', 'success');
    } catch (err) {
      notify(`믹스 분석 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify, setMix]);

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: premium.surface.abyss }}>
      <div className="flex items-center gap-3 px-4 py-2"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Mastering Reference
        </span>
        <span style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
          {session.name}
        </span>
        <div className="flex-1" />
        <Btn onClick={() => void loadReference()}>레퍼런스 불러오기</Btn>
        <Btn onClick={() => void analyzeMix()} primary>현재 믹스 분석</Btn>
        {busy && <span style={{ fontSize: 11, color: premium.accent.base }}>{busy}</span>}
      </div>

      <div className="p-4 flex gap-5 flex-wrap items-start">
        <MetricTable comparison={comparison} reference={reference} mix={mix} />

        <div className="flex-1 min-w-[520px]">
          <div className="flex gap-1 mb-2">
            {TABS.map((tab) => (
              <button key={tab.id} onClick={() => setOverlay(tab.id)}
                style={{
                  height: 24, padding: '0 12px', borderRadius: 3,
                  fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.08em',
                  color: overlay === tab.id ? premium.text.onAccent : premium.text.muted,
                  background: overlay === tab.id ? premium.accent.base : premium.surface.well,
                  border: `1px solid ${premium.surface.hairline}`,
                }}>{tab.label}</button>
            ))}
          </div>
          <Overlay tab={overlay} reference={reference} mix={mix} />
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="px-4 pb-6">
          <div style={{
            fontFamily: premium.type.display, fontSize: 14, color: premium.accent.light, marginBottom: 6,
          }}>맞추려면</div>
          <ul>
            {suggestions.map((s) => (
              <li key={s.metric} style={{
                fontFamily: premium.type.sans, fontSize: 12, color: premium.text.secondary,
                padding: '5px 0', borderBottom: `1px solid ${premium.surface.hairline}`,
              }}>
                <span style={{
                  fontFamily: premium.type.mono, fontSize: 10, color: premium.accent.base,
                  marginRight: 10, letterSpacing: '0.08em',
                }}>{s.metric.toUpperCase()}</span>
                {s.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MetricTable(
  { comparison, reference, mix }: {
    comparison: ReturnType<typeof useReferenceStore.getState>['comparison'];
    reference: ReferenceAnalysis | null;
    mix: ReferenceAnalysis | null;
  },
) {
  return (
    <div style={{
      minWidth: 340, borderRadius: 6, overflow: 'hidden',
      border: `1px solid ${premium.surface.hairlineStrong}`,
      background: premium.surface.well, boxShadow: premium.shadow.frame,
    }}>
      <div className="grid" style={{ gridTemplateColumns: '72px 1fr 1fr 64px' }}>
        <Head />
        <Head align="right">{reference?.name ?? 'REFERENCE'}</Head>
        <Head align="right">{mix?.name ?? 'YOUR MIX'}</Head>
        <Head align="right">Δ</Head>
        {(comparison?.rows ?? []).map((row) => <Row key={row.id} row={row} />)}
      </div>
      {!comparison && (
        <p className="px-3 py-4" style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
          레퍼런스와 현재 믹스를 모두 분석하면 표가 채워집니다.
        </p>
      )}
      {comparison && (
        <div className="px-3 py-2 flex items-center justify-between"
             style={{ borderTop: `1px solid ${premium.surface.hairline}` }}>
          <span style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted, letterSpacing: '0.1em' }}>
            MATCH
          </span>
          <span style={{
            fontFamily: premium.type.mono, fontSize: 15,
            color: comparison.score >= 85 ? premium.accent.good
              : comparison.score >= 60 ? premium.accent.base : premium.accent.danger,
          }}>{comparison.score}%</span>
        </div>
      )}
    </div>
  );
}

function Head({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <div style={{
      padding: '6px 10px', textAlign: align,
      fontFamily: premium.type.sans, fontSize: 9, letterSpacing: '0.12em',
      color: premium.text.faint, borderBottom: `1px solid ${premium.surface.hairline}`,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>{children}</div>
  );
}

function Row({ row }: { row: ComparisonRow }) {
  const color = row.verdict === 'match' ? premium.accent.good
    : Math.abs(row.delta) > row.tolerance * 3 ? premium.accent.danger : premium.accent.base;
  const cell: React.CSSProperties = {
    padding: '5px 10px', textAlign: 'right',
    fontFamily: premium.type.mono, fontSize: 12, fontVariantNumeric: 'tabular-nums',
    color: premium.text.primary, borderBottom: `1px solid ${premium.surface.hairline}`,
  };
  return (
    <>
      <div style={{
        ...cell, textAlign: 'left', color: premium.text.muted,
        fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.1em',
      }} title={row.hint}>{row.label}</div>
      <div style={cell}>{formatMetric(row, row.reference)}</div>
      <div style={cell}>{formatMetric(row, row.mix)}</div>
      <div style={{ ...cell, color }}>
        {Number.isFinite(row.delta) ? `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(1)}` : '—'}
      </div>
    </>
  );
}

// ── Overlays ──────────────────────────────────────────────────────────────────

function Overlay(
  { tab, reference, mix }: { tab: OverlayTab; reference: ReferenceAnalysis | null; mix: ReferenceAnalysis | null },
) {
  const paths = useMemo(() => buildPaths(tab, reference, mix), [tab, reference, mix]);
  return (
    <div style={{
      borderRadius: 6, border: `1px solid ${premium.surface.hairlineStrong}`,
      background: premium.surface.well, boxShadow: premium.shadow.frame, padding: 8,
    }}>
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} style={{ width: '100%', height: PLOT.height }}>
        {/* Grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={PLOT.width} y1={PLOT.height * f} y2={PLOT.height * f}
                stroke={premium.surface.hairline} strokeWidth={1} />
        ))}
        <line x1={0} x2={PLOT.width} y1={PLOT.height / 2} y2={PLOT.height / 2}
              stroke={premium.surface.hairlineStrong} strokeWidth={1} />
        {paths.reference && (
          <path d={paths.reference} fill="none" stroke={premium.accent.cool} strokeWidth={1.5} opacity={0.85} />
        )}
        {paths.mix && (
          <path d={paths.mix} fill="none" stroke={premium.accent.base} strokeWidth={1.8} />
        )}
        {paths.labels.map((l) => (
          <text key={l.text + l.x} x={l.x} y={l.y}
                fontFamily={premium.type.mono} fontSize={9} fill={premium.text.faint}>{l.text}</text>
        ))}
      </svg>
      <div className="flex gap-4 px-2 pt-1">
        <Legend color={premium.accent.cool} label={reference?.name ?? 'REFERENCE'} />
        <Legend color={premium.accent.base} label={mix?.name ?? 'YOUR MIX'} />
        <span style={{ marginLeft: 'auto', fontFamily: premium.type.sans, fontSize: 10, color: premium.text.faint }}>
          {paths.caption}
        </span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5"
          style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
      <span style={{ width: 14, height: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

interface Paths { reference: string | null; mix: string | null; caption: string; labels: { x: number; y: number; text: string }[] }

function polyline(values: ArrayLike<number>, toY: (v: number) => number): string | null {
  if (values.length === 0) return null;
  let d = '';
  for (let i = 0; i < values.length; i++) {
    const x = (i / Math.max(1, values.length - 1)) * PLOT.width;
    const y = toY(values[i] ?? 0);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

function buildPaths(tab: OverlayTab, reference: ReferenceAnalysis | null, mix: ReferenceAnalysis | null): Paths {
  const empty: Paths = { reference: null, mix: null, caption: '', labels: [] };
  if (!reference && !mix) return { ...empty, caption: '분석 대기 중' };

  switch (tab) {
    case 'frequency':
    case 'tonal': {
      // Frequency draws both curves; Tonal Balance draws the difference, which
      // is the curve you actually EQ against.
      const span = 24;                                     // ±24 dB
      const toY = (db: number): number => PLOT.height / 2 - (db / span) * PLOT.height;
      const labels = (reference ?? mix)!.spectrum.hz.reduce<{ x: number; y: number; text: string }[]>(
        (acc, hz, i, arr) => {
          if (i % 8 !== 0) return acc;
          acc.push({
            x: (i / Math.max(1, arr.length - 1)) * PLOT.width + 2,
            y: PLOT.height - 4,
            text: hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`,
          });
          return acc;
        }, []);

      if (tab === 'tonal' && reference && mix) {
        const delta = spectrumDelta(reference.spectrum, mix.spectrum);
        return {
          reference: polyline(new Float32Array(delta.db.length), toY),
          mix: polyline(delta.db, toY),
          caption: '믹스 − 레퍼런스, ±24 dB',
          labels,
        };
      }
      return {
        reference: reference ? polyline(reference.spectrum.db, toY) : null,
        mix: mix ? polyline(mix.spectrum.db, toY) : null,
        caption: '레벨 정규화 스펙트럼, ±24 dB',
        labels,
      };
    }
    case 'dynamics': {
      // Short-term loudness, both normalised to their own integrated level so
      // the SHAPE of the dynamics is what you compare, not the loudness.
      const toY = (lu: number): number => PLOT.height / 2 - (lu / 24) * PLOT.height;
      const centred = (a: ReferenceAnalysis): Float32Array => Float32Array.from(
        a.shortTerm, (v) => (Number.isFinite(v) ? v - a.integratedLufs : -24));
      return {
        reference: reference ? polyline(centred(reference), toY) : null,
        mix: mix ? polyline(centred(mix), toY) : null,
        caption: 'Short-term LUFS − integrated, ±24 LU',
        labels: [],
      };
    }
    case 'stereo': {
      const toY = (percent: number): number => PLOT.height - (percent / 200) * PLOT.height;
      const widths = (a: ReferenceAnalysis): Float32Array =>
        Float32Array.from(a.stereo.map((b) => b.widthPercent));
      const source = reference ?? mix;
      const labels = source ? source.stereo.map((b, i, arr) => ({
        x: (i / Math.max(1, arr.length - 1)) * PLOT.width + 2,
        y: PLOT.height - 4,
        text: b.hz >= 1000 ? `${(b.hz / 1000).toFixed(1)}k` : `${Math.round(b.hz)}`,
      })) : [];
      return {
        reference: reference && reference.stereo.length ? polyline(widths(reference), toY) : null,
        mix: mix && mix.stereo.length ? polyline(widths(mix), toY) : null,
        caption: '대역별 폭, 0–200 % (100 % = 무상관)',
        labels,
      };
    }
  }
}

function Btn(
  { children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean },
) {
  return (
    <button onClick={onClick} style={{
      height: 26, padding: '0 12px', borderRadius: 4,
      fontFamily: premium.type.sans, fontSize: 11,
      color: primary ? premium.text.onAccent : premium.text.secondary,
      background: primary ? premium.accent.base : premium.surface.well,
      border: `1px solid ${primary ? premium.accent.deep : premium.surface.hairline}`,
    }}>{children}</button>
  );
}
