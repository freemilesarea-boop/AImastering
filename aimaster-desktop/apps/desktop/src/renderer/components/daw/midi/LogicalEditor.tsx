// LogicalEditor — the rule builder.
//
// Every control here edits a Rule, and the sentence under the header is that
// rule read back in words.  That line is the point of the panel: a rule made
// of dropdowns is easy to build and hard to read, and a rule you cannot read
// is a rule you run on a take and then undo.
//
// Nothing runs until 실행 is pressed, and 미리보기 says how many notes the
// conditions currently catch — so the answer to "will this do what I think"
// arrives before the edit, not after.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useMidiEditorStore } from '../../../stores/midiEditorStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { clipNotes, writeClipNotes } from '../../../daw/model/patterns.js';

import { secToBeat, tempoMapOf } from '../../../daw/model/tempo-map.js';
import {
  COMPARISON_LABELS, EMPTY_RULE, MODE_LABELS, OPERATION_LABELS, PROPERTY_LABELS,
  RANGE_COMPARISONS, RULE_PRESETS, describeResult, describeRule, ruleProblem,
  runRule, selectNotes,
  type Action, type Comparison, type Condition, type Operation, type Property,
  type Rule, type RuleMode,
} from '../../../daw/edit/logical-editor.js';
import { premium } from '../../../theme/premium.js';

const PROPERTIES = Object.keys(PROPERTY_LABELS) as Property[];
const COMPARISONS = Object.keys(COMPARISON_LABELS) as Comparison[];
const OPERATIONS = Object.keys(OPERATION_LABELS) as Operation[];
const MODES = Object.keys(MODE_LABELS) as RuleMode[];

