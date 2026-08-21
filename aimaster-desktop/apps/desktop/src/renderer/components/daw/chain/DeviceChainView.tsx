// DeviceChainView — the signal path drawn as the signal path.
//
// Devices are cards on a column/lane grid; cables are curves between them.
// A parallel branch leaves the spine, runs on its own lane and comes back —
// which is the whole reason the model is a graph and not a list of slots.
//
// Interactions:
//   • the + on a cable inserts a device there
//   • a selected device can spawn a parallel branch or a send
//   • dragging the branch's blend value changes the merge level

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, updateTrack } from '../../../daw/model/session-ops.js';
import {
  addParallelBranch, addSend, createNode, deviceOrder, edgesFrom, emptyGraph,
  findNode, insertOnEdge, layout, linearGraph, mainPath, removeNode, updateNode,
  validateGraph, type DeviceGraph, type DeviceNode,
} from '../../../daw/model/device-graph.js';
import { buildRack, rackBlueprints, rackNode } from '../../../daw/model/racks.js';
import { PLUGINS, findPlugin } from '../../../daw/engine/plugins.js';
import { premium } from '../../../theme/premium.js';
import RackPanel from './RackPanel.js';

const COL_WIDTH = 168;
const ROW_HEIGHT = 104;
const CARD_WIDTH = 132;
const CARD_HEIGHT = 62;

