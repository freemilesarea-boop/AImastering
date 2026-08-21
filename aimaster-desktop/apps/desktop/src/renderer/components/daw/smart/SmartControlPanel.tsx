// SmartControlPanel — one knob moves five processors, and Advanced shows all
// of them.
//
// The two views are the whole point:
//
//   CONTROLS  — seven macros in three engraved groups.  A beginner never has
//               to know that PUNCH is a transient designer, a compressor and
//               an EQ curve moving together.
//   ADVANCED  — every resulting parameter, live, with the macros that drove
//               it named next to the value.  Edit one and it pins (shown in
//               the cool accent) until the reset arrow hands it back.
//
// Both views read `materializeRack`, which is also what the audio engine
// reads, so the numbers on screen are literally the numbers being rendered.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, updateTrack } from '../../../daw/model/session-ops.js';
import {
  MACRO_PRESETS, materializeRack, setMacro, setOverride, clearOverride,
  explainMacro, findMacro,
  type MacroDef, type MacroId, type MacroRack, type RackModuleId,
} from '../../../daw/model/macros.js';
import { findPlugin } from '../../../daw/engine/plugins.js';
import { premium } from '../../../theme/premium.js';
import Knob from './Knob.js';

type View = 'controls' | 'advanced';

const GROUPS: Array<{ title: string; macros: MacroId[] }> = [
  { title: 'Tone',     macros: ['warmth', 'clarity', 'air'] },
  { title: 'Dynamics', macros: ['punch', 'loudness'] },
  { title: 'Space',    macros: ['width', 'depth'] },
];

