// LouiPreviewTransport — play the track the chain is being tuned against.
//
// The Studio's whole premise is that you turn a knob and hear it change, so
// it needs a player. This is deliberately a small one: play/pause, a
// scrub bar, and an honest status row saying whether the realtime chain is
// actually in the signal path.
//
// The status row is not decoration. The worklet can fail to load (missing
// asset in a packaged build, CSP, an old Electron without AudioWorklet) and
// when it does, **playback continues unprocessed** — the shared graph keeps
// routing source → output. Without a status row the user would hear the
// unprocessed track and conclude the modules do nothing, which is the worst
// possible failure mode for a mastering tool. So when the chain is not in
// the path, the row says so in as many words.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimePreviewPhase } from '../../hooks/useRealtimePreview.js';
import type { RealtimePreviewMetrics } from '../../audio/realtime-preview-store.js';
import { resumeSharedContext } from '../../audio/shared-audio-graph.js';
import { surface, text, typography, space, radius, meter } from '../../theme/loui-theme.js';

export interface LouiPreviewTransportProps {
  /** Source URL, or null when no file is loaded. */
  src: string | null;
  /** Receives the element so the caller can route it through the graph. */
  onMediaRef: (el: HTMLMediaElement | null) => void;
  phase: RealtimePreviewPhase;
  error: string | null;
  metrics: RealtimePreviewMetrics;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

/** What the status row says, and how loudly. */
function statusFor(
  phase: RealtimePreviewPhase,
  metrics: RealtimePreviewMetrics,
): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (phase) {
    case 'running':
      return metrics.running
        ? { label: '실시간 반영 중 — 설정을 바꾸면 바로 들립니다', tone: 'ok' }
        : { label: '체인 연결됨 — 재생하면 반영됩니다', tone: 'muted' };
    case 'loading':
      return { label: '실시간 엔진 로드 중…', tone: 'muted' };
    case 'failed':
      // The important one: audio is playing, but not through the chain.
      return { label: '실시간 엔진 실패 — 원본이 그대로 재생됩니다', tone: 'warn' };
    case 'disabled':
      return { label: '실시간 프리뷰 꺼짐 — 원본이 그대로 재생됩니다', tone: 'warn' };
    default:
      return { label: '음원을 선택하세요', tone: 'muted' };
  }
}

export function LouiPreviewTransport(props: LouiPreviewTransportProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Hand the element up exactly once per mount/unmount.  The graph caches
  // one MediaElementSource per element for its lifetime, so handing over a
  // new element on every render would leak sources and silence playback.
  //
  // The callback is read through a ref so this stays identity-stable even
  // if the caller passes a fresh function each render — a changing ref
  // callback would detach and re-attach the element, which is exactly the
  // churn the realtime path must not have.
  const onMediaRefRef = useRef(props.onMediaRef);
  onMediaRefRef.current = props.onMediaRef;
  const setRef = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    onMediaRefRef.current(el);
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setTime(a.currentTime);
    const onMeta = () => setDuration(a.duration);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
    };
  }, [props.src]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      // An AudioContext starts suspended until a user gesture.  Resuming it
      // here — inside the click handler — is what stops the classic "the
      // transport says playing and nothing comes out" failure.
      void resumeSharedContext().finally(() => {
        void a.play().catch(() => { /* decode issue — status row shows it */ });
      });
    } else {
      a.pause();
    }
  }, []);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  }, [duration]);

  const status = statusFor(props.phase, props.metrics);
  const statusColor =
    status.tone === 'ok' ? meter.safe.foreground
      : status.tone === 'warn' ? meter.warn.foreground
        : text.muted;

  const progress = duration > 0 ? (time / duration) * 100 : 0;
  const latencyMs = props.metrics.blockPeriodMs > 0 && props.metrics.latencySamples > 0
    ? (props.metrics.latencySamples / 48_000) * 1000
    : 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: space['2'],
      paddingInline: space['4'],
      paddingBlock: space['3'],
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space['3'] }}>
        <button
          type="button"
          onClick={toggle}
          disabled={!props.src}
          aria-label={playing ? '일시정지' : '재생'}
          style={{
            appearance: 'none',
            cursor: props.src ? 'pointer' : 'not-allowed',
            width: 34,
            height: 34,
            borderRadius: 999,
            border: `1px solid ${props.src ? 'rgba(167,139,250,0.5)' : surface.border}`,
            background: props.src ? 'rgba(167,139,250,0.16)' : surface.well,
            color: props.src ? meter.accent.foreground : text.disabled,
            fontSize: 13,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <div
          onClick={seek}
          role="slider"
          aria-label="재생 위치"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          tabIndex={0}
          style={{
            flex: 1,
            height: 6,
            borderRadius: radius.bar,
            background: surface.well,
            cursor: duration ? 'pointer' : 'default',
            overflow: 'hidden',
          }}
        >
          <div style={{
            width: `${progress}%`,
            height: '100%',
            background: meter.accent.foreground,
            transition: 'width 120ms linear',
          }} />
        </div>

        <span style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.muted,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: space['3'], flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: space['2'],
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: statusColor,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: statusColor, flexShrink: 0,
          }} />
          {status.label}
        </span>

        {props.phase === 'running' && (
          <span style={{
            fontFamily: typography.family.mono,
            fontSize: typography.size.xs,
            color: text.muted,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {props.metrics.avgProcessMs.toFixed(2)} ms/블록
            {props.metrics.xruns > 0 && ` · xrun ${props.metrics.xruns}`}
            {latencyMs > 0 && ` · 지연 ${latencyMs.toFixed(0)} ms`}
            {props.metrics.safetyEvents > 0 && ` · 안전복구 ${props.metrics.safetyEvents}`}
          </span>
        )}

        {props.error && (
          <span
            title={props.error}
            style={{
              fontFamily: typography.family.mono,
              fontSize: typography.size.xs,
              color: meter.warn.foreground,
              maxWidth: '40ch',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {props.error}
          </span>
        )}
      </div>

      {props.src && (
        // `crossOrigin` is unset deliberately: the source is a local file://
        // URL served by the app's own protocol handler, and setting it would
        // make the element taint-check a request that never leaves the app.
        <audio ref={setRef} src={props.src} preload="metadata" style={{ display: 'none' }} />
      )}
    </div>
  );
}
