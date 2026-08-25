// RackPanel — four knobs on the lid, the whole chain underneath.
//
//   CLEAN     ●──────
//   BODY      ───●───
//   PRESENCE  ────●──
//   AIR       ─────●─
//
// "열기" reveals the devices inside and every mapping: which macro owns which
// parameter, and the from → to range it sweeps.  Folding a chain is only
// acceptable if unfolding it is one click away.

import React, { useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { updateTrack } from '../../../daw/model/session-ops.js';
import {
  resolveRack, setRackMacro, macroFor, describeRack, type Rack,
} from '../../../daw/model/racks.js';
import { deviceOrder } from '../../../daw/model/device-graph.js';
import { findPlugin } from '../../../daw/engine/plugins.js';
import { premium } from '../../../theme/premium.js';
import Knob from '../smart/Knob.js';

export default function RackPanel({
  rack, trackId, onClose,
}: { rack: Rack; trackId: string; onClose: () => void }) {
  const apply = useDawStore((s) => s.apply);
  const applyT = useDawStore((s) => s.applyTransient);
  const commit = useDawStore((s) => s.commitEdit);
  const [open, setOpen] = useState(false);

  const write = (next: Rack, transient = false): void => {
    const mutate = (s: Parameters<typeof updateTrack>[0]) => updateTrack(s, trackId, (t) => ({
      ...t,
      racks: t.racks.map((r) => (r.id === next.id ? next : r)),
    }));
    if (transient) applyT(mutate); else apply(mutate);
  };

  const resolved = resolveRack(rack);

  return (
    <div
      className="fixed inset-0 z-[8600] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.66)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(94vw, 720px)',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          background: premium.surface.panel,
          backgroundImage: premium.gradient.panel,
          border: `1px solid ${premium.surface.hairline}`,
          borderRadius: 16,
          boxShadow: premium.shadow.panel,
          overflow: 'hidden',
        }}
      >
        {/* Lid */}
        <div className="flex items-center gap-3 px-5 py-3"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
          <div className="min-w-0">
            <p style={{
              fontFamily: premium.type.display, fontSize: 19, fontStyle: 'italic',
              color: premium.accent.light,
            }}>{rack.name}</p>
            <p className="truncate" style={{
              fontFamily: premium.type.mono, fontSize: 9, color: premium.text.faint,
            }}>{describeRack(rack)}</p>
          </div>
          <div className="flex-1" />
          <button onClick={() => setOpen((v) => !v)} style={pill}>
            {open ? '접기' : '열기'}
          </button>
          <button onClick={onClose} style={{ ...pill, borderColor: 'transparent' }}>✕</button>
        </div>

        {/* Macros */}
        <div className="flex flex-wrap gap-5 px-6 py-5 justify-center"
             style={{ background: premium.surface.abyss }}>
          {rack.macros.map((macro) => (
            <div key={macro.id} className="flex flex-col items-center gap-1" style={{ width: 92 }}>
              <span style={{
                fontFamily: premium.type.display, fontSize: 13, fontStyle: 'italic',
                color: premium.text.secondary, letterSpacing: '0.06em',
              }}>{macro.name}</span>
              <Knob
                value={rack.values[macro.id] ?? 0}
                min={0} max={1} defaultValue={0} size={62}
                display={`${Math.round((rack.values[macro.id] ?? 0) * 100)}`}
                label={macro.label}
                title={macro.targets.map((t) => {
                  const node = rack.graph.nodes.find((n) => n.id === t.nodeId);
                  return `${node?.label ?? '?'} ${t.param}: ${t.from} → ${t.to}`;
                }).join('\n')}
                onChange={(v) => write(setRackMacro(rack, macro.id, v), true)}
                onCommit={commit}
              />
            </div>
          ))}
        </div>

        {/* Inside */}
        {open && (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
               style={{ background: premium.surface.abyss, borderTop: `1px solid ${premium.surface.hairline}` }}>
            {deviceOrder(rack.graph).map((node, index) => {
              const plugin = node.pluginId ? findPlugin(node.pluginId) : undefined;
              const params = resolved.get(node.id) ?? {};
              return (
                <div key={node.id} style={{
                  borderRadius: 10,
                  border: `1px solid ${premium.surface.hairline}`,
                  background: premium.surface.well,
                  backgroundImage: premium.gradient.well,
                }}>
                  <div className="flex items-baseline gap-2 px-3 py-1.5"
                       style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
                    <span style={{
                      fontFamily: premium.type.mono, fontSize: 9, color: premium.text.faint,
                    }}>{index + 1}</span>
                    <span style={{
                      fontFamily: premium.type.display, fontSize: 14, fontStyle: 'italic',
                      color: premium.accent.light,
                    }}>{node.label}</span>
                    {plugin?.offline && (
                      <span style={{
                        fontFamily: premium.type.mono, fontSize: 8, padding: '0 4px',
                        borderRadius: 3, color: premium.accent.cool,
                        background: 'rgba(110,155,214,0.16)',
                      }}>OFFLINE — 바이패스</span>
                    )}
                  </div>
                  <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-1">
                    {(plugin?.params ?? []).map((param) => {
                      const owner = macroFor(rack, node.id, param.id);
                      const value = params[param.id] ?? param.default;
                      return (
                        <div key={param.id} className="flex items-center gap-2">
                          <span style={{
                            fontFamily: premium.type.sans, fontSize: 9,
                            color: premium.text.muted, width: 68,
                          }}>{param.name}</span>
                          <span style={{
                            fontFamily: premium.type.mono, fontSize: 10, width: 58,
                            textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            color: owner ? premium.accent.light : premium.text.secondary,
                          }}>{value.toFixed(2)}{param.unit}</span>
                          <span className="truncate" style={{
                            fontFamily: premium.type.sans, fontSize: 8,
                            color: owner ? premium.accent.base : premium.text.faint,
                          }}>{owner ? `← ${owner.name}` : ''}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const pill: React.CSSProperties = {
  height: 26, padding: '0 10px', borderRadius: 8,
  border: `1px solid ${premium.surface.hairlineStrong}`,
  background: 'transparent', color: premium.text.secondary,
  fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.1em', cursor: 'pointer',
};
