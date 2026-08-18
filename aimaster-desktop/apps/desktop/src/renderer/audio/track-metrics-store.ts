// track-metrics-store — what each track's chain is doing, one entry per track.
//
// The mastering page runs one chain and has `realtime-preview-store` for it.
// A DAW session runs one chain per track, and every one of them posts
// metrics ten times a second: gain reduction, the learned noise floor, the
// measured tonal curve. That is what turns a plugin panel from a stack of
// sliders into a meter you can mix against.
//
// # The rule this store exists to keep
//
// Messages arrive on the audio thread's schedule and must never, ever drive
// a React render. An earlier realtime integration turned each message into
// a `setState`; the re-render produced new callback identities, which
// invalidated the effect that owned the worklet, which re-attached it and
// produced more messages. The loop ran at audio rate and took the renderer
// process down.
//
// So the shape here is deliberate and is the same one that fixed it:
//
//   • `ingestTrackMetrics` writes into a plain map and marks it dirty. It
//     notifies nobody. Twelve tracks × ten messages a second cost twelve
//     object writes and no renders.
//   • Subscribers are woken by a fixed timer, never by an arrival. However
//     fast the audio thread talks, the UI is asked to update at `NOTIFY_HZ`.
//   • Each snapshot is frozen and replaced only on a tick, so
//     `useSyncExternalStore` cannot tear and cannot loop.
//
// `track-metrics-selftest` measures both halves of that: a thousand messages
// produce zero notifications, and the timer's rate is the ceiling.

import {
  EMPTY_METRICS,
  parseWorkletMetrics,
  type RealtimePreviewMetrics,
} from './realtime-preview-store.js';

export type { RealtimePreviewMetrics };
export { EMPTY_METRICS };

/** How often subscribers are notified. Independent of message arrival. */
const NOTIFY_HZ = 10;

/** Latest values as written by the message handlers. Never read by React. */
const pending = new Map<string, RealtimePreviewMetrics>();
/** What React sees. Replaced only on a notify tick. */
let snapshot: ReadonlyMap<string, RealtimePreviewMetrics> = new Map();
let dirty = false;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Counts every notification the store has sent — the selftest reads it. */
let notifyCount = 0;

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(flushTrackMetrics, 1000 / NOTIFY_HZ);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Publish what has arrived since the last tick.
 *
 * Exported for the selftest, which cannot wait on a real timer without
 * turning a unit test into a stopwatch.
 */
export function flushTrackMetrics(): void {
  if (!dirty) return;
  dirty = false;
  // A fresh map each tick — `useSyncExternalStore` compares by identity, so
  // mutating in place would make it miss every update after the first.
  snapshot = new Map(pending);
  notifyCount += 1;
  for (const l of listeners) l();
}

/**
 * Take one `metrics` message from a track's chain.
 *
 * Never notifies. See the header — that is the whole point of the module.
 */
export function ingestTrackMetrics(trackId: string, msg: Record<string, unknown>): void {
  pending.set(trackId, parseWorkletMetrics(msg));
  dirty = true;
}

/** Forget one track — it left the session, or its chain was torn down. */
export function clearTrackMetrics(trackId: string): void {
  if (!pending.delete(trackId)) return;
  dirty = true;
}

/** Forget every track. Call when the whole graph goes away. */
export function resetTrackMetrics(): void {
  if (pending.size === 0 && snapshot.size === 0) return;
  pending.clear();
  snapshot = new Map();
  dirty = false;
  notifyCount += 1;
  for (const l of listeners) l();
}

/** `useSyncExternalStore` subscribe. */
export function subscribeTrackMetrics(listener: () => void): () => void {
  listeners.add(listener);
  startTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer();
  };
}

/** `useSyncExternalStore` snapshot. Stable between notify ticks. */
export function getTrackMetricsMap(): ReadonlyMap<string, RealtimePreviewMetrics> {
  return snapshot;
}

/**
 * One track's metrics.
 *
 * Returns the shared `EMPTY_METRICS` when a track has never reported, so the
 * identity is stable and a panel for a silent track does not re-render on
 * every tick.
 */
export function getTrackMetrics(trackId: string | null | undefined): RealtimePreviewMetrics {
  if (!trackId) return EMPTY_METRICS;
  return snapshot.get(trackId) ?? EMPTY_METRICS;
}

/**
 * Server snapshot (Storybook / SSR safety).
 *
 * A constant, and never the live one: `useSyncExternalStore` calls this
 * during hydration and would loop if the identity changed.
 */
const SERVER_SNAPSHOT: ReadonlyMap<string, RealtimePreviewMetrics> = new Map();

export function getTrackMetricsServer(): ReadonlyMap<string, RealtimePreviewMetrics> {
  return SERVER_SNAPSHOT;
}

/** How many notifications have been sent. For tests, not for the UI. */
export function trackMetricsNotifyCount(): number {
  return notifyCount;
}
