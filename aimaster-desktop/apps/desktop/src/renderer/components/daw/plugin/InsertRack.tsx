// What the pencil on a track header opens: that track's ten insert slots.
//
// A rack, not a menu.  Slots stay in place whether or not they hold anything,
// because "the compressor is in C" is how an engineer remembers a channel, and
// a list that reflows every time you add a device destroys that.
//
// Clicking a device opens its window; the rack stays open so you can put up
// three of them and start comparing.

import React, { useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { usePluginWindowStore } from '../../../stores/pluginWindowStore.js';
import { createInsert, findTrack, removeInsert, setInsert } from '../../../daw/model/session-ops.js';
import { PLUGINS, findPlugin } from '../../../daw/engine/plugins.js';
import { defaultParams } from '../../../daw/engine/plugins.js';
import { premium } from '../../../theme/premium.js';
import type { TrackId } from '../../../daw/model/types.js';

const SLOT_COUNT = 10;
const SLOT_NAMES = 'ABCDEFGHIJ';

const CATEGORY_LABEL: Record<string, string> = {
  utility: '유틸리티', eq: 'EQ', dynamics: '다이내믹스',
  delay: '딜레이', reverb: '리버브', restore: '복원', pitch: '피치',
};

export default function InsertRack({ trackId, anchorY }: { trackId: TrackId; anchorY: number }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const openWindow = usePluginWindowStore((s) => s.open);
  const toggleRack = usePluginWindowStore((s) => s.toggleRack);
  const [picking, setPicking] = useState<number | null>(null);

  const track = findTrack(session, trackId);
  if (!track) return null;

  const bySlot = new Map(track.inserts.map((i) => [i.slot, i]));

  const addPlugin = (slot: number, pluginId: string): void => {
    const descriptor = findPlugin(pluginId);
    if (!descriptor) return;
    apply((s) => setInsert(s, trackId, createInsert(slot, pluginId, descriptor.name, {
      params: defaultParams(pluginId),
      latencySamples: descriptor.latencyFor(defaultParams(pluginId), s.sampleRate),
    })));
    setPicking(null);
    // Straight into the window: adding a device you cannot see is not a step
    // anyone wants on its own.
    openWindow(trackId, slot);
  };

  return (
    <div
      className="fixed rounded-xl overflow-hidden flex flex-col"
      style={{
        left: 176, top: Math.max(56, anchorY), zIndex: 190, width: 236,
        maxHeight: '70vh',
        background: premium.surface.frame,
        border: `1px solid ${premium.accent.deep}`,
        boxShadow: premium.shadow.panel,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 h-8 shrink-0"
        style={{ background: premium.gradient.frame, borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="w-2 h-2 rounded-full" style={{ background: track.color }} />
        <span
          className="text-[11px] flex-1 truncate"
          style={{ fontFamily: premium.type.display, color: premium.accent.light }}
        >{track.name} — 인서트</span>
        <button
          onClick={() => toggleRack(null)}
          className="h-5 w-5 text-[12px] leading-none"
          style={{ color: premium.text.muted }}
        >×</button>
      </div>

      <div className="overflow-y-auto p-1.5 flex flex-col gap-0.5">
        {Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const insert = bySlot.get(slot);
          const descriptor = insert ? findPlugin(insert.pluginId) : undefined;

          return (
            <div key={slot} className="flex items-center gap-1.5">
              <span
                className="w-4 text-[10px] font-mono text-center shrink-0"
                style={{ color: premium.text.faint }}
              >{SLOT_NAMES[slot]}</span>

              {insert && descriptor ? (
                <>
                  <button
                    onClick={() => openWindow(trackId, slot)}
                    className="flex-1 h-7 px-2 rounded text-left text-[11px] truncate transition-colors"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: insert.bypass ? premium.text.faint : premium.text.primary,
                      textDecoration: insert.bypass ? 'line-through' : 'none',
                    }}
                    title="열기"
                  >{descriptor.name}</button>
                  <button
                    onClick={() => apply((s) => setInsert(s, trackId, { ...insert, bypass: !insert.bypass }))}
                    title="바이패스"
                    className="w-6 h-7 rounded text-[9px] shrink-0"
                    style={{
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: insert.bypass ? premium.accent.danger : premium.text.muted,
                    }}
                  >○</button>
                  <button
                    onClick={() => apply((s) => removeInsert(s, trackId, slot))}
                    title="제거"
                    className="w-6 h-7 rounded text-[11px] leading-none shrink-0"
                    style={{ border: '1px solid rgba(255,255,255,0.1)', color: premium.text.muted }}
                  >×</button>
                </>
              ) : (
                <button
                  onClick={() => setPicking(picking === slot ? null : slot)}
                  className="flex-1 h-7 px-2 rounded text-left text-[11px] transition-colors"
                  style={{
                    border: '1px dashed rgba(255,255,255,0.12)',
                    color: picking === slot ? premium.accent.light : premium.text.faint,
                  }}
                >{picking === slot ? '플러그인 선택…' : '비어 있음'}</button>
              )}
            </div>
          );
        })}
      </div>

      {picking !== null && (
        <div
          className="overflow-y-auto p-1.5 flex flex-col gap-0.5 shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)', maxHeight: 220 }}
        >
          {PLUGINS.map((plugin) => (
            <button
              key={plugin.id}
              onClick={() => addPlugin(picking, plugin.id)}
              className="h-7 px-2 rounded text-left text-[11px] flex items-center gap-2"
              style={{ color: premium.text.secondary }}
            >
              <span className="flex-1 truncate">{plugin.name}</span>
              <span className="text-[9px]" style={{ color: premium.text.faint }}>
                {CATEGORY_LABEL[plugin.category] ?? plugin.category}
              </span>
              {plugin.offline && (
                <span className="text-[8px]" style={{ color: 'rgb(251,191,36)' }}>OFFLINE</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
