// Every open plugin window, and the insert rack, drawn above the workspace.
//
// Mounted once at the page level rather than inside the Edit window, because
// the windows have to survive switching to Mix or to the Key Editor.  Setting
// a compressor and then wanting to see the fader is not a reason to lose the
// compressor.

import React, { useEffect } from 'react';
import { usePluginWindowStore } from '../../../stores/pluginWindowStore.js';
import { useDawStore } from '../../../stores/dawStore.js';
import { findTrack } from '../../../daw/model/session-ops.js';
import PluginWindow from './PluginWindow.js';
import InsertRack from './InsertRack.js';
import ExternalPluginManager from './ExternalPluginManager.js';

export default function PluginWindowLayer() {
  const windows = usePluginWindowStore((s) => s.windows);
  const rackTrackId = usePluginWindowStore((s) => s.rackTrackId);
  const managerOpen = usePluginWindowStore((s) => s.managerOpen);
  const setManagerOpen = usePluginWindowStore((s) => s.setManagerOpen);
  const closeTrack = usePluginWindowStore((s) => s.closeTrack);
  const toggleRack = usePluginWindowStore((s) => s.toggleRack);
  const session = useDawStore((s) => s.session);

  // A deleted track must not leave windows floating over an empty timeline.
  useEffect(() => {
    for (const win of windows) {
      if (!findTrack(session, win.trackId)) closeTrack(win.trackId);
    }
    if (rackTrackId && !findTrack(session, rackTrackId)) toggleRack(null);
  }, [session, windows, rackTrackId, closeTrack, toggleRack]);

  // Escape closes the topmost window — the way out of a stack you built up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const state = usePluginWindowStore.getState();
      if (state.managerOpen) { state.setManagerOpen(false); return; }
      if (state.rackTrackId) { state.toggleRack(null); return; }
      const top = [...state.windows].sort((a, b) => b.z - a.z)[0];
      if (top) { state.close(top.id); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {managerOpen && <ExternalPluginManager onClose={() => setManagerOpen(false)} />}
      {rackTrackId && <InsertRack trackId={rackTrackId} anchorY={120} />}
      {windows.map((win) => <PluginWindow key={win.id} window={win} />)}
    </>
  );
}
