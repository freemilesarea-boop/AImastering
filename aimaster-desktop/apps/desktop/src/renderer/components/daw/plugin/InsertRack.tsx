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
import {
  descriptorFor, externalParams, REFERENCE_PLUGIN, REFERENCE_PLUGIN_ID,
} from '../../../daw/engine/external-device.js';
import type { ExternalPluginRef } from '../../../daw/model/types.js';
import type { PluginCategory } from '../../../daw/engine/plugin-kit.js';
import { defaultParams } from '../../../daw/engine/plugins.js';
import {
  captureRack, createRackPreset, describeRack, loadRack, missingDevices,
} from '../../../daw/model/rack-preset.js';
import {
  deleteRack, describeImport, exportRacks, importRacks, listRacks, overwriteRack,
  saveRack,
} from '../../../daw/engine/rack-store.js';
import { useAppStore } from '../../../stores/appStore.js';
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
  const notify = useAppStore((s) => s.notify);
  const [picking, setPicking] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  // The rack store lives outside React, so saving or deleting has to say so.
  const [rackTick, setRackTick] = useState(0);
  const [savingRack, setSavingRack] = useState<string | null>(null);
  // The rack that was last loaded onto this track — what 덮어쓰기 and 삭제
  // act on.  Cleared when it is deleted, or when the picker goes back to none.
  const [activeRack, setActiveRack] = useState<string | null>(null);
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

  /** Put an installed (or reference) device in a slot as an offline insert. */
  const addExternal = (slot: number, pluginId: string, ref: ExternalPluginRef): void => {
    apply((s) => setInsert(s, trackId, createInsert(slot, pluginId, ref.name, {
      external: ref,
      params: Object.fromEntries(
        externalParams(ref).map((param) => [param.id, param.default]),
      ),
    })));
    setPicking(null);
    setFilter('');
    openWindow(trackId, slot);
  };

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

  // `rackTick` is read so the list rebuilds after a save, a delete or an
  // import — none of which go through React state.
  void rackTick;
  const racks = listRacks();

  const commitRackSave = (): void => {
    const captured = captureRack(track);
    if (captured.devices.length === 0) {
      notify('저장할 인서트가 없습니다', 'warning');
      return;
    }
    const preset = createRackPreset('', savingRack ?? '', captured.devices);
    const result = saveRack(savingRack ?? '', preset);
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    setSavingRack(null);
    setActiveRack(result.rack.id);
    setRackTick((n) => n + 1);
    notify(`랙 "${result.rack.name}" 저장 — ${describeRack(result.rack)}`);
    // Third-party plugins cannot travel in a rack, and losing one silently is
    // exactly the kind of thing that is discovered a week later.
    if (captured.skipped.length > 0) {
      notify(`서드파티 플러그인은 랙에 담기지 않습니다 — ${captured.skipped.join(', ')}`, 'warning');
    }
  };

  const loadNamedRack = (rackId: string): void => {
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) { setActiveRack(null); return; }
    setActiveRack(rack.id);
    const missing = missingDevices(rack);
    apply((s) => {
      const result = loadRack(s, trackId, rack, 'replace');
      if (result.problems.length > 0) {
        for (const problem of result.problems.slice(0, 3)) notify(problem, 'warning');
      }
      return result.session;
    });
    notify(missing.length > 0
      ? `"${rack.name}" 로드 — ${missing.length}개 장치는 이 빌드에 없습니다`
      : `"${rack.name}" 로드 — ${describeRack(rack)}`);
  };

  /** Update the loaded rack to whatever the chain is now. */
  const overwriteActiveRack = (): void => {
    const rack = racks.find((r) => r.id === activeRack);
    if (!rack) return;
    const captured = captureRack(track);
    const result = overwriteRack(rack.id, captured.devices);
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    setRackTick((n) => n + 1);
    notify(`"${result.rack.name}" 덮어썼습니다 — ${describeRack(result.rack)}`);
    if (captured.skipped.length > 0) {
      notify(`서드파티 플러그인은 랙에 담기지 않습니다 — ${captured.skipped.join(', ')}`, 'warning');
    }
  };

  const deleteActiveRack = (): void => {
    const rack = racks.find((r) => r.id === activeRack);
    if (!rack) return;
    if (!deleteRack(rack.id)) { notify('랙을 지울 수 없습니다', 'warning'); return; }
    setActiveRack(null);
    setRackTick((n) => n + 1);
    notify(`"${rack.name}" 삭제`);
  };

  const exportRackFile = async (): Promise<void> => {
    const api = globalThis.window?.electronAPI;
    if (!api) { notify('파일 저장을 사용할 수 없습니다', 'warning'); return; }
    if (racks.length === 0) { notify('내보낼 랙이 없습니다', 'warning'); return; }
    try {
      const dest = await api.invoke('daw:racks-export', exportRacks()) as string | null;
      if (dest) notify(`랙을 내보냈습니다 — ${dest}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const importRackFile = async (): Promise<void> => {
    const api = globalThis.window?.electronAPI;
    if (!api) { notify('파일 열기를 사용할 수 없습니다', 'warning'); return; }
    try {
      const json = await api.invoke('daw:racks-import') as string | null;
      if (!json) return;
      const report = importRacks(json);
      setRackTick((n) => n + 1);
      notify(describeImport(report), report.added === 0 ? 'warning' : 'info');
      for (const reason of report.reasons.slice(0, 3)) notify(reason, 'warning');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
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

      {/* The whole chain, under one name.  A device preset is one box; this is
          "my vocal chain" — the thing people actually rebuild on every song. */}
      <div className="px-3 py-1.5 flex flex-col gap-1 shrink-0"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>랙</span>
          <select
            value={activeRack ?? ''}
            onChange={(e) => loadNamedRack(e.target.value)}
            disabled={racks.length === 0}
            title={racks.length === 0 ? '저장된 랙이 없습니다' : '이 트랙의 인서트를 저장된 랙으로 교체합니다'}
            className="flex-1 h-5 px-1 text-[9.5px] rounded bg-transparent outline-none"
            style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <option value="">{racks.length === 0 ? '— 저장된 랙 없음 —' : '— 랙 불러오기 —'}</option>
            {racks.map((rack) => (
              <option key={rack.id} value={rack.id}>{rack.name}</option>
            ))}
          </select>
          <button
            onClick={() => setSavingRack(savingRack === null ? '' : null)}
            title="지금 인서트 체인 전체를 랙으로 저장"
            className="h-5 w-5 rounded text-[12px] leading-none shrink-0"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              color: savingRack === null ? premium.text.muted : premium.accent.base,
            }}
          >+</button>
        </div>

        {savingRack !== null && (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={savingRack}
              maxLength={60}
              placeholder="랙 이름"
              onChange={(e) => setSavingRack(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRackSave();
                if (e.key === 'Escape') setSavingRack(null);
              }}
              className="flex-1 h-5 px-1.5 text-[9.5px] rounded bg-transparent outline-none"
              style={{ color: premium.text.primary, border: `1px solid ${premium.accent.deep}` }}
            />
            <button onClick={commitRackSave} style={rackButton(premium.accent.base)}>저장</button>
            <button onClick={() => setSavingRack(null)} style={rackButton(premium.text.muted)}>취소</button>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {activeRack !== null && racks.some((r) => r.id === activeRack) && (
            <>
              <button onClick={overwriteActiveRack} title="지금 체인으로 이 랙을 갱신합니다"
                      style={rackLink(premium.text.muted)}>덮어쓰기</button>
              <button onClick={deleteActiveRack} title="이 랙을 지웁니다"
                      style={rackLink(premium.accent.danger)}>삭제</button>
            </>
          )}
          <button onClick={() => void exportRackFile()} title="저장한 랙 전체를 파일로 저장합니다"
                  style={rackLink(premium.text.faint)}>내보내기</button>
          <button onClick={() => void importRackFile()} title="랙 파일을 읽어 옵니다"
                  style={rackLink(premium.text.faint)}>가져오기</button>
        </div>
      </div>

      <div className="overflow-y-auto p-1.5 flex flex-col gap-0.5">
        {Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const insert = bySlot.get(slot);
          const descriptor = insert ? descriptorFor(insert) : undefined;

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

          <button
            onClick={() => usePluginWindowStore.getState().openManagerForSlot(trackId, picking)}
            className="w-full h-7 px-2 flex items-center gap-1.5 text-left"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="text-[9px] w-2 shrink-0" style={{ color: premium.text.faint }}>▸</span>
            <span className="text-[10px] flex-1" style={{ color: premium.text.secondary }}>
              서드파티 (VST3 · AU · CLAP)
            </span>
            <span className="text-[9px]" style={{ color: premium.text.faint }}>설치된 것 보기</span>
          </button>

          {/* The device that proves the host path works, without needing a
              third-party plugin installed to try it. */}
          {matches(REFERENCE_PLUGIN.name, filter) && (
            <button
              onClick={() => addExternal(picking, REFERENCE_PLUGIN_ID, REFERENCE_PLUGIN)}
              className="w-full h-7 pl-6 pr-2 rounded text-left text-[11px] flex items-center gap-2
                         hover:bg-white/5 transition-colors"
              style={{ color: premium.text.secondary }}
            >
              <span className="flex-1 truncate">{REFERENCE_PLUGIN.name}</span>
              <span className="text-[8px]" style={{ color: 'rgb(251,191,36)' }}>OFFLINE</span>
            </button>
          )}

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

/** A small filled button for the rack save row. */
function rackButton(color: string): React.CSSProperties {
  return {
    height: 20, padding: '0 6px', borderRadius: 3, fontSize: 9,
    border: '1px solid rgba(255,255,255,0.14)', color, background: 'transparent',
  };
}

/** A text-weight action, so the row does not read as more controls. */
function rackLink(color: string): React.CSSProperties {
  return {
    fontSize: 8.5, letterSpacing: '0.04em', color,
    background: 'transparent', border: 'none', padding: 0,
    textDecoration: 'underline', textUnderlineOffset: 2,
  };
}
