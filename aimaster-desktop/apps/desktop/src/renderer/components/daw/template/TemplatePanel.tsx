// TemplatePanel — save a setup, start from it next time.
//
// Two lists side by side because they answer two different questions.  A
// TRACK template answers "give me another one of these" in the middle of a
// session; a SESSION template answers "start the way I always start".
//
// Everything that could quietly lose something says so out loud: what a save
// left behind, what an apply could not find, which device this build does not
// have.  The panel never reports a success it did not get — a store that
// refused the write comes back as a refusal, not a checkmark.

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import {
  applyTrackTemplate, captureSessionTemplate, captureTrackTemplate,
  describeSessionTemplate, describeTrackTemplate, missingDevices, sessionFromTemplate,
} from '../../../daw/model/track-template.js';
import type { SessionTemplate, TrackTemplate } from '../../../daw/model/track-template.js';
import {
  deleteSessionTemplate, deleteTrackTemplate, exportTemplates, importTemplates,
  listSessionTemplates, listTrackTemplates, saveSessionTemplate, saveTrackTemplate,
} from '../../../daw/engine/template-store.js';

export default function TemplatePanel({ onClose }: { onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const loadSession = useDawStore((s) => s.loadSession);
  const apply = useDawStore((s) => s.apply);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const notify = useAppStore((s) => s.notify);

  // Bumped after every write so the lists re-read the store.
  const [revision, setRevision] = useState(0);
  const tracks = useMemo(() => listTrackTemplates(), [revision]);
  const sessions = useMemo(() => listSessionTemplates(), [revision]);
  const [trackName, setTrackName] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [count, setCount] = useState(1);

  const say = useCallback((problems: readonly string[]): void => {
    for (const p of problems.slice(0, 4)) notify(p, 'warning');
    if (problems.length > 4) notify(`… 그리고 ${problems.length - 4}가지 더`, 'warning');
  }, [notify]);

  const target = focusedTrackId
    ?? session.tracks.find((t) => t.kind !== 'master' && t.kind !== 'vca')?.id
    ?? null;

  const saveTrack = (): void => {
    if (!target) { notify('저장할 트랙이 없습니다', 'warning'); return; }
    const name = trackName.trim();
    if (!name) { notify('템플릿 이름을 입력하세요', 'warning'); return; }
    const captured = captureTrackTemplate(session, target, name);
    if (!captured) { notify('트랙을 찾을 수 없습니다', 'warning'); return; }
    const result = saveTrackTemplate(captured.template);
    if (!result.saved) { notify(result.problem ?? '저장하지 못했습니다', 'error'); return; }
    say(captured.problems);
    setTrackName('');
    setRevision((r) => r + 1);
    notify(`트랙 템플릿 「${name}」 저장`, 'success');
  };

  const useTrack = (template: TrackTemplate): void => {
    const missing = missingDevices(template);
    let problems: string[] = [];
    let made = 0;
    apply((s) => {
      const result = applyTrackTemplate(s, template, { count });
      problems = result.problems;
      made = result.trackIds.length;
      if (result.createdBuses.length > 0) {
        problems = [...problems, `버스 ${result.createdBuses.join(', ')} 을(를) 새로 만들었습니다`];
      }
      return result.session;
    });
    say(problems);
    notify(`${template.trackName} ${made}개 추가${missing.length > 0 ? ` (${missing.length}개 장치 없음)` : ''}`,
      missing.length > 0 ? 'warning' : 'success');
  };

  const saveSession = (): void => {
    const name = sessionName.trim();
    if (!name) { notify('템플릿 이름을 입력하세요', 'warning'); return; }
    const captured = captureSessionTemplate(session, name);
    const result = saveSessionTemplate(captured.template);
    if (!result.saved) { notify(result.problem ?? '저장하지 못했습니다', 'error'); return; }
    say(captured.problems);
    setSessionName('');
    setRevision((r) => r + 1);
    notify(`세션 템플릿 「${name}」 저장`, 'success');
  };

  const useSession = (template: SessionTemplate): void => {
    // A new session replaces what is open, so this asks first — the one
    // action here that cannot be undone by pressing the button again.
    const ok = globalThis.confirm(
      `「${template.name}」 로 새 세션을 시작합니다.\n지금 열린 세션은 닫힙니다 — 저장했나요?`);
    if (!ok) return;
    const made = sessionFromTemplate(template, template.name, session.sampleRate);
    loadSession(made.session);
    say(made.problems);
    notify(`「${template.name}」 로 새 세션 — ${describeSessionTemplate(template)}`, 'success');
  };

  const doExport = (): void => {
    const text = exportTemplates();
    void navigator.clipboard?.writeText(text)
      .then(() => notify(`템플릿 ${tracks.length + sessions.length}개를 클립보드에 복사했습니다`, 'success'))
      .catch(() => notify('클립보드에 쓸 수 없습니다', 'error'));
  };

  const doImport = (): void => {
    const raw = globalThis.prompt('템플릿 파일 내용을 붙여넣으세요');
    if (!raw) return;
    const result = importTemplates(raw);
    say(result.problems);
    setRevision((r) => r + 1);
    if (result.tracks + result.sessions > 0) {
      notify(`트랙 ${result.tracks}개 · 세션 ${result.sessions}개 가져왔습니다`, 'success');
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center pt-16"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[760px] max-w-[94vw] max-h-[76vh] overflow-hidden flex flex-col rounded"
        style={{
          background: premium.surface.panel,
          border: `1px solid ${premium.surface.hairlineStrong}`,
          boxShadow: premium.shadow.panel,
        }}
      >
        <div className="flex items-center gap-3 px-4 py-2"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
          <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
            템플릿
          </span>
          <span style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
            설정만 저장합니다 — 클립 · 오토메이션 · 프리즈는 세션의 것입니다
          </span>
          <div className="flex-1" />
          <Small onClick={doExport}>내보내기</Small>
          <Small onClick={doImport}>가져오기</Small>
          <Small onClick={onClose}>닫기</Small>
        </div>

        <div className="flex-1 grid grid-cols-2 gap-px overflow-hidden"
             style={{ background: premium.surface.hairline }}>
          {/* ── Track templates ─────────────────────────────────────────── */}
          <Column title="트랙 템플릿">
            <div className="flex items-center gap-1 mb-2">
              <input
                value={trackName}
                onChange={(e) => setTrackName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveTrack(); }}
                placeholder={target ? '이 트랙을 이 이름으로 저장' : '저장할 트랙이 없습니다'}
                className="flex-1 min-w-0 h-6 px-1.5 rounded text-[10px] bg-zinc-900
                           border border-zinc-700 text-zinc-300"
              />
              <Small onClick={saveTrack}>저장</Small>
            </div>
            <label className="flex items-center gap-1 mb-2"
                   style={{ fontSize: 9, color: premium.text.muted }}>
              한 번에
              <input
                type="number" min={1} max={64} value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1))))}
                className="w-12 h-5 rounded text-[10px] font-mono text-center bg-zinc-900
                           border border-zinc-700 text-zinc-300"
              />
              개
            </label>
            {tracks.length === 0 && <Empty>저장된 트랙 템플릿이 없습니다</Empty>}
            {tracks.map((t) => (
              <Row
                key={t.id}
                title={t.name}
                detail={describeTrackTemplate(t)}
                warn={missingDevices(t)}
                onUse={() => useTrack(t)}
                onDelete={() => {
                  if (!deleteTrackTemplate(t.id)) { notify('지우지 못했습니다', 'error'); return; }
                  setRevision((r) => r + 1);
                  notify(`「${t.name}」 삭제`, 'info');
                }}
                useLabel="추가"
              />
            ))}
          </Column>

          {/* ── Session templates ───────────────────────────────────────── */}
          <Column title="세션 템플릿">
            <div className="flex items-center gap-1 mb-2">
              <input
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveSession(); }}
                placeholder="지금 세션을 이 이름으로 저장"
                className="flex-1 min-w-0 h-6 px-1.5 rounded text-[10px] bg-zinc-900
                           border border-zinc-700 text-zinc-300"
              />
              <Small onClick={saveSession}>저장</Small>
            </div>
            <p className="mb-2" style={{ fontSize: 9, color: premium.text.faint }}>
              트랙 · 버스 · 그룹 · 마커 · 템포를 담습니다. 마스터는 담지 않습니다 —
              모든 세션에 이미 하나씩 있습니다.
            </p>
            {sessions.length === 0 && <Empty>저장된 세션 템플릿이 없습니다</Empty>}
            {sessions.map((t) => (
              <Row
                key={t.id}
                title={t.name}
                detail={describeSessionTemplate(t)}
                warn={[...new Set(t.tracks.flatMap(missingDevices))]}
                onUse={() => useSession(t)}
                onDelete={() => {
                  if (!deleteSessionTemplate(t.id)) { notify('지우지 못했습니다', 'error'); return; }
                  setRevision((r) => r + 1);
                  notify(`「${t.name}」 삭제`, 'info');
                }}
                useLabel="새 세션"
              />
            ))}
          </Column>
        </div>
      </div>
    </div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-y-auto px-3 py-2" style={{ background: premium.surface.panel }}>
      <p className="mb-2" style={{
        fontSize: 9, letterSpacing: '0.14em', color: premium.text.muted, textTransform: 'uppercase',
      }}>{title}</p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 10, color: premium.text.faint }}>{children}</p>;
}

