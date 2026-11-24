// DawShortcutHelp — the "?" overlay, rendered straight from definitions.ts,
// and since the overrides layer landed, the place you change a binding too.
//
// Generated rather than hand-written so it can never drift from what the
// dispatcher actually does — including the rows marked "해당 없음", which are
// listed on purpose so the DAW muscle memory has an answer instead of silence.
//
// The editor lives HERE rather than in settings for one reason: this is the
// list.  Cubase gives key commands their own window and then has to repeat
// the whole table inside it; the table was already on screen, so what was
// missing was the ability to press one of its rows.

import React, { useEffect, useMemo, useState } from 'react';
import { LAYER } from '../../theme/layers.js';
import {
  SHORTCUTS, GROUP_TITLES, type CommandId, type ShortcutDef, type ShortcutGroupId,
} from '../../shortcuts/definitions.js';
import {
  describeSpec, effectiveChords, isOverridden, specFromEvent,
} from '../../shortcuts/key-overrides.js';
import { searchCommands } from '../../shortcuts/command-search.js';
import { runCommand } from '../../shortcuts/command-runner.js';
import { resetHints } from '../../shortcuts/chord-hints.js';
import { demoModeOn, setDemoMode } from '../../shortcuts/demo-mode.js';
import { KEYMAP_PRESETS, activePresetId } from '../../shortcuts/keymap-presets.js';
import { LESSONS, findLesson, stageOf } from '../../shortcuts/lesson-plan.js';
import { detectPlatform } from '../../shortcuts/keys.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { useShortcutStore } from '../../stores/shortcutStore.js';
import { useAppStore } from '../../stores/appStore.js';

const GROUP_ORDER: ShortcutGroupId[] = ['file', 'transport', 'tools', 'edit', 'window', 'daw'];

