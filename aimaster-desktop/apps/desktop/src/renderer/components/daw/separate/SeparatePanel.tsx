// STEMS — one recording, four tracks.
//
// The panel is built around what the separator can and cannot promise, because
// the failure this feature invites is a user believing the vocal stem is a
// clean vocal.  So:
//
//   IT SHOWS THE MEASUREMENT, NOT A CLAIM.  Every run reports how confident it
//   was per stem — the share of that stem's energy that came from a bin it was
//   sure about rather than one it split down the middle — and the bar is drawn
//   from that number.  A 40 % vocal is drawn as a 40 % vocal.
//
//   IT SAYS WHAT IT COULD NOT USE.  A mono file has no panning cue; music that
//   does not repeat has no repetition cue.  Both halve the vocal separation and
//   both are stated before the run and again in the result.
//
//   IT NEVER CLAIMS TO BE A MODEL.  The last note in every report says this is
//   signal processing.  That sentence is not modesty, it is the difference
//   between a user who reaches for it when it suits and one who concludes the
//   app is broken.

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { getCached } from '../../../daw/engine/audio-cache.js';
import {
  DETAILED_STEMS, STEM_KINDS, stemColor, stemLabel, stemNode,
  type SeparationReport, type StemKind,
} from '../../../daw/audio/separate/separate.js';
import { STEM_TREE, coverProblems, toggleStem } from '../../../daw/audio/separate/stem-tree.js';
import { canSeparate, separateClip } from '../../../daw/edit/separate-actions.js';
import { premium } from '../../../theme/premium.js';
import type { Clip, Track } from '../../../daw/model/types.js';