function Row({
  title, detail, warn, onUse, onDelete, useLabel,
}: {
  title: string; detail: string; warn: readonly string[];
  onUse: () => void; onDelete: () => void; useLabel: string;
}) {
  return (
    <div className="mb-1.5 rounded px-2 py-1.5"
         style={{ background: premium.surface.well, border: `1px solid ${premium.surface.hairline}` }}>
      <div className="flex items-center gap-1.5">
        <span className="flex-1 min-w-0 truncate"
              style={{ fontSize: 11, color: premium.text.primary }}>{title}</span>
        <Small onClick={onUse}>{useLabel}</Small>
        <Small onClick={onDelete}>삭제</Small>
      </div>
      <p className="truncate" style={{
        fontSize: 9, fontFamily: premium.type.mono, color: premium.text.muted,
      }} title={detail}>{detail}</p>
      {/* Named, not counted: "3 devices missing" tells you nothing about
          whether the chain is still worth using. */}
      {warn.length > 0 && (
        <p style={{ fontSize: 9, color: premium.accent.danger }}>
          이 빌드에 없는 장치: {warn.join(', ')}
        </p>
      )}
    </div>
  );
}

function Small({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-5 px-1.5 rounded shrink-0"
      style={{
        fontSize: 9, color: premium.text.secondary,
        background: premium.surface.overlay,
        border: `1px solid ${premium.surface.hairline}`,
      }}
    >{children}</button>
  );
}
