/**
 * InsertRack — the plugin chain on a track.
 *
 * A DAW channel's inserts: an ordered list of processors you add, switch
 * off, remove and open. The plugins are the twenty-five modules the app
 * already ships — the same code the mastering chain runs, the same
 * parameters, the same Korean explanations — so a compressor added here is
 * the compressor the export uses, not a lookalike.
 *
 * # What a track may not host
 *
 * The limiter and the export stage are missing from the picker on purpose.
 * They belong to the master bus: a limiter on every channel flattens the
 * balance the mixer exists to set, and dither belongs once, at the final
 * word-length reduction. `stem-studio.ts` strips them on the way to the
 * engine anyway; leaving them out of the picker means the user is never
 * offered something that will be silently discarded.
 *
 * # Order is display order, not signal order
 *
 * The engine runs its modules in a fixed internal order — restoration, then
 * tone, then dynamics, then character, then space, then stereo — and that is
 * a property of the chain, not something a host reorders. So the rack lists
 * inserts in that same order rather than letting them be dragged into an
 * arrangement the engine would ignore. Showing a movable list that does not
 * move the audio would be worse than showing a fixed one.
 */

import React, { useMemo, useState } from 'react';
import { MODULE_IDS, type ModuleId, type ParameterValue } from '../../audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../audio/parameters/module-parameter-definitions.js';
import { MODULE_GLOSSARY } from '../../audio/parameters/parameter-glossary.js';
import { RECOMMENDED } from '../../audio/presets/recommended-defaults.js';

/** Modules that belong to the master bus and are never offered on a track. */
export const TRACK_FORBIDDEN: readonly ModuleId[] = ['limiter', 'export'] as const;

/**
 * The order the engine runs its stages in.
 *
 * Listed explicitly rather than derived, because the rack's whole claim is
 * that what you see is what the audio does. A module missing from here would
 * still work but would sort to the end, which would be a quiet lie about
 * where it sits.
 */
export const ENGINE_ORDER: readonly ModuleId[] = [
  'declick', 'dehum', 'denoise', 'deess', 'top-rebuild',
  'match-eq', 'spectral-shaper', 'hiss-gate', 'stabilizer',
  'parametric-eq', 'eq', 'vintage-eq', 'dynamic-eq',
  'multiband', 'dynamics', 'vintage-comp', 'impact', 'low-end-focus',
  'exciter', 'tape',
  'delay', 'reverb',
  'imager', 'limiter', 'export',
] as const;

export const PICKER_GROUPS: ReadonlyArray<{ label: string; modules: ModuleId[] }> = [
  { label: '복원 · 잡음 제거', modules: ['declick', 'dehum', 'denoise', 'deess', 'hiss-gate', 'top-rebuild'] },
  { label: '톤 · EQ', modules: ['parametric-eq', 'eq', 'vintage-eq', 'dynamic-eq', 'match-eq', 'spectral-shaper', 'stabilizer'] },
  { label: '컴프레서 계열', modules: ['multiband', 'dynamics', 'vintage-comp', 'impact', 'low-end-focus'] },
  { label: '캐릭터', modules: ['exciter', 'tape'] },
  { label: '공간', modules: ['delay', 'reverb'] },
  { label: '스테레오', modules: ['imager'] },
];

export interface InsertState {
  id: ModuleId;
  bypass: boolean;
  parameters: Record<string, ParameterValue>;
}

export interface InsertRackProps {
  /** Modules currently on the track, in any order. */
  inserts: InsertState[];
  /** Which insert's parameters are open, if any. */
  openId: ModuleId | null;
  onOpen: (id: ModuleId | null) => void;
  onAdd: (id: ModuleId) => void;
  onRemove: (id: ModuleId) => void;
  onToggleBypass: (id: ModuleId) => void;
  /** Disabled when no track is selected. */
  disabled?: boolean;
}

export function moduleLabel(id: ModuleId): string {
  return MODULE_GLOSSARY[id]?.ko ?? id;
}

