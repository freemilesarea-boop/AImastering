// React context for sharing ONE WasmAnalyzerSession across multiple V2
// panels attached to the same audio element.
//
// Why
//   AudioContext + MediaElementAudioSourceNode is browser-constrained
//   to ONE source-per-element-per-context.  If LoudnessMeterPanelV2 /
//   SpectrumAnalyzerPanel / StereoScopePanel each created their own
//   session, the second one would crash on `createMediaElementSource`.
//
//   The provider creates one session, attaches the element, and exposes
//   the session via context.  Children subscribe via `useWasmAnalyzerSession`.
//
// Lifecycle
//   The provider creates the session on first mount (when `active` is true).
//   Stops it on unmount or when `active` flips to false.  Re-creating when
//   `mediaElement` changes is the consumer's job (provider receives the
//   element as a prop and uses it as a useEffect dep).
//
// Feature flag
//   The provider checks `isWasmAnalyzerEnabled()` itself — when off, it
//   renders children with a `null` context (no session created).  Gate
//   components see `null` and fall back to V1 / empty rendering.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';

import { isWasmAnalyzerEnabled } from './analyzer-factory-resolver.js';
import {
  WasmAnalyzerSessionFactory,
  type AudioSourceNode,
} from './wasm-analyzer-session.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

/** Capabilities a WasmAnalyzerSession exposes that the base interface does not. */
export interface AttachableAnalyzerSession extends AnalyzerSession {
  attach(source: AudioSourceNode): void;
  attachMediaElement(media: HTMLMediaElement): void;
  audioContext(): AudioContext | null;
}

const WasmAnalyzerContext = createContext<AttachableAnalyzerSession | null>(null);

/** Subscribe to the page-shared WASM analyzer session.  `null` when V2 is off. */
export function useWasmAnalyzerSession(): AttachableAnalyzerSession | null {
  return useContext(WasmAnalyzerContext);
}

export interface WasmAnalyzerProviderProps {
  /** Audio source to analyse.  Required for the provider to create a session. */
  mediaElement?: HTMLMediaElement | null;
  /** Whether the session should be running. */
  active: boolean;
  /** Sample rate to construct the AudioContext + analyzer with.  Default 48k. */
  sampleRate?: number;
  /** Channel count.  Default 2. */
  channels?: 1 | 2;
  /** Children that may consume the session via `useWasmAnalyzerSession`. */
  children: ReactNode;
}

/**
 * Mount a single WASM analyzer session for a media element and expose it
 * to descendants.  Does nothing (renders children with null context)
 * when the WASM analyzer feature flag is off.
 */
export function WasmAnalyzerProvider({
  mediaElement,
  active,
  sampleRate = 48_000,
  channels = 2,
  children,
}: WasmAnalyzerProviderProps) {
  const [session, setSession] = useState<AttachableAnalyzerSession | null>(null);
  const factoryRef = useRef<WasmAnalyzerSessionFactory | null>(null);

  // Lifecycle: create session when active && enabled; tear down otherwise.
  useEffect(() => {
    if (!isWasmAnalyzerEnabled()) {
      setSession(null);
      return;
    }
    if (!active || !mediaElement) {
      setSession(null);
      return;
    }

    if (!factoryRef.current) {
      factoryRef.current = new WasmAnalyzerSessionFactory();
    }
    let cancelled = false;
    const s = factoryRef.current.create({
      sampleRate,
      channels,
    }) as AttachableAnalyzerSession;

    s.start()
      .then(() => {
        if (cancelled) {
          void s.stop();
          return;
        }
        try {
          s.attachMediaElement(mediaElement);
        } catch (err) {
          // attachMediaElement throws if createMediaElementSource fails —
          // most commonly when the element is already wired into another
          // AudioContext (e.g. V1 path still active).  We log and leave
          // the meter empty so the page degrades gracefully.
          // eslint-disable-next-line no-console
          console.warn('[wasm-analyzer-provider] attach failed:', err);
        }
        setSession(s);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[wasm-analyzer-provider] start failed:', err);
        if (!cancelled) setSession(null);
      });

    return () => {
      cancelled = true;
      void s.stop();
      setSession((prev) => (prev === s ? null : prev));
    };
  }, [mediaElement, active, sampleRate, channels]);

  return (
    <WasmAnalyzerContext.Provider value={session}>
      {children}
    </WasmAnalyzerContext.Provider>
  );
}
