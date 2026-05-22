// MediaElementContext — exposes the page's <audio> element to descendants
// so analyzer/meter panels can build the native (WASM-free) WebAudio
// fallback graph for it.  Null until the element mounts.

import React from 'react';

const MediaElementContext = React.createContext<HTMLAudioElement | null>(null);

export function useMediaElement(): HTMLAudioElement | null {
  return React.useContext(MediaElementContext);
}

export function MediaElementProvider(
  { value, children }: { value: HTMLAudioElement | null; children: React.ReactNode },
) {
  return <MediaElementContext.Provider value={value}>{children}</MediaElementContext.Provider>;
}