export default function LogicalEditor({ onClose }: { onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const open = useMidiEditorStore((s) => s.open);
  const selectedIds = useMidiEditorStore((s) => s.selectedNoteIds);
  const setSelection = useMidiEditorStore((s) => s.setSelection);

  const [rule, setRule] = useState<Rule>(RULE_PRESETS[0] ?? EMPTY_RULE);
  /** Run over the selection when there is one — the usual "these notes" case. */
  const [selectionOnly, setSelectionOnly] = useState(false);

  const track = open ? findTrack(session, open.trackId) : undefined;
  const part = track ? trackClips(track).find((c) => c.id === open?.clipId) : undefined;
  const notes = useMemo(() => (part ? clipNotes(session, part) : []), [session, part]);

  // Bars and beats-in-bar are read through the song's meter at the part's own
  // position, so a rule about downbeats means the same thing in 6/8.
  const context = useMemo(() => {
    const map = tempoMapOf(session);
    return {
      tempoMap: map,
      partStartBeat: part ? secToBeat(map, part.startSec) : 0,
    };
  }, [session, part]);

  const scope = useMemo(() => {
    if (!selectionOnly || selectedIds.length === 0) return notes;
    const ids = new Set(selectedIds);
    return notes.filter((n) => ids.has(n.id));
  }, [notes, selectionOnly, selectedIds]);

  const problem = ruleProblem(rule);
  const preview = useMemo(
    () => selectNotes(scope, rule, context).length, [scope, rule, context]);

  const patch = (over: Partial<Rule>): void => setRule((r) => ({ ...r, ...over }));
  const setCondition = (i: number, over: Partial<Condition>): void => patch({
    conditions: rule.conditions.map((c, j) => (j === i ? { ...c, ...over } : c)),
  });
  const setAction = (i: number, over: Partial<Action>): void => patch({
    actions: rule.actions.map((a, j) => (j === i ? { ...a, ...over } : a)),
  });

  const run = (): void => {
    if (!open || !part) return;
    if (problem) { notify(problem, 'warning'); return; }
    const result = runRule(scope, rule, context);

    if (rule.mode === 'select') {
      setSelection(result.matched.map((n) => n.id));
      notify(describeResult(rule, result), 'info');
      return;
    }
    if (result.matched.length === 0) { notify('조건에 맞는 노트가 없습니다', 'warning'); return; }

    // The rule ran over a subset, so the untouched notes have to come back
    // with it — otherwise "선택만" would delete the rest of the part.
    const touched = new Set(scope.map((n) => n.id));
    const untouched = notes.filter((n) => !touched.has(n.id));
    const next = [...untouched, ...result.notes];

    apply((s) => writeClipNotes(s, open.trackId, open.clipId, next));
    // Leave the notes the rule acted on selected, so the next thing you do is
    // to them and an unwanted result is one Cmd+Z and visible.
    setSelection(rule.mode === 'delete' || rule.mode === 'extract'
      ? [] : result.matched.map((n) => n.id));
    notify(describeResult(rule, result), result.clamped > 0 ? 'warning' : 'info');
  };

  return (
    <div className="absolute right-2 top-9 z-20 w-[520px] rounded border shadow-2xl"
         style={{
           background: premium.surface.panel, borderColor: premium.surface.hairline,
           fontFamily: premium.type.sans,
         }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b"
           style={{ borderColor: premium.surface.hairline }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>로지컬 에디터</span>
        <select
          value=""
          onChange={(e) => {
            const found = RULE_PRESETS.find((p) => p.name === e.target.value);
            if (found) setRule(found);
          }}
          className="h-5 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300 max-w-[200px]"
        >
          <option value="">프리셋 불러오기…</option>
          {RULE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={onClose}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기
        </button>
      </div>

      {/* The rule in words.  A rule made of dropdowns is easy to build and
          hard to read; this line is how you check it before you run it. */}
      <div className="px-2 py-1 text-[10px] leading-relaxed border-b"
           style={{ color: premium.text.secondary, borderColor: premium.surface.hairline }}>
        {describeRule(rule)}
      </div>

      <div className="p-2 space-y-2">
        <div className="flex items-center gap-1">
          <span style={labelStyle}>동작</span>
          <select value={rule.mode} onChange={(e) => patch({ mode: e.target.value as RuleMode })}
                  style={{ ...ctlStyle, width: 108 }}>
            {MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[9px] ml-2"
                 style={{ color: premium.text.faint }}
                 title="선택한 노트에만 적용합니다 — 선택이 없으면 파트 전체">
            <input type="checkbox" checked={selectionOnly}
                   onChange={(e) => setSelectionOnly(e.target.checked)} />
            선택한 노트만 ({selectedIds.length})
          </label>
        </div>

        {/* ── Conditions ─────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <span style={labelStyle}>조건</span>
            <span className="text-[9px]" style={{ color: premium.text.faint }}>
              {rule.conditions.length === 0 ? '없음 = 파트 전체' : '그리고가 또는보다 먼저 묶입니다'}
            </span>
            <div className="flex-1" />
            <button style={miniStyle} onClick={() => patch({
              conditions: [...rule.conditions, {
                property: 'velocity', comparison: 'less', value: 64,
                ...(rule.conditions.length > 0 ? { join: 'and' as const } : {}),
              }],
            })}>+ 조건</button>
          </div>
          {rule.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-1 mb-1">
              {i > 0 ? (
                <select value={c.join ?? 'and'}
                        onChange={(e) => setCondition(i, { join: e.target.value as 'and' | 'or' })}
                        style={{ ...ctlStyle, width: 52 }}>
                  <option value="and">그리고</option>
                  <option value="or">또는</option>
                </select>
              ) : <span style={{ width: 52 }} />}
              <select value={c.property}
                      onChange={(e) => setCondition(i, { property: e.target.value as Property })}
                      style={{ ...ctlStyle, width: 96 }}>
                {PROPERTIES.map((p) => <option key={p} value={p}>{PROPERTY_LABELS[p]}</option>)}
              </select>
              <select value={c.comparison}
                      onChange={(e) => setCondition(i, { comparison: e.target.value as Comparison })}
                      style={{ ...ctlStyle, width: 72 }}>
                {COMPARISONS.map((k) => <option key={k} value={k}>{COMPARISON_LABELS[k]}</option>)}
              </select>
              <input type="number" value={c.value} style={numStyle}
                     onChange={(e) => setCondition(i, { value: Number(e.target.value) })} />
              {RANGE_COMPARISONS.has(c.comparison) && (
                <input type="number" value={c.value2 ?? c.value} style={numStyle}
                       onChange={(e) => setCondition(i, { value2: Number(e.target.value) })} />
              )}
              <button style={miniStyle} title="이 조건 지우기"
                      onClick={() => patch({
                        conditions: rule.conditions.filter((_, j) => j !== i),
                      })}>×</button>
            </div>
          ))}
        </div>

        {/* ── Actions ────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <span style={labelStyle}>동작</span>
            <div className="flex-1" />
            <button style={miniStyle} onClick={() => patch({
              actions: [...rule.actions, { property: 'velocity', operation: 'add', value: 10 }],
            })}>+ 동작</button>
          </div>
          {rule.actions.map((a, i) => (
            <div key={i} className="flex items-center gap-1 mb-1">
              <span style={{ width: 52 }} />
              <select value={a.property}
                      onChange={(e) => setAction(i, { property: e.target.value as Property })}
                      style={{ ...ctlStyle, width: 96 }}>
                {PROPERTIES.map((p) => <option key={p} value={p}>{PROPERTY_LABELS[p]}</option>)}
              </select>
              <select value={a.operation}
                      onChange={(e) => setAction(i, { operation: e.target.value as Operation })}
                      style={{ ...ctlStyle, width: 118 }}>
                {OPERATIONS.map((o) => <option key={o} value={o}>{OPERATION_LABELS[o]}</option>)}
              </select>
              <input type="number" step="any" value={a.value} style={numStyle}
                     onChange={(e) => setAction(i, { value: Number(e.target.value) })} />
              <button style={miniStyle} title="이 동작 지우기"
                      onClick={() => patch({ actions: rule.actions.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1 border-t"
             style={{ borderColor: premium.surface.hairline }}>
          {/* The answer to "will this do what I think" belongs BEFORE the edit. */}
          <span className="text-[10px]"
                style={{ color: preview > 0 ? premium.accent.good : premium.text.faint }}>
            미리보기: {scope.length}개 중 {preview}개
          </span>
          <div className="flex-1" />
          {problem && (
            <span className="text-[9px] truncate max-w-[240px]"
                  style={{ color: premium.accent.danger }} title={problem}>{problem}</span>
          )}
          <button
            onClick={run}
            disabled={problem !== null || preview === 0}
            style={{
              height: 22, padding: '0 12px', borderRadius: 3, fontSize: 10,
              background: problem || preview === 0 ? premium.surface.well : premium.accent.base,
              color: problem || preview === 0 ? premium.text.faint : premium.text.onAccent,
              border: `1px solid ${problem || preview === 0
                ? premium.surface.hairline : premium.accent.deep}`,
              cursor: problem || preview === 0 ? 'default' : 'pointer',
            }}
          >실행</button>
        </div>
      </div>
    </div>
  );
}

const ctlStyle: React.CSSProperties = {
  height: 20, borderRadius: 3, fontSize: 10,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`, padding: '0 2px',
};

const numStyle: React.CSSProperties = {
  ...ctlStyle, width: 62, textAlign: 'center',
  fontFamily: premium.type.mono, color: premium.text.primary,
};

const miniStyle: React.CSSProperties = {
  height: 18, minWidth: 18, padding: '0 5px', borderRadius: 3, fontSize: 9,
  background: premium.surface.well, color: premium.text.faint,
  border: `1px solid ${premium.surface.hairline}`,
};

const labelStyle: React.CSSProperties = {
  fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint, width: 30,
};