export default function SmartControlPanel() {
  const trackId = useDawStore((s) => s.smartTrackId);
  const close   = useDawStore((s) => s.openSmartControls);
  const session = useDawStore((s) => s.session);
  const apply   = useDawStore((s) => s.apply);
  const applyT  = useDawStore((s) => s.applyTransient);
  const commit  = useDawStore((s) => s.commitEdit);
  const notify  = useAppStore((s) => s.notify);
  const [view, setView] = useState<View>('controls');

  const track = trackId ? findTrack(session, trackId) : undefined;
  const rack: MacroRack = track?.macros ?? { enabled: false, values: {}, overrides: {} };
  const resolved = useMemo(() => materializeRack(rack), [rack]);

  if (!track || !trackId) return null;

  const write = (next: MacroRack, transient = false): void => {
    const mutate = (s: typeof session) => updateTrack(s, trackId, (t) => ({ ...t, macros: next }));
    if (transient) applyT(mutate); else apply(mutate);
  };

  const activeCount = resolved.filter((m) => m.active).length;

  return (
    <div
      className="fixed inset-0 z-[8500] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.66)', backdropFilter: 'blur(6px)' }}
      onClick={() => close(null)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(94vw, 880px)',
          maxHeight: '86vh',
          background: premium.surface.panel,
          backgroundImage: premium.gradient.panel,
          border: `1px solid ${premium.surface.hairline}`,
          borderRadius: 16,
          boxShadow: premium.shadow.panel,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          className="flex items-center gap-3 px-5 py-3"
          style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}
        >
          <div className="min-w-0">
            <p style={{
              fontFamily: premium.type.display,
              fontSize: 20,
              letterSpacing: '0.02em',
              color: premium.accent.light,
              lineHeight: 1.1,
            }}>Smart Controls</p>
            <p style={{
              fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted,
            }} className="truncate">{track.name}</p>
          </div>

          <div className="flex-1" />

          <select
            value=""
            onChange={(e) => {
              const preset = MACRO_PRESETS.find((p) => p.id === e.target.value);
              if (!preset) return;
              write({ ...rack, enabled: true, values: { ...preset.values } });
              notify(`${preset.name} — ${preset.description}`);
            }}
            style={selectStyle}
          >
            <option value="">프리셋…</option>
            {MACRO_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {p.description}</option>
            ))}
          </select>

          <button
            onClick={() => write({ ...rack, enabled: !rack.enabled })}
            title="랙 전체를 우회해 원래 소리와 비교합니다"
            style={{
              ...pillStyle,
              color: rack.enabled ? premium.text.onAccent : premium.text.secondary,
              background: rack.enabled ? premium.accent.base : 'transparent',
              borderColor: rack.enabled ? premium.accent.base : premium.surface.hairlineStrong,
            }}
          >{rack.enabled ? 'ON' : 'BYPASS'}</button>

          <div className="flex rounded-lg overflow-hidden"
               style={{ border: `1px solid ${premium.surface.hairlineStrong}` }}>
            {(['controls', 'advanced'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  ...tabStyle,
                  color: view === v ? premium.text.onAccent : premium.text.secondary,
                  background: view === v ? premium.accent.base : 'transparent',
                }}
              >{v === 'controls' ? 'CONTROLS' : 'ADVANCED'}</button>
            ))}
          </div>

          <button onClick={() => close(null)} style={{ ...pillStyle, borderColor: 'transparent' }}>✕</button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto" style={{ background: premium.surface.abyss }}>
          {view === 'controls' ? (
            <div className="flex flex-wrap gap-4 p-5 justify-center">
              {GROUPS.map((group) => (
                <ModuleFrame key={group.title} title={group.title}>
                  <div className="flex items-start gap-6 px-5 py-4">
                    {group.macros.map((id) => {
                      const macro = findMacro(id);
                      if (!macro) return null;
                      return (
                        <MacroKnob
                          key={id}
                          macro={macro}
                          value={rack.values[id] ?? 0}
                          disabled={!rack.enabled}
                          onChange={(v) => write(setMacro({ ...rack, enabled: true }, id, v), true)}
                          onCommit={commit}
                        />
                      );
                    })}
                  </div>
                </ModuleFrame>
              ))}
            </div>
          ) : (
            <AdvancedTable
              rack={rack}
              onOverride={(module, param, value) =>
                write(setOverride({ ...rack, enabled: true }, module, param, value), true)}
              onCommit={commit}
              onReset={(module, param) => write(clearOverride(rack, module, param))}
            />
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div
          className="flex items-center gap-3 px-5 py-2"
          style={{
            borderTop: `1px solid ${premium.surface.hairline}`,
            background: premium.surface.panel,
          }}
        >
          <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.faint }}>
            {activeCount}개 모듈 활성 · {Object.keys(rack.overrides).length}개 수동 조정
          </span>
          <div className="flex-1" />
          <button
            onClick={() => { write({ enabled: rack.enabled, values: {}, overrides: {} }); notify('매크로를 초기화했습니다'); }}
            style={{ ...pillStyle, borderColor: premium.surface.hairlineStrong }}
          >초기화</button>
        </div>
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function ModuleFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        borderRadius: 12,
        border: `1px solid ${premium.surface.engrave}`,
        background: premium.surface.frame,
        backgroundImage: premium.gradient.frame,
        boxShadow: premium.shadow.frame,
      }}
    >
      <div className="text-center pt-3">
        <span style={{
          fontFamily: premium.type.display,
          fontSize: 17,
          fontStyle: 'italic',
          color: premium.accent.light,
          letterSpacing: '0.03em',
        }}>{title}</span>
      </div>
      {children}
    </section>
  );
}