function Chip({ label, changed }: { label: string; changed?: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded
                     border font-mono text-[10px] whitespace-nowrap ${changed
                       ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
                       : 'border-zinc-700 bg-zinc-800/70 text-zinc-300'}`}>
      {label}
    </span>
  );
}

export default function DawShortcutHelp() {
  const setPanel = useWorkspaceStore((s) => s.setPanel);
  const notify = useAppStore((s) => s.notify);
  const overrides = useShortcutStore((s) => s.overrides);
  const setChords = useShortcutStore((s) => s.setChords);
  const reset = useShortcutStore((s) => s.reset);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const usePreset = useShortcutStore((s) => s.usePreset);
  const active = useMemo(() => activePresetId(overrides), [overrides]);
  const platform = useMemo(() => detectPlatform(), []);
  const [filter, setFilter] = useState('');
  /**
   * Which lesson stage the overlay is showing, or null for the whole table.
   *
   * Not stored: a stage is where somebody is in a course, and remembering it
   * across launches would quietly hide 229 commands from a person who has
   * moved on and does not remember choosing a stage.
   */
  // From the store, so the cheat sheet prints the page that is on screen.
  const stage = useShortcutStore((s) => s.stage);
  const setStage = useShortcutStore((s) => s.setStage);
  // Read once on mount: the flag lives in localStorage so it survives a class
  // that spans days, and nothing else in the app changes it while this panel
  // is open — except the command, which this button and the palette share.
  const [demoOn, setDemoOn] = useState(() => demoModeOn());
  /** The command waiting for a keypress, or null. */
  const [capturing, setCapturing] = useState<CommandId | null>(null);
  const close = () => setPanel('help', false);

  /**
   * Capture the next keypress for `capturing`.
   *
   * On the window in CAPTURE phase, so it runs before the global dispatcher —
   * which is itself a window capture listener and would otherwise run the
   * command being rebound.  Pressing ⌘S to assign it would save the session.
   */
  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setCapturing(null); return; }
      const spec = specFromEvent(e, platform);
      // A bare modifier is not a binding — keep waiting rather than refusing,
      // because holding ⌘ before pressing the key is how a chord is typed.
      if (!spec) return;
      const result = setChords(capturing, [spec]);
      setCapturing(null);
      if (!result.ok) notify(result.reason ?? '단축키를 바꾸지 못했습니다', 'warning');
      else notify(`${describeSpec(spec, platform)} 로 바꿨습니다`, 'success');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, platform, setChords, notify]);

  // The same search the command palette runs — one function, two surfaces.
  // A second copy here is how the two would start disagreeing about whether a
  // remapped key is findable.
  const changedCount = Object.keys(overrides).length;
  const shown = searchCommands(filter, overrides, platform);

  const lesson = stage === null ? undefined : findLesson(stage);
  // A stage keeps its TEACHING order, so it is mapped from the lesson rather
  // than filtered out of the table — and the search still applies, because
  // "what was the key for save" is a question inside a stage too.
  const stageRows = (lesson?.commands ?? [])
    .map((id) => SHORTCUTS.find((x) => x.id === id))
    .filter((x): x is ShortcutDef => x !== undefined)
    .filter((x) => shown.includes(x));

  // ONE row renderer.  The table groups by the Cubase sections and a stage
  // lists in teaching order; two copies of this would drift the first time
  // either grew a column, which is the shape of every defect this file's
  // neighbourhood has had.
  const renderRow = (s: ShortcutDef): React.ReactElement => {
    // Which lesson teaches this one — shown only in the whole table, where it
    // turns 242 rows into a map of the course.  Inside a stage every row would
    // carry the same badge, which is noise, so there it is left off.
    const taught = stage === null ? stageOf(s.id) : null;
                    const chords = effectiveChords(s, overrides);
                    const changed = isOverridden(s.id, overrides);
                    return (
                      <div key={s.id} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={`text-[12px] flex items-baseline gap-1.5 ${s.available
                            ? 'text-zinc-300' : 'text-zinc-600 line-through'}`}>
                            <span className="min-w-0">{s.label}</span>
                            {taught !== null && (
                              <span className="shrink-0 text-[9px] px-1 py-px rounded
                                               border border-zinc-700 text-zinc-500">
                                {taught}단계
                              </span>
                            )}
                          </p>
                          <p className="text-[10px] text-zinc-600 leading-snug">
                            {s.available ? s.note : `해당 없음 — ${s.note}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 pt-0.5">
                          {capturing === s.id ? (
                            <span className="px-1.5 py-0.5 rounded border border-emerald-500/60
                                             bg-emerald-600/20 font-mono text-[10px] text-emerald-300
                                             whitespace-nowrap animate-pulse">
                              키를 누르세요 · ESC 취소
                            </span>
                          ) : (
                            <>
                              {chords.length === 0 ? (
                                <span className="text-[10px] text-zinc-600 font-mono">없음</span>
                              ) : chords.map((c, i) => (
                                <React.Fragment key={c}>
                                  {i > 0 && <span className="text-[9px] text-zinc-700">/</span>}
                                  <Chip label={describeSpec(c, platform)} changed={changed} />
                                </React.Fragment>
                              ))}
                              <button
                                onClick={() => setCapturing(s.id)}
                                title="이 기능의 단축키를 다른 키로 바꿉니다"
                                className="hit-target w-5 h-5 rounded text-[10px] leading-none
                                           text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
                              >✎</button>
                              {changed && (
                                <button
                                  onClick={() => {
                                    const r = reset(s.id);
                                    notify(r.ok ? `"${s.label}" 를 기본값으로 되돌렸습니다`
                                      : (r.reason ?? '되돌리지 못했습니다'), r.ok ? 'success' : 'warning');
                                  }}
                                  title="기본값으로"
                                  className="hit-target w-5 h-5 rounded text-[10px] leading-none
                                             text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
                                >↺</button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
  };

  return (
    <div
      onClick={close}
      className="fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      style={{ zIndex: LAYER.help }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,760px)] max-h-[86vh] overflow-y-auto rounded-2xl border border-zinc-700
                   bg-[#15151d] shadow-2xl px-6 py-5"
      >
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <p className="text-base font-semibold text-zinc-100">키보드 단축키</p>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              {platform === 'mac' ? 'macOS — ⌘ / Option' : 'Windows — Ctrl / Alt'} 기준 · 입력창에 포커스가 있을 때는 동작하지 않습니다
            </p>
          </div>
          <button onClick={close} title="닫기"
                  className="hit-target text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>

        {/* Search, because the table is three hundred rows and the question is
            always about one of them. */}
        <div className="flex items-center gap-2 mb-4">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="기능 · 설명 · 키 검색"
            className="flex-1 min-w-0 h-7 rounded-lg bg-zinc-900 border border-zinc-700 px-2
                       text-[11px] text-zinc-300 placeholder:text-zinc-600
                       focus:outline-none focus:border-zinc-500"
          />
          <span className="text-[10px] text-zinc-600 shrink-0">
            {shown.length} / {SHORTCUTS.length}
          </span>
          {/* The chip that says "다음엔 이 키로" after a click stops after three
              showings per command, on purpose — a hint that keeps arriving
              gets dismissed without being read.  But a shared classroom
              machine has already used up somebody else's three, and a student
              who wants them back has nowhere to ask.  Here. */}
          {/* Paper.  Runs the command rather than building the page here, so
              the sheet and the key print the same thing — and the command
              reads the stage out of the store, which is why that selection
              moved there. */}
          <button
            onClick={() => { void runCommand('daw.cheatSheet'); }}
            title="지금 보고 있는 목록을 인쇄용 HTML 한 장으로 내보냅니다 — 바꾼 키가 그대로 들어갑니다"
            className="shrink-0 h-7 px-2 rounded-lg border border-zinc-700 text-[10px]
                       text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
          >치트시트</button>
          {/* The projector switch, beside the other teaching control.  It is a
              command too, so the palette can find it by name — but an
              instructor setting up a classroom machine is looking at this
              panel, not typing. */}
          <button
            onClick={() => {
              const on = setDemoMode(!demoOn);
              setDemoOn(on);
              notify(on
                ? '시연 모드 켜짐 — 누르는 키가 화면 위에 표시됩니다'
                : '시연 모드 꺼짐', 'success');
            }}
            title="누른 단축키와 그 명령 이름을 화면 위에 크게 띄웁니다 — 수업·녹화용"
            className={`shrink-0 h-7 px-2 rounded-lg border text-[10px] transition-colors ${demoOn
              ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
          >시연 모드{demoOn ? ' ✓' : ''}</button>
          <button
            onClick={() => {
              resetHints();
              notify('키 힌트를 다시 보여줍니다 — 버튼을 누를 때 그 명령의 키가 세 번까지 떠요', 'success');
            }}
            title="버튼이나 메뉴로 명령을 실행했을 때 그 명령의 단축키를 다시 알려줍니다"
            className="shrink-0 h-7 px-2 rounded-lg border border-zinc-700 text-[10px]
                       text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
          >키 힌트 다시 보기</button>
          {changedCount > 0 && (
            <button
              onClick={() => {
                const r = resetAll();
                notify(r.ok ? `바꾼 단축키 ${changedCount}개를 기본값으로 되돌렸습니다`
                  : (r.reason ?? '되돌리지 못했습니다'), r.ok ? 'success' : 'warning');
              }}
              className="shrink-0 h-7 px-2 rounded-lg border border-zinc-700 text-[10px]
                         text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
            >전체 기본값 ({changedCount})</button>
          )}
        </div>

        {/* ── The keyboard you already have in your fingers ──────────────
            The default map is Cubase-shaped, and somebody who learned Logic
            or Live types the wrong key for a week.  Switching takes keys off
            other commands, so the toast NAMES them rather than letting a
            command go quiet — and the palette (⌘P) still runs anything by
            name, which is why that is a trade and not a loss. */}
        <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 mr-1">키맵</span>
            {KEYMAP_PRESETS.map((preset) => {
              const on = active === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => {
                    const r = usePreset(preset.id);
                    if (!r.ok) { notify(r.reason ?? '키맵을 바꾸지 못했습니다', 'warning'); return; }
                    const lost = r.plan?.unbound ?? [];
                    const names = lost
                      .map((id) => SHORTCUTS.find((x) => x.id === id)?.label ?? id)
                      .join(' · ');
                    notify(lost.length === 0
                      ? `${preset.label} 으로 바꿨습니다`
                      : `${preset.label} 으로 바꿨습니다 — ${names} 는 키가 없어졌습니다 (팔레트로 실행)`,
                    'success');
                  }}
                  title={preset.note}
                  className={`h-7 px-2.5 rounded-lg border text-[10px] transition-colors ${on
                    ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
                    : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
                >{preset.label}{on ? ' ✓' : ''}</button>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-600 mt-1.5">
            {active === null
              ? '직접 바꾼 키맵입니다 — 아래 표에서 행을 누르면 그 키를 다시 정할 수 있습니다'
              : (KEYMAP_PRESETS.find((p) => p.id === active)?.note ?? '')}
          </p>
        </div>

        {/* ── 단계 ───────────────────────────────────────────────────────
            241 rows is a reference manual, not a keyboard.  A stage is a
            dozen, in the order they are taught, and stage 1 is the whole loop
            of a first lesson: get a sound in, cut it, undo, save, send it to
            mastering — and the palette, for the other 229. */}
        <div className="flex items-center gap-1.5 flex-wrap mb-4">
          <span className="text-[10px] text-zinc-500 mr-1">단계</span>
          <button
            onClick={() => setStage(null)}
            className={`h-7 px-2.5 rounded-lg border text-[10px] transition-colors ${stage === null
              ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
          >전체 ({SHORTCUTS.length})</button>
          {LESSONS.map((l) => (
            <button
              key={l.stage}
              onClick={() => setStage(l.stage)}
              title={l.note}
              className={`h-7 px-2.5 rounded-lg border text-[10px] transition-colors ${stage === l.stage
                ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
            >{l.title} ({l.commands.length})</button>
          ))}
        </div>

        {lesson !== undefined ? (
          <section className="space-y-2">
            <p className="text-[10px] text-zinc-500">{lesson.note}</p>
            <div className="space-y-1.5">{stageRows.map(renderRow)}</div>
            {stageRows.length === 0 && (
              <p className="text-[11px] text-zinc-600 text-center py-6">
                이 단계에는 "{filter}" 에 해당하는 기능이 없습니다
              </p>
            )}
          </section>
        ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {GROUP_ORDER.map((g) => {
            const rows = shown.filter((s) => s.group === g);
            if (rows.length === 0) return null;
            return (
              <section key={g} className="space-y-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">
                  {GROUP_TITLES[g]}
                </p>
                <div className="space-y-1.5">
                  {rows.map(renderRow)}
                </div>
              </section>
            );
          })}
        </div>
        )}

        {stage === null && shown.length === 0 && (
          <p className="text-[11px] text-zinc-600 text-center py-6">
            "{filter}" 에 해당하는 기능이 없습니다
          </p>
        )}

        <p className="mt-5 pt-3 border-t border-zinc-800 text-[10px] font-mono text-zinc-600 text-center">
          ✎ 로 키 변경 · ESC · ? · F1 로 닫기
        </p>
      </div>
    </div>
  );
}
