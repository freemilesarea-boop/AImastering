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
import type { PluginCategory } from '../../../daw/engine/plugin-kit.js';
import { defaultParams } from '../../../daw/engine/plugins.js';
import { premium } from '../../../theme/premium.js';
import type { TrackId } from '../../../daw/model/types.js';

const SLOT_COUNT = 10;
const SLOT_NAMES = 'ABCDEFGHIJ';

/**
 * Categories in signal-chain order, not alphabetical.
 *
 * A picker that opens on "Delay" because D comes first is a picker you read
 * every time.  This is the order a channel is actually built in — clean it up,
 * shape it, control it, colour it, move it, place it — so the group you want
 * is where your eye already is.
 */
const CATEGORY_ORDER: ReadonlyArray<{ id: PluginCategory; label: string; hint: string }> = [
  { id: 'utility',    label: '유틸리티',   hint: '게인 · 위상 · DC' },
  { id: 'eq',         label: 'EQ',        hint: '주파수 균형' },
  { id: 'dynamics',   label: '다이내믹스', hint: '레벨 제어' },
  { id: 'saturation', label: '새추레이션', hint: '배음 · 색깔' },
  { id: 'modulation', label: '모듈레이션', hint: '코러스 · 페이저' },
  { id: 'delay',      label: '딜레이',     hint: '반복' },
  { id: 'reverb',     label: '리버브',     hint: '공간' },
  { id: 'imaging',    label: '이미징',     hint: '스테레오 폭' },
  { id: 'pitch',      label: '피치',      hint: '음정' },
  { id: 'restore',    label: '복원',      hint: '노이즈 · 험' },
  { id: 'master',     label: '마스터',    hint: '미터 · 디더' },
];


/** Loose match, so "comp" finds the Compressor and "eq" finds all of them. */
function matches(name: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}

export default function InsertRack({ trackId, anchorY }: { trackId: TrackId; anchorY: number }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const openWindow = usePluginWindowStore((s) => s.open);
  const toggleRack = usePluginWindowStore((s) => s.toggleRack);
  const [picking, setPicking] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  // Dynamics and EQ open by default: on a real channel that is where four out
  // of five devices come from.
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['eq', 'dynamics']));

  const toggleCategory = (id: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
    setFilter('');
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
          className="overflow-y-auto shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)', maxHeight: 300 }}
        >
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="플러그인 검색"
            autoFocus
            className="w-full h-7 px-2.5 text-[11px] bg-transparent outline-none"
            style={{ color: premium.text.primary, borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          />

          {CATEGORY_ORDER.map((category) => {
            const devices = PLUGINS.filter(
              (plugin) => plugin.category === category.id && matches(plugin.name, filter),
            );
            if (devices.length === 0) return null;
            // Searching opens everything: hunting through folders for a match
            // the app already found is work the app should have done.
            const open = filter.trim().length > 0 || expanded.has(category.id);

            return (
              <div key={category.id}>
                <button
                  onClick={() => toggleCategory(category.id)}
                  className="w-full h-7 px-2 flex items-center gap-1.5 text-left"
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                >
                  <span
                    className="text-[9px] w-2 shrink-0"
                    style={{ color: premium.text.faint }}
                  >{open ? '▾' : '▸'}</span>
                  <span
                    className="text-[10px] tracking-wide"
                    style={{ color: open ? premium.accent.light : premium.text.secondary }}
                  >{category.label}</span>
                  <span className="text-[9px] flex-1 truncate" style={{ color: premium.text.faint }}>
                    {category.hint}
                  </span>
                  <span className="text-[9px]" style={{ color: premium.text.faint }}>
                    {devices.length}
                  </span>
                </button>

                {open && devices.map((plugin) => (
                  <button
                    key={plugin.id}
                    onClick={() => addPlugin(picking, plugin.id)}
                    className="w-full h-7 pl-6 pr-2 rounded text-left text-[11px] flex items-center gap-2
                               hover:bg-white/5 transition-colors"
                    style={{ color: premium.text.secondary }}
                  >
                    <span className="flex-1 truncate">{plugin.name}</span>
                    {plugin.freeRunning && (
                      <span
                        className="text-[8px]"
                        style={{ color: premium.text.faint }}
                        title="LFO 위상이 재생 위치가 아니라 오디오 컨텍스트를 따릅니다"
                      >LFO</span>
                    )}
                    {plugin.offline && (
                      <span className="text-[8px]" style={{ color: 'rgb(251,191,36)' }}>OFFLINE</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