function MacroKnob({
  macro, value, disabled, onChange, onCommit,
}: {
  macro: MacroDef;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  const percent = macro.bipolar
    ? `${value > 0 ? '+' : ''}${Math.round(value * 100)}`
    : `${Math.round(value * 100)}`;
  const explanation = explainMacro(macro, value);
  const tooltip = [macro.description, ...explanation].join('\n');

  return (
    <div className="flex flex-col items-center gap-1.5" style={{ width: 74 }}>
      <span style={{
        fontFamily: premium.type.display,
        fontSize: 13,
        fontStyle: 'italic',
        color: premium.text.secondary,
      }}>{macro.name}</span>
      <Knob
        value={value}
        min={macro.bipolar ? -1 : 0}
        max={1}
        defaultValue={0}
        bipolar={macro.bipolar ?? false}
        size={60}
        display={percent}
        disabled={disabled}
        onChange={onChange}
        onCommit={onCommit}
        title={tooltip}
        label={macro.label}
      />
    </div>
  );
}

function AdvancedTable({
  rack, onOverride, onCommit, onReset,
}: {
  rack: MacroRack;
  onOverride: (module: RackModuleId, param: string, value: number) => void;
  onCommit: () => void;
  onReset: (module: RackModuleId, param: string) => void;
}) {
  const resolved = materializeRack(rack);
  return (
    <div className="p-4 space-y-3">
      {resolved.map((module) => {
        const plugin = findPlugin(module.module.pluginId);
        return (
          <div
            key={module.module.id}
            style={{
              borderRadius: 10,
              border: `1px solid ${module.active ? premium.surface.engrave : premium.surface.hairline}`,
              background: premium.surface.well,
              backgroundImage: premium.gradient.well,
              opacity: module.active ? 1 : 0.55,
            }}
          >
            <div className="flex items-baseline gap-2 px-3 py-1.5"
                 style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
              <span style={{
                fontFamily: premium.type.display, fontSize: 14, fontStyle: 'italic',
                color: module.active ? premium.accent.light : premium.text.muted,
              }}>{module.module.name}</span>
              <span style={{ fontFamily: premium.type.mono, fontSize: 9, color: premium.text.faint }}>
                slot {module.module.slot + 1} · {module.module.pluginId}
              </span>
              {!module.active && (
                <span style={{ fontFamily: premium.type.sans, fontSize: 9, color: premium.text.faint }}>
                  비활성 (신호 경로에서 제외)
                </span>
              )}
            </div>

            <div className="px-3 py-2 space-y-1">
              {module.params.map((param) => {
                const def = plugin?.params.find((p) => p.id === param.param);
                return (
                  <div key={param.param} className="flex items-center gap-2">
                    <span style={{
                      fontFamily: premium.type.sans, fontSize: 10,
                      color: premium.text.secondary, width: 92,
                    }}>{def?.name ?? param.param}</span>

                    <input
                      type="range"
                      min={def?.min ?? 0}
                      max={def?.max ?? 1}
                      step={((def?.max ?? 1) - (def?.min ?? 0)) / 200}
                      value={param.value}
                      onChange={(e) => onOverride(param.module, param.param, parseFloat(e.target.value))}
                      onMouseUp={onCommit}
                      className="flex-1 h-1"
                      style={{ accentColor: param.overridden ? premium.accent.cool : premium.accent.base }}
                    />

                    <span style={{
                      fontFamily: premium.type.mono, fontSize: 10, width: 74, textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      color: param.overridden ? premium.accent.cool : premium.text.primary,
                    }}>
                      {formatValue(param.value)}{def?.unit ? ` ${def.unit}` : ''}
                    </span>

                    <span style={{
                      fontFamily: premium.type.sans, fontSize: 9, width: 108,
                      color: premium.text.faint,
                    }} className="truncate">
                      {param.overridden
                        ? `수동 (매크로 ${formatValue(param.macroValue)})`
                        : param.drivenBy.length > 0
                          ? param.drivenBy.map((m) => m.toUpperCase()).join(' + ')
                          : '—'}
                    </span>

                    <button
                      onClick={() => onReset(param.module, param.param)}
                      disabled={!param.overridden}
                      title="매크로 값으로 되돌리기"
                      style={{
                        width: 20, height: 20, borderRadius: 5,
                        border: `1px solid ${param.overridden ? premium.surface.hairlineStrong : 'transparent'}`,
                        background: 'transparent',
                        color: param.overridden ? premium.accent.cool : premium.text.faint,
                        cursor: param.overridden ? 'pointer' : 'default',
                        fontSize: 11,
                      }}
                    >↺</button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

const pillStyle: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 8,
  border: `1px solid ${premium.surface.hairlineStrong}`,
  background: 'transparent',
  color: premium.text.secondary,
  fontFamily: premium.type.sans,
  fontSize: 10,
  letterSpacing: '0.1em',
  cursor: 'pointer',
};

const tabStyle: React.CSSProperties = {
  height: 26,
  padding: '0 12px',
  border: 'none',
  fontFamily: premium.type.sans,
  fontSize: 10,
  letterSpacing: '0.12em',
  cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
  height: 26,
  borderRadius: 8,
  border: `1px solid ${premium.surface.hairlineStrong}`,
  background: premium.surface.well,
  color: premium.text.secondary,
  fontFamily: premium.type.sans,
  fontSize: 10,
  padding: '0 8px',
  maxWidth: 220,
};
