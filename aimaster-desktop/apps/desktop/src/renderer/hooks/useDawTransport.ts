// useDawTransport — connect a page's <audio> element to the DAW workspace.
//
// Whichever page mounts a preview player calls this with its ref.  It:
//   • registers the element so the global shortcuts (Space, Home, loop…)
//     can drive it,
//   • mirrors play state / position / duration into the workspace store so
//     the transport bar can render without prop-drilling,
//   • enforces loop playback,
//   • keeps the element's muted flag in sync with the store (M key).
//
// Registration is last-mount-wins: only one preview player is on screen at a
// time in this app.

import { useEffect } from 'react';
import {
  registerTransportElement,
  getTransportElement,
  useWorkspaceStore,
} from '../stores/workspaceStore.js';

export function useDawTransport(ref: React.RefObject<HTMLAudioElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    registerTransportElement(el);
    const store = useWorkspaceStore.getState();
    store.setTransportState({
      isPlaying: !el.paused,
      positionSec: el.currentTime || 0,
      durationSec: Number.isFinite(el.duration) ? el.duration : 0,
    });
    el.muted = useWorkspaceStore.getState().muted;

    const onPlay  = () => useWorkspaceStore.getState().setTransportState({ isPlaying: true });
    const onPause = () => useWorkspaceStore.getState().setTransportState({ isPlaying: false });
    const onMeta = () => {
      const st = useWorkspaceStore.getState();
      st.setTransportState({ durationSec: Number.isFinite(el.duration) ? el.duration : 0 });
      // currentSrc is only resolved once loading starts — refresh it here so
      // the transport bar can decode peaks for the right file.
      const src = el.currentSrc || el.src || null;
      if (src !== st.transportSrc) st.setTransportSource({ hasTransport: true, transportSrc: src });
    };
    const onTime = () => {
      const s = useWorkspaceStore.getState();
      const t = el.currentTime;
      // Loop enforcement — wrap back to the start once past the right locator.
      if (s.loopEnabled && s.loop.endSec > s.loop.startSec && t >= s.loop.endSec) {
        el.currentTime = s.loop.startSec;
        s.setTransportState({ positionSec: s.loop.startSec });
        return;
      }
      s.setTransportState({ positionSec: t });
    };
    const onEnded = () => {
      const s = useWorkspaceStore.getState();
      if (s.loopEnabled && s.loop.endSec > s.loop.startSec) {
        el.currentTime = s.loop.startSec;
        void el.play();
        return;
      }
      s.setTransportState({ isPlaying: false, positionSec: 0 });
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);

    // Store → element (M key toggles `muted` in the store).
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (el.muted !== state.muted) el.muted = state.muted;
    });

    return () => {
      unsub();
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      // Only clear the registry if a newer player has not already claimed it.
      if (getTransportElement() === el) registerTransportElement(null);
    };
  }, [ref]);
}
