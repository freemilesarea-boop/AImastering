// Realtime-preview status context (REALTIME-SOUND-CHANGE).
//
// Threads "is the realtime WASM chain actually processing right now" down
// to module badges so they can honestly say "Heard live" vs "Staged".
// Defaults to off/unavailable outside a provider (e.g. storybook).

import React from 'react';

export interface RealtimePreviewStatus {
  /** The realtime flag is on. */
  enabled: boolean;
  /** The graph is attached + processing (edits are heard live). */
  active: boolean;
}

const DEFAULT: RealtimePreviewStatus = { enabled: false, active: false };

const RealtimePreviewContext = React.createContext<RealtimePreviewStatus>(DEFAULT);

export function useRealtimePreviewStatus(): RealtimePreviewStatus {
  return React.useContext(RealtimePreviewContext);
}

export function RealtimePreviewProvider(
  { value, children }: { value: RealtimePreviewStatus; children: React.ReactNode },
) {
  return <RealtimePreviewContext.Provider value={value}>{children}</RealtimePreviewContext.Provider>;
}