export default function SeparatePanel() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const playheadSec = useDawStore((s) => s.playheadSec);

  const [wanted, setWanted] = useState<StemKind[]>([...STEM_KINDS]);
  const detailed = wanted.some((k) => stemNode(k).parent !== null);
  const [busy, setBusy] = useState<{ fraction: number; what: string } | null>(null);
  const [report, setReport] = useState<SeparationReport | null>(null);
  const [muteSource, setMuteSource] = useState(true);

  const target = useMemo((): { track: Track; clip: Clip } | null => {
    const ordered = focusedTrackId
      ? ([findTrack(session, focusedTrackId), ...session.tracks].filter(Boolean) as Track[])
      : session.tracks;
    for (const track of ordered) {
      const audio = trackClips(track).filter((c) => c.kind === 'audio');
      const under = audio.find((c) => playheadSec >= c.startSec && playheadSec < c.startSec + c.durationSec);
      const clip = under ?? audio[0];
      if (clip) return { track, clip };
    }
    return null;
  }, [session, focusedTrackId, playheadSec]);

  const guard = canSeparate(session, target?.track.id ?? null, target?.clip.id ?? null);
  const source = target ? session.files.find((f) => f.id === target.clip.fileId) : undefined;
  // The file reference carries the channel count, rate and length from the
  // import, so none of this waits for a decode.  A panel that says "—" until
  // you press play is a panel that looks broken.
  const cached = target ? getCached(target.clip.fileId) : undefined;
  const channels = source?.channels ?? cached?.buffer.numberOfChannels ?? 0;
  const rate = source?.sampleRate ?? cached?.buffer.sampleRate ?? 0;

  // What is knowable BEFORE the run, so nobody starts a two-minute job to be
  // told afterwards that their file was mono.
  const upfront: string[] = [];
  if (channels === 1) {
    upfront.push('모노 파일입니다 — 가운데 성분 단서를 쓸 수 없어 보컬 분리가 약해집니다');
  }
  const seconds = source?.durationSec ?? cached?.buffer.duration ?? 0;
  const estimate = seconds > 0 ? Math.round((seconds / 4.5) * (wanted.length / 4 * 0.6 + 0.4)) : 0;

  const run = useCallback(async () => {
    if (!target || !guard.ok || busy) return;
    setReport(null);
    setBusy({ fraction: 0, what: '시작' });
    try {
      const result = await separateClip(session, target.track.id, target.clip.id, {
        wanted,
        muteSource,
        onProgress: (fraction, what) => setBusy({ fraction, what }),
      });
      apply(() => result.session);
      setReport(result.report);
      notify(result.message, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'warning');
    } finally {
      setBusy(null);
    }
  }, [target, guard.ok, busy, session, wanted, muteSource, apply, notify]);

  // The tree owns the rule that a set has to cover the record exactly once —
  // see stem-tree.ts.  Turning 킥 on turns its siblings on and 드럼 off, and
  // the user never has to know why.
  const toggle = (kind: StemKind): void => { setWanted((prev) => toggleStem(prev, kind)); };
  const problems = coverProblems(wanted);

  return (
    <div className="flex-1 overflow-auto" style={{ background: premium.surface.abyss }}>
      <div className="max-w-[760px] mx-auto px-6 py-5 flex flex-col gap-4">

        <header>
          <h2 style={{ fontFamily: premium.type.display, fontSize: 20, color: premium.text.primary }}>
            스템 분리
          </h2>
          <p className="mt-1" style={{ fontSize: 11, color: premium.text.muted, lineHeight: 1.7 }}>
            믹스 하나를 보컬 · 드럼 · 베이스 · 그 외로 나눕니다. 자세히 나누면 보컬은
            리드와 코러스로, 드럼은 킥과 나머지로 한 단계 더 갈라집니다. 어느 쪽이든
            스템을 다시 더하면 원본이 그대로 나오도록 만들어져 있어서, 하나를 끄면
            그 파트만 빠진 원본이 됩니다.
          </p>
        </header>

        {/* ── What will be separated ── */}
        <section style={panel}>
          <div className="flex items-baseline justify-between gap-3">
            <span style={{ fontSize: 12, color: premium.text.primary }}>
              {target ? (source?.name ?? target.clip.name) : '고른 클립 없음'}
            </span>
            <span className="font-mono" style={{ fontSize: 10, color: premium.text.faint }}>
              {channels > 0
                ? `${channels === 1 ? '모노' : channels === 2 ? '스테레오' : `${channels}채널`} · `
                  + `${rate.toLocaleString()} Hz · `
                  + `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
                : '—'}
            </span>
          </div>
          {!guard.ok && (
            <p className="mt-2" style={{ fontSize: 11, color: premium.accent.danger }}>{guard.reason}</p>
          )}
          {upfront.map((note) => (
            <p key={note} className="mt-2" style={{ fontSize: 11, color: premium.accent.base }}>⚠ {note}</p>
          ))}
        </section>

        {/* ── Which stems ── */}
        <section style={panel}>
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 11, color: premium.text.secondary }}>
              {wanted.length}개 스템
            </span>
            <button
              onClick={() => setWanted(detailed ? [...STEM_KINDS] : [...DETAILED_STEMS])}
              disabled={!!busy}
              className="h-6 px-2.5 rounded"
              style={{
                fontSize: 10,
                color: detailed ? premium.text.onAccent : premium.text.secondary,
                background: detailed ? premium.accent.base : premium.surface.well,
                border: `1px solid ${premium.surface.hairline}`,
              }}>
              자세히 나누기
            </button>
          </div>

          <div className="flex flex-col gap-1">
            {STEM_TREE.map((node) => {
              const on = wanted.includes(node.kind);
              const measured = report?.stems.find((s) => s.kind === node.kind);
              const child = node.parent !== null;
              // A child row only appears once its family is the active level;
              // showing all ten at once is a wall of switches most of which
              // cannot be pressed without changing the others.
              const parentActive = node.parent !== null && wanted.includes(node.parent);
              if (child && !on && !parentActive) return null;
              const tint = stemColor(node.kind);
              return (
                <button key={node.kind} onClick={() => toggle(node.kind)} disabled={!!busy}
                  className="flex items-center gap-3 rounded px-2.5 py-1.5 text-left"
                  style={{
                    marginLeft: child ? 18 : 0,
                    background: on ? 'rgba(255,255,255,0.04)' : 'transparent',
                    border: `1px solid ${on ? tint + '66' : premium.surface.hairline}`,
                    opacity: busy ? 0.6 : on ? 1 : 0.55,
                  }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: child ? 4 : 2, flexShrink: 0,
                    background: on ? tint : 'transparent',
                    border: `1px solid ${tint}`,
                  }} />
                  <span className="flex-1 min-w-0">
                    <span style={{ fontSize: child ? 11 : 12, color: premium.text.primary }}>
                      {node.label}
                    </span>
                    <span className="block truncate" style={{ fontSize: 10, color: premium.text.faint }}>
                      {node.what}
                    </span>
                  </span>
                  {measured && <Confidence stem={measured} tint={tint} />}
                </button>
              );
            })}
          </div>

          {problems.missing.length > 0 && (
            <p className="mt-2" style={{ fontSize: 10, color: premium.accent.base }}>
              {problems.missing.map(stemLabel).join(' · ')} 을(를) 빼면 스템의 합이 원본이 되지 않습니다
            </p>
          )}
          {/* The thing this cannot do, said where the buttons are rather than
              buried in the result — a user looking for a guitar stem should
              find out here, not after a two-minute run. */}
          <p className="mt-2" style={{ fontSize: 10, color: premium.text.faint, lineHeight: 1.6 }}>
            스네어 · 심벌을 따로 나누는 것과 기타 · 건반 · 스트링을 나누는 것은 못 합니다.
            여기 있는 모든 분리는 소리의 위치 · 지속 · 음역에 근거하는데, 스네어 줄과
            하이햇은 같은 대역의 잡음이고 거의 항상 같이 울립니다. 같은 자리에서 같은
            코드를 치는 기타와 일렉피아노는 음색만 다릅니다. 둘 다 학습된 모델이 있어야
            합니다.
          </p>

          <label className="flex items-center gap-2 mt-3" style={{ fontSize: 11, color: premium.text.muted }}>
            <input type="checkbox" checked={muteSource} disabled={!!busy}
              onChange={(e) => setMuteSource(e.target.checked)} />
            원본 트랙을 음소거합니다
            <span style={{ color: premium.text.faint }}>
              — 끄면 스템과 원본이 같이 울려서 두 배로 들립니다
            </span>
          </label>
        </section>

        {/* ── Run ── */}
        <section style={panel}>
          {busy ? (
            <div>
              <div className="flex items-baseline justify-between">
                <span style={{ fontSize: 11, color: premium.text.secondary }}>{busy.what}</span>
                <span className="font-mono" style={{ fontSize: 11, color: premium.accent.light }}>
                  {(busy.fraction * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 rounded overflow-hidden" style={{ background: premium.surface.well }}>
                <div style={{
                  width: `${Math.max(2, busy.fraction * 100)}%`, height: '100%',
                  background: premium.accent.base, transition: 'width 120ms linear',
                }} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button onClick={() => { void run(); }} disabled={!guard.ok || wanted.length === 0}
                className="h-8 px-4 rounded"
                style={{
                  fontSize: 12,
                  background: guard.ok && wanted.length > 0 ? premium.accent.base : premium.surface.well,
                  color: guard.ok && wanted.length > 0 ? premium.text.onAccent : premium.text.faint,
                  border: `1px solid ${premium.surface.hairline}`,
                }}>
                {wanted.length}개 스템으로 나누기
              </button>
              {estimate > 0 && (
                <span style={{ fontSize: 10, color: premium.text.faint }}>
                  대략 {estimate < 60 ? `${estimate}초` : `${Math.round(estimate / 60)}분`} 걸립니다
                </span>
              )}
            </div>
          )}
        </section>

        {report && <Result report={report} />}
      </div>
    </div>
  );
}

function Confidence({ stem, tint }: {
  stem: SeparationReport['stems'][number]; tint: string;
}) {
  return (
    <span className="flex items-center gap-2 shrink-0" title="이 스템 에너지 중 확실하게 판정된 비율">
      <span className="w-16 h-1 rounded overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
        <span style={{ display: 'block', width: `${stem.confidence * 100}%`, height: '100%', background: tint }} />
      </span>
      <span className="font-mono" style={{ fontSize: 10, color: premium.text.muted, width: 30, textAlign: 'right' }}>
        {(stem.confidence * 100).toFixed(0)}%
      </span>
    </span>
  );
}

function Result({ report }: { report: SeparationReport }) {
  return (
    <section style={panel}>
      <div className="flex items-baseline justify-between">
        <span style={{ fontSize: 12, color: premium.text.primary }}>결과</span>
        <span className="font-mono" style={{ fontSize: 10, color: premium.text.faint }}>
          {(report.elapsedMs / 1000).toFixed(1)}초
        </span>
      </div>
      <p className="mt-2 font-mono" style={{ fontSize: 10, color: premium.text.muted }}>
        {/* The number that makes the stems trustworthy as an edit, measured on
            the actual output rather than asserted. */}
        {report.stems.length}개 스템의 합 − 원본 = {report.reconstructionDb.toFixed(0)} dB
        {report.reconstructionDb < -100 ? ' (사실상 완전 복원)' : ''}
        {'   ·   '}반복도 {report.repetitiveness.toFixed(2)}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {report.notes.map((note) => (
          <li key={note} style={{ fontSize: 11, color: premium.text.muted, lineHeight: 1.6 }}>· {note}</li>
        ))}
      </ul>
    </section>
  );
}

const panel: React.CSSProperties = {
  background: premium.surface.panel,
  border: `1px solid ${premium.surface.hairline}`,
  borderRadius: 4,
  padding: '12px 14px',
};