/** Inserts sorted the way the engine runs them. */
export function inEngineOrder(inserts: readonly InsertState[]): InsertState[] {
  const rank = new Map(ENGINE_ORDER.map((id, i) => [id, i]));
  return [...inserts].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

/** Modules that may be added to a track and are not already on it. */
export function addableModules(inserts: readonly InsertState[]): ModuleId[] {
  const present = new Set(inserts.map((i) => i.id));
  return MODULE_IDS.filter((id) =>
    !present.has(id) &&
    !TRACK_FORBIDDEN.includes(id) &&
    ALL_MODULE_PARAMETER_DEFS[id].parameters.length > 0);
}

/** A module's starting values — the app's own recommendation for it. */
export function startingValues(id: ModuleId): { bypass: boolean; parameters: Record<string, ParameterValue> } {
  const rec = RECOMMENDED[id];
  const defaults: Record<string, ParameterValue> = {};
  for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
    defaults[p.id] = p.kind === 'number' ? p.default
      : p.kind === 'enum' ? p.default
      : p.default;
  }
  return {
    // A plugin the user just added is on. `off: true` in the recommendation
    // means "not usually needed on a master" — but the user asked for this
    // one by name, so switching it off on arrival would be answering a
    // different question.
    bypass: false,
    parameters: { ...defaults, ...(rec?.parameters ?? {}) },
  };
}

export default function InsertRack(props: InsertRackProps): React.ReactElement {
  const { inserts, openId, onOpen, onAdd, onRemove, onToggleBypass, disabled = false } = props;
  const [picking, setPicking] = useState(false);

  const ordered = useMemo(() => inEngineOrder(inserts), [inserts]);
  const addable = useMemo(() => addableModules(inserts), [inserts]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-widest text-slate-600">Inserts</span>
        <span className="text-[9px] text-slate-500 tabular-nums">{inserts.length}</span>
      </div>

      {/* Slots */}
      <div className="space-y-px">
        {ordered.length === 0 && (
          <div className="text-[10px] text-slate-500 px-1.5 py-1.5 border border-dashed border-slate-200 rounded-sm text-center">
            비어 있음
          </div>
        )}
        {ordered.map((ins) => (
          <div
            key={ins.id}
            className={`group flex items-center gap-1 px-1.5 py-1 rounded-sm border transition-colors
                        ${openId === ins.id
                          ? 'bg-slate-200 border-slate-400'
                          : 'bg-slate-100/70 border-slate-200 hover:border-slate-300'}`}
          >
            <button
              onClick={() => onToggleBypass(ins.id)}
              className={`w-2 h-2 rounded-full shrink-0 transition-colors
                          ${ins.bypass ? 'bg-slate-300' : 'bg-emerald-600'}`}
              title={ins.bypass ? '꺼짐 — 눌러서 켜기' : '켜짐 — 눌러서 끄기'}
            />
            <button
              onClick={() => onOpen(openId === ins.id ? null : ins.id)}
              className={`flex-1 min-w-0 text-left text-[10px] truncate
                          ${ins.bypass ? 'text-slate-600 line-through' : 'text-slate-700'}`}
              title={MODULE_GLOSSARY[ins.id]?.plain ?? ''}
            >
              {moduleLabel(ins.id)}
            </button>
            <button
              onClick={() => onRemove(ins.id)}
              className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-600 text-[10px] leading-none shrink-0"
              title="이 플러그인 제거"
            >✕</button>
          </div>
        ))}
      </div>

      <button
        onClick={() => setPicking((v) => !v)}
        disabled={disabled || addable.length === 0}
        className="w-full text-[10px] py-1 rounded-sm border border-slate-300 text-slate-700
                   hover:border-slate-400 disabled:opacity-30 transition-colors"
      >
        {picking ? '닫기' : '+ 플러그인 추가'}
      </button>

      {picking && (
        <div className="border border-slate-200 rounded-sm bg-slate-100/90 max-h-60 overflow-y-auto">
          {PICKER_GROUPS.map((group) => {
            const items = group.modules.filter((m) => addable.includes(m));
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="border-b border-slate-300 last:border-0">
                <div className="px-1.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-widest text-slate-500">
                  {group.label}
                </div>
                {items.map((m) => (
                  <button
                    key={m}
                    onClick={() => { onAdd(m); setPicking(false); onOpen(m); }}
                    className="w-full text-left px-1.5 py-1 text-[10px] text-slate-600
                               hover:bg-slate-200 hover:text-slate-900 transition-colors"
                    title={MODULE_GLOSSARY[m]?.plain ?? ''}
                  >
                    {moduleLabel(m)}
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
