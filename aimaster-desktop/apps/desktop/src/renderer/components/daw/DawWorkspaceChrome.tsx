// DawWorkspaceChrome — the always-mounted DAW surfaces.
//
// Rendered once from App so every page gets the same keyboard workspace:
// the bottom zone (transport + mix console), the left inspector, and the two
// overlays (MediaBay, shortcut help).  Each part is independently toggled by
// its shortcut; the whole bottom zone toggles with Mod+Alt+B.
//
// The bottom zone is fixed-position so pages that own their own scroll area
// (HomePage, ResultPage…) do not need to restructure their layout; pages that
// have content near the bottom add padding via `useBottomZoneHeight`.

import ProvenancePanel from './meta/ProvenancePanel.js';
import React from 'react';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import DawTransportBar from './DawTransportBar.js';
import DawMixConsole from './DawMixConsole.js';
import DawInspector from './DawInspector.js';
import ControlRoomPanel from './mix/ControlRoomPanel.js';
import DawMediaBay from './DawMediaBay.js';
import DawShortcutHelp from './DawShortcutHelp.js';
import ControlSurfacePanel from './surface/ControlSurfacePanel.js';

/** Approximate height (px) the fixed bottom zone occupies right now. */
export function useBottomZoneHeight(): number {
  const panels = useWorkspaceStore((s) => s.panels);
  const hasTransport = useWorkspaceStore((s) => s.hasTransport);
  if (!panels.bottomZone) return 0;
  let h = 0;
  if (panels.transport && hasTransport) h += 148;
  if (panels.mixConsole) h += 78;
  return h;
}

export default function DawWorkspaceChrome() {
  const panels       = useWorkspaceStore((s) => s.panels);
  const hasTransport = useWorkspaceStore((s) => s.hasTransport);

  const showTransport  = panels.bottomZone && panels.transport && hasTransport;
  const showMixConsole = panels.bottomZone && panels.mixConsole;

  return (
    <>
      {panels.inspector && (
        <div className="fixed left-0 top-0 bottom-0 z-30 pt-11">
          <DawInspector />
        </div>
      )}

      {(showTransport || showMixConsole) && (
        <div className="fixed bottom-0 left-0 right-0 z-30">
          {showMixConsole && <DawMixConsole />}
          {showTransport  && <DawTransportBar />}
        </div>
      )}

      {/* The monitor section.  Floating rather than in the bottom zone: it is
          reached while looking at something else, and a control room that
          pushes the arrangement up every time you turn the speakers down is
          one people stop opening. */}
      {panels.controlRoom && <ControlRoomPanel />}
      {panels.provenance && <ProvenancePanel />}

      {panels.mediaBay && <DawMediaBay />}
      {panels.help     && <DawShortcutHelp />}
      {panels.surface  && <ControlSurfacePanel />}
    </>
  );
}