export default function DeviceChainView() {
  const session = useDawStore((s) => s.session);
  const apply   = useDawStore((s) => s.apply);
  const notify  = useAppStore((s) => s.notify);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const [selected, setSelected] = useState<string | null>(null);
  const [addingOn, setAddingOn] = useState<string | null>(null);
  const [openRack, setOpenRack] = useState<string | null>(null);

  const trackId = focusedTrackId ?? session.tracks.find((t) => t.kind !== 'master')?.id ?? null;
  const track = trackId ? findTrack(session, trackId) : undefined;
  const graph = track?.deviceGraph ?? null;

  const problems = useMemo(() => (graph ? validateGraph(graph) : []), [graph]);
  const spine = useMemo(() => new Set(graph ? mainPath(graph) : []), [graph]);

  const write = (next: DeviceGraph): void => {
    if (!trackId) return;
    apply((s) => updateTrack(s, trackId, (t) => ({ ...t, deviceGraph: layout(next) })));
  };

  if (!track || !trackId) {
    return <Empty message="트랙을 선택하세요" />;
  }

  if (!graph) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4"
           style={{ background: premium.surface.abyss }}>
        <p style={{ fontFamily: premium.type.display, fontSize: 22, color: premium.accent.light }}>
          Device Chain
        </p>
        <p style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>
          {track.name} — 아직 체인이 없습니다. 신호 흐름을 만들어 보세요.
        </p>
        <div className="flex gap-2">
          <Action onClick={() => write(emptyGraph())}>빈 체인</Action>
          <Action onClick={() => write(linearGraph([
            { pluginId: 'denoise', label: 'DENOISE' },
            { pluginId: 'eq3', label: 'EQ' },
            { pluginId: 'comp', label: 'COMP' },
            { pluginId: 'saturation', label: 'SATURATION' },
            { pluginId: 'deesser', label: 'DE-ESSER' },
            { pluginId: 'limiter', label: 'LIMIT' },
          ]))}>기본 보컬 체인</Action>
          {rackBlueprints().map((blueprint) => (
            <Action key={blueprint.id} onClick={() => {
              const rack = buildRack(blueprint.id);
              if (!rack) return;
              const base = emptyGraph();
              const node = rackNode(rack, 1);
              const inputId = base.nodes[0]!.id;
              const outputId = base.nodes[1]!.id;
              apply((s) => updateTrack(s, trackId, (t) => ({
                ...t,
                racks: [...t.racks, rack],
                deviceGraph: layout({
                  nodes: [...base.nodes, node],
                  edges: [
                    { id: 'e-in', from: inputId, to: node.id, gainDb: 0 },
                    { id: 'e-out', from: node.id, to: outputId, gainDb: 0 },
                  ],
                }),
              })));
              notify(`${blueprint.name} 추가 — ${blueprint.description}`, 'success');
            }}>{blueprint.name}</Action>
          ))}
        </div>
      </div>
    );
  }

  const maxCol = Math.max(...graph.nodes.map((n) => n.col));
  const maxRow = Math.max(...graph.nodes.map((n) => n.row));
  const width = (maxCol + 1) * COL_WIDTH + 40;
  const height = (maxRow + 1) * ROW_HEIGHT + 40;

  const nodeCenter = (node: DeviceNode): { x: number; y: number } => ({
    x: 20 + node.col * COL_WIDTH + CARD_WIDTH / 2,
    y: 20 + node.row * ROW_HEIGHT + CARD_HEIGHT / 2,
  });

  const selectedNode = selected ? findNode(graph, selected) : undefined;
  const openedRack = openRack ? track.racks.find((r) => r.id === openRack) : undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: premium.surface.abyss }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Device Chain
        </span>
        <span style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
          {track.name}
        </span>
        <div className="flex-1" />
        {selectedNode && selectedNode.kind === 'device' && (
          <>
            <Action onClick={() => {
              const target = edgesFrom(graph, selectedNode.id)[0];
              if (!target) { notify('브랜치가 돌아올 지점이 없습니다', 'warning'); return; }
              write(addParallelBranch(graph, selectedNode.id, target.to, createNode({
                kind: 'device', pluginId: 'saturation', label: 'PARALLEL SAT',
              }), -6));
              notify('병렬 브랜치를 추가했습니다 (−6 dB 블렌드)');
            }}>+ 병렬 브랜치</Action>
            <Action onClick={() => {
              const bus = session.buses[0];
              if (!bus) { notify('먼저 버스를 만드세요 (믹스 화면)', 'warning'); return; }
              write(addSend(graph, selectedNode.id, bus.id, `${bus.name} SEND`, -12));
              notify(`${bus.name} 센드를 추가했습니다`);
            }}>+ 센드</Action>
            <Action onClick={() => { write(removeNode(graph, selectedNode.id)); setSelected(null); }}>
              삭제
            </Action>
          </>
        )}
        {problems.length > 0 && (
          <span style={{
            fontFamily: premium.type.sans, fontSize: 10,
            color: problems.some((p) => p.severity === 'error') ? premium.accent.danger : premium.accent.base,
          }}>{problems[0]?.message}</span>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 overflow-auto p-2">
        <div className="relative" style={{ width, height }}>
          {/* Cables */}
          <svg width={width} height={height} className="absolute inset-0 pointer-events-none">
            {graph.edges.map((edge) => {
              const from = findNode(graph, edge.from);
              const to = findNode(graph, edge.to);
              if (!from || !to) return null;
              const a = nodeCenter(from);
              const b = nodeCenter(to);
              const start = { x: a.x + CARD_WIDTH / 2, y: a.y };
              const end = { x: b.x - CARD_WIDTH / 2, y: b.y };
              const mid = (start.x + end.x) / 2;
              const onSpine = spine.has(edge.from) && spine.has(edge.to);
              const isSend = to.kind === 'send';
              return (
                <g key={edge.id}>
                  <path
                    d={`M ${start.x} ${start.y} C ${mid} ${start.y}, ${mid} ${end.y}, ${end.x} ${end.y}`}
                    fill="none"
                    stroke={isSend ? premium.accent.cool : onSpine ? premium.accent.base : premium.accent.deep}
                    strokeWidth={onSpine ? 2 : 1.5}
                    strokeDasharray={isSend ? '4 3' : undefined}
                    opacity={onSpine ? 0.95 : 0.7}
                  />
                  {edge.gainDb !== 0 && (
                    <text x={mid} y={(start.y + end.y) / 2 - 6} textAnchor="middle"
                      style={{ fontFamily: premium.type.mono, fontSize: 9, fill: premium.accent.light }}>
                      {edge.gainDb > 0 ? '+' : ''}{edge.gainDb.toFixed(1)} dB
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Cable insert buttons */}
          {graph.edges.map((edge) => {
            const from = findNode(graph, edge.from);
            const to = findNode(graph, edge.to);
            if (!from || !to) return null;
            const a = nodeCenter(from);
            const b = nodeCenter(to);
            const x = (a.x + b.x) / 2;
            const y = (a.y + b.y) / 2;
            return (
              <button
                key={`ins-${edge.id}`}
                onClick={() => setAddingOn(addingOn === edge.id ? null : edge.id)}
                title="여기에 디바이스 삽입"
                className="absolute rounded-full flex items-center justify-center"
                style={{
                  left: x - 9, top: y - 9, width: 18, height: 18,
                  border: `1px solid ${premium.surface.hairlineStrong}`,
                  background: premium.surface.panel,
                  color: premium.accent.base,
                  fontSize: 11, lineHeight: 1,
                }}
              >+</button>
            );
          })}

          {/* Device picker */}
          {addingOn && (
            <div
              className="absolute z-20 rounded-lg overflow-hidden"
              style={{
                left: 24, top: 8, width: 220, maxHeight: 280, overflowY: 'auto',
                background: premium.surface.panel,
                border: `1px solid ${premium.surface.hairlineStrong}`,
                boxShadow: premium.shadow.panel,
              }}
            >
              {PLUGINS.map((plugin) => (
                <button
                  key={plugin.id}
                  onClick={() => {
                    write(insertOnEdge(graph, addingOn, createNode({
                      kind: 'device',
                      pluginId: plugin.id,
                      label: plugin.name.toUpperCase(),
                      params: Object.fromEntries(plugin.params.map((p) => [p.id, p.default])),
                    })));
                    setAddingOn(null);
                  }}
                  className="w-full text-left px-3 py-1.5"
                  style={{
                    fontFamily: premium.type.sans, fontSize: 11,
                    color: premium.text.secondary,
                    borderBottom: `1px solid ${premium.surface.hairline}`,
                  }}
                >
                  {plugin.name}
                  {plugin.offline && (
                    <span style={{ color: premium.accent.cool, fontSize: 9 }}> · OFFLINE</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Device cards */}
          {graph.nodes.map((node) => {
            const center = nodeCenter(node);
            const descriptor = node.pluginId ? findPlugin(node.pluginId) : undefined;
            const rack = node.rackId ? track.racks.find((r) => r.id === node.rackId) : undefined;
            const isEndpoint = node.kind === 'input' || node.kind === 'output';
            const isSelected = selected === node.id;
            return (
              <div
                key={node.id}
                onClick={() => setSelected(isSelected ? null : node.id)}
                onDoubleClick={() => { if (rack) setOpenRack(rack.id); }}
                className="absolute rounded-lg px-2 py-1.5 cursor-pointer flex flex-col justify-between"
                style={{
                  left: center.x - CARD_WIDTH / 2,
                  top: center.y - CARD_HEIGHT / 2,
                  width: CARD_WIDTH,
                  height: CARD_HEIGHT,
                  background: isEndpoint ? premium.surface.well : premium.surface.frame,
                  backgroundImage: isEndpoint ? undefined : premium.gradient.frame,
                  border: `1px solid ${isSelected ? premium.accent.base
                    : node.kind === 'send' ? premium.accent.cool
                    : rack ? premium.surface.engrave
                    : premium.surface.hairlineStrong}`,
                  boxShadow: isSelected ? premium.shadow.focus : premium.shadow.frame,
                  opacity: node.bypass ? 0.5 : 1,
                }}
              >
                <div className="flex items-center gap-1 min-w-0">
                  <span className="truncate" style={{
                    fontFamily: isEndpoint || rack ? premium.type.display : premium.type.sans,
                    fontSize: isEndpoint ? 12 : rack ? 12 : 10,
                    fontStyle: rack ? 'italic' : undefined,
                    letterSpacing: '0.08em',
                    color: isEndpoint ? premium.text.muted
                      : rack ? premium.accent.light
                      : premium.text.primary,
                  }}>{node.label}</span>
                </div>

                <div className="flex items-center gap-1">
                  {descriptor?.offline && (
                    <span style={{
                      fontFamily: premium.type.mono, fontSize: 8, padding: '0 3px',
                      borderRadius: 3, color: premium.accent.cool,
                      background: 'rgba(110,155,214,0.16)',
                    }}>OFFLINE</span>
                  )}
                  {rack && (
                    <span className="truncate" style={{
                      fontFamily: premium.type.mono, fontSize: 8, color: premium.text.faint,
                    }}>{rack.macros.length} macros</span>
                  )}
                  {node.kind === 'send' && (
                    <span style={{ fontFamily: premium.type.mono, fontSize: 8, color: premium.accent.cool }}>
                      {node.sendLevelDb.toFixed(0)} dB
                    </span>
                  )}
                  <div className="flex-1" />
                  {!isEndpoint && node.kind !== 'send' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        write(updateNode(graph, node.id, (n) => ({ ...n, bypass: !n.bypass })));
                      }}
                      title="바이패스"
                      style={{
                        fontFamily: premium.type.mono, fontSize: 8, padding: '0 4px',
                        borderRadius: 3,
                        border: `1px solid ${node.bypass ? premium.accent.base : premium.surface.hairline}`,
                        color: node.bypass ? premium.accent.base : premium.text.faint,
                        background: 'transparent',
                      }}
                    >{node.bypass ? 'OFF' : 'ON'}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Parameter strip for the selected device */}
      {selectedNode && selectedNode.kind === 'device' && selectedNode.pluginId && (
        <ParamStrip
          node={selectedNode}
          onChange={(param, value) => write(updateNode(graph, selectedNode.id, (n) => ({
            ...n, params: { ...n.params, [param]: value },
          })))}
        />
      )}

      {openedRack && (
        <RackPanel
          rack={openedRack}
          trackId={trackId}
          onClose={() => setOpenRack(null)}
        />
      )}
    </div>
  );
}

function ParamStrip({
  node, onChange,
}: { node: DeviceNode; onChange: (param: string, value: number) => void }) {
  const descriptor = node.pluginId ? findPlugin(node.pluginId) : undefined;
  if (!descriptor) return null;
  return (
    <div
      className="flex items-center gap-4 px-4 py-2 overflow-x-auto"
      style={{ borderTop: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}
    >
      <span style={{
        fontFamily: premium.type.display, fontSize: 14, fontStyle: 'italic',
        color: premium.accent.light, whiteSpace: 'nowrap',
      }}>{descriptor.name}</span>
      {descriptor.params.map((param) => (
        <label key={param.id} className="flex flex-col gap-0.5" style={{ minWidth: 96 }}>
          <span className="flex justify-between" style={{
            fontFamily: premium.type.sans, fontSize: 9, color: premium.text.muted,
          }}>
            <span>{param.name}</span>
            <span style={{ fontFamily: premium.type.mono, color: premium.text.secondary }}>
              {(node.params[param.id] ?? param.default).toFixed(2)}{param.unit}
            </span>
          </span>
          <input
            type="range"
            min={param.min} max={param.max} step={(param.max - param.min) / 200}
            value={node.params[param.id] ?? param.default}
            onChange={(e) => onChange(param.id, parseFloat(e.target.value))}
            style={{ accentColor: premium.accent.base }}
          />
        </label>
      ))}
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center"
         style={{ background: premium.surface.abyss, color: premium.text.muted, fontSize: 13 }}>
      {message}
    </div>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 10px', borderRadius: 8,
        border: `1px solid ${premium.surface.hairlineStrong}`,
        background: 'transparent', color: premium.text.secondary,
        fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.08em',
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

/** Exported for the chain-view tests. */
export function chainSummary(graph: DeviceGraph): string {
  return deviceOrder(graph).map((n) => n.label).join(' → ');
}
