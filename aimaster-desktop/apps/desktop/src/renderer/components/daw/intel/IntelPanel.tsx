// IntelPanel — the Intelligence Layer, made answerable.
//
// Every screen here follows one shape, because the shape is the trust model:
//
//   MEASURE → PROPOSE → the user reads it → APPLY
//
// Nothing applies itself.  Every proposal states the measurement that produced
// it and the exact moves it would make, and each one has a tick box, because
// "apply all" and "apply the two I agree with" have to be equally easy.
//
// A proposal the layer is not confident about arrives unticked.  That is the
// difference between a tool that assists and one that has to be undone.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useIntelStore, type IntelTab } from '../../../stores/intelStore.js';
import { useReferenceStore } from '../../../stores/referenceStore.js';
import { describeAction, type Suggestion } from '../../../daw/ai/actions.js';
import { summarise, type Finding, type Severity } from '../../../daw/ai/diagnose.js';
import { MASTER_PROFILES } from '../../../daw/ai/master.js';
import { roleLabel } from '../../../daw/ai/roles.js';
import { vocabulary } from '../../../daw/ai/language.js';
import { trackMatchSummary } from '../../../daw/ai/track-reference.js';
import { decodeAudioFile, decodeContext } from '../../../daw/engine/audio-cache.js';
import {
  assistantStatus, clearAssistantKey, setAssistantKey, type AssistantStatus,
} from '../../../daw/ai/assistant-setup.js';
import {
  CONTOURS, RIFF_STYLES, VARIATIONS, contourLabel, styleLabel,
} from '../../../daw/ai/compose.js';
import { chordsForClip, variationLabel } from '../../../daw/ai/riff.js';
import { formatChord } from '../../../daw/model/chords.js';
import { useMidiEditorStore } from '../../../stores/midiEditorStore.js';
import { premium } from '../../../theme/premium.js';

const TABS: { id: IntelTab; label: string; note: string }[] = [
  { id: 'analyze', label: 'ANALYZE', note: '믹스를 재고 문제를 찾습니다' },
  { id: 'mix', label: 'AI MIX', note: '밸런스 · 마스킹 · 스프레드' },
  { id: 'master', label: 'AI MASTER', note: '타깃에 맞는 마스터 체인' },
  { id: 'reference', label: 'REFERENCE', note: '레퍼런스와의 차이를 실행으로' },
  { id: 'trackref', label: 'TRACK REF', note: '트랙 하나를 같은 종류의 스템과 비교' },
  { id: 'automation', label: 'AUTOMATION', note: '라이딩 · 덕킹' },
  { id: 'riff', label: 'RIFF', note: '코드와 스케일에서 프레이즈 생성' },
  { id: 'command', label: 'COMMAND', note: '말로 지시하기' },
];

export default function IntelPanel() {
  const session = useDawStore((s) => s.session);
  const notify = useAppStore((s) => s.notify);
  const state = useIntelStore();

  React.useEffect(() => {
    if (state.error) notify(state.error, 'warning');
  }, [state.error, notify]);

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: premium.surface.abyss }}>
      <div className="flex items-center gap-2 px-4 py-2 flex-wrap"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Intelligence
        </span>
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => state.setTab(tab.id)} title={tab.note}
            style={{
              height: 24, padding: '0 11px', borderRadius: 3,
              fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.08em',
              color: state.tab === tab.id ? premium.text.onAccent : premium.text.muted,
              background: state.tab === tab.id ? premium.accent.base : premium.surface.well,
              border: `1px solid ${premium.surface.hairline}`,
            }}>{tab.label}</button>
        ))}
        <div className="flex-1" />
        {state.busy && <span style={{ fontSize: 11, color: premium.accent.base }}>{state.busy}</span>}
        {!state.busy && state.analyzedAtMs && (
          <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.faint }}>
            분석 {new Date(state.analyzedAtMs).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="p-4">
        {state.tab === 'analyze' && <AnalyzeTab />}
        {state.tab === 'mix' && (
          <SuggestionTab
            title="AI Mix"
            blurb="밸런스는 LU 기준으로, 마스킹은 두 트랙이 실제로 겹치는 주파수에서, 스프레드는 역할이 겹칠 때만. 취향은 건드리지 않습니다."
            run={state.runMix} runLabel="믹스 제안 만들기"
            suggestions={state.mixSuggestions}
          />
        )}
        {state.tab === 'master' && <MasterTab />}
        {state.tab === 'reference' && (
          <SuggestionTab
            title="Reference Intelligence"
            blurb="REFERENCE 창의 비교표를 그대로 실행으로 바꿉니다. 이미 일치하는 항목은 아무것도 제안하지 않습니다."
            run={state.runMatch} runLabel="레퍼런스에 맞추기"
            suggestions={state.matchSuggestions}
          />
        )}
        {state.tab === 'trackref' && <TrackReferenceTab />}
        {state.tab === 'automation' && <AutomationTab />}
        {state.tab === 'riff' && <RiffTab />}
        {state.tab === 'command' && <CommandTab />}
      </div>

      {session.tracks.length <= 1 && (
        <p className="px-4 pb-6" style={hint}>트랙을 먼저 만들거나 오디오를 불러오세요.</p>
      )}
    </div>
  );
}

// ── Analyze ───────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: premium.accent.danger,
  warning: premium.accent.base,
  info: premium.accent.cool,
};

function AnalyzeTab() {
  const session = useDawStore((s) => s.session);
  const { analysis, findings, busy } = useIntelStore();
  const analyze = useIntelStore((s) => s.analyze);
  const apply = useIntelStore((s) => s.apply);

  const asSuggestions = useMemo((): Suggestion[] => findings
    .filter((f) => f.actions.length > 0)
    .map((f) => ({
      id: f.id,
      title: f.title,
      reason: `${f.measurement} — ${f.reason}`,
      confidence: f.severity === 'critical' ? 0.9 : f.severity === 'warning' ? 0.7 : 0.5,
      actions: f.actions,
    })), [findings]);

  return (
    <div className="flex flex-col gap-3">
      <p style={hint}>
        믹스와 모든 트랙을 렌더링해 BS.1770-4 라우드니스 · 트루 피크 · 스펙트럼 · 상관도를 잽니다.
        여기서 나온 수치 위에서만 나머지 탭이 동작합니다.
      </p>
      <div className="flex items-center gap-2">
        <Action primary disabled={!!busy} onClick={() => void analyze()}>믹스 분석</Action>
        {analysis && (
          <span style={{ fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary }}>
            {summarise(findings)} · 트랙 {analysis.tracks.length}개
          </span>
        )}
      </div>

      {analysis && (
        <div className="flex flex-wrap gap-2 mt-1">
          {analysis.tracks.map((track) => (
            <span key={track.trackId} style={{
              padding: '3px 8px', borderRadius: 3, fontFamily: premium.type.mono, fontSize: 10,
              background: premium.surface.well, border: `1px solid ${premium.surface.hairline}`,
              color: track.silent ? premium.text.faint : premium.text.secondary,
            }} title={track.guess.matched ? `근거: ${track.guess.matched}` : '역할을 추정하지 못했습니다'}>
              {track.name} · {track.guess.confidence > 0 ? roleLabel(track.guess.role) : '미상'}
              {!track.silent && ` · ${track.integratedLufs.toFixed(1)} LUFS`}
            </span>
          ))}
        </div>
      )}

      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} />
      ))}

      {asSuggestions.length > 0 && (
        <SuggestionList
          suggestions={asSuggestions}
          onApply={() => apply(asSuggestions)}
          applyLabel="선택한 수정 적용"
          session={session}
        />
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const color = SEVERITY_COLOR[finding.severity];
  return (
    <div style={{
      padding: '8px 11px', borderRadius: 5, background: premium.surface.frame,
      border: `1px solid ${premium.surface.hairline}`, borderLeft: `3px solid ${color}`,
    }}>
      <div className="flex items-center gap-2">
        <span style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.primary }}>
          {finding.title}
        </span>
        <span style={{ fontFamily: premium.type.mono, fontSize: 10, color }}>
          {finding.measurement}
        </span>
      </div>
      <p style={{ ...hint, margin: '3px 0 0' }}>{finding.reason}</p>
      {finding.actions.length === 0 && finding.manual && (
        <p style={{ ...hint, margin: '3px 0 0', color: premium.accent.cool }}>
          → {finding.manual}
        </p>
      )}
    </div>
  );
}

// ── Suggestion tabs ───────────────────────────────────────────────────────────

function SuggestionTab(
  { title, blurb, run, runLabel, suggestions }: {
    title: string; blurb: string; run: () => void; runLabel: string; suggestions: Suggestion[];
  },
) {
  const session = useDawStore((s) => s.session);
  const apply = useIntelStore((s) => s.apply);
  const analysis = useIntelStore((s) => s.analysis);
  return (
    <div className="flex flex-col gap-3">
      <div style={{
        fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light,
      }}>{title}</div>
      <p style={hint}>{blurb}</p>
      <div className="flex items-center gap-2">
        <Action primary onClick={run} disabled={!analysis}>{runLabel}</Action>
        {!analysis && <span style={hint}>ANALYZE 탭에서 먼저 분석하세요.</span>}
      </div>
      <SuggestionList
        suggestions={suggestions}
        onApply={() => apply(suggestions)}
        applyLabel="선택 적용"
        session={session}
      />
    </div>
  );
}

function MasterTab() {
  const { masterTarget, masterSuggestions, analysis } = useIntelStore();
  const setTarget = useIntelStore((s) => s.setMasterTarget);
  const run = useIntelStore((s) => s.runMaster);
  const apply = useIntelStore((s) => s.apply);
  const session = useDawStore((s) => s.session);
  const reference = useReferenceStore((s) => s.reference);

  const profile = MASTER_PROFILES.find((p) => p.id === masterTarget);
  return (
    <div className="flex flex-col gap-3">
      <div style={{ fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light }}>
        AI Master
      </div>
      <p style={hint}>
        타깃과 현재 측정치의 거리를 계산해 <b>가장 작은 체인</b>을 제안합니다. 이미 맞는 단계는
        추가하지 않습니다 — 바이패스된 플러그인 다섯 개는 마스터가 아니라 잡동사니입니다.
      </p>

      <div className="flex items-center gap-1.5 flex-wrap">
        {[...MASTER_PROFILES.map((p) => ({ id: p.id, name: p.name })),
          { id: 'reference' as const, name: reference ? `레퍼런스 (${reference.name})` : '레퍼런스 (없음)' }]
          .map((option) => (
            <button key={option.id} onClick={() => setTarget(option.id)}
              style={{
                height: 24, padding: '0 11px', borderRadius: 3,
                fontFamily: premium.type.sans, fontSize: 10.5,
                color: masterTarget === option.id ? premium.text.onAccent : premium.text.muted,
                background: masterTarget === option.id ? premium.accent.base : premium.surface.well,
                border: `1px solid ${premium.surface.hairline}`,
              }}>{option.name}</button>
          ))}
      </div>

      {profile && (
        <div style={{
          padding: '6px 10px', borderRadius: 4, background: premium.surface.well,
          border: `1px solid ${premium.surface.hairline}`,
          fontFamily: premium.type.mono, fontSize: 10.5, color: premium.text.secondary,
        }}>
          {profile.lufs} LUFS · {profile.ceilingDbtp} dBTP · PLR {profile.plr} · 폭 {profile.widthPercent}%
          <div style={{ ...hint, marginTop: 2 }}>{profile.note}</div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Action primary onClick={run} disabled={!analysis}>마스터 체인 제안</Action>
        {!analysis && <span style={hint}>ANALYZE 탭에서 먼저 분석하세요.</span>}
      </div>

      <SuggestionList
        suggestions={masterSuggestions}
        onApply={() => apply(masterSuggestions)}
        applyLabel="체인 적용"
        session={session}
      />
    </div>
  );
}

function AutomationTab() {
  const session = useDawStore((s) => s.session);
  const { automationSuggestions, busy } = useIntelStore();
  const runRide = useIntelStore((s) => s.runRide);
  const runDuck = useIntelStore((s) => s.runDuck);
  const apply = useIntelStore((s) => s.apply);
  const [source, setSource] = React.useState('');
  const [target, setTarget] = React.useState('');

  const audio = session.tracks.filter((t) => t.kind === 'audio' || t.kind === 'instrument');

  return (
    <div className="flex flex-col gap-3">
      <div style={{ fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light }}>
        Auto Automation
      </div>
      <p style={hint}>
        컴프레서와 달리 <b>곡선이 그려져 남습니다</b>. 어디서 얼마나 움직이는지 보이고, 마음에 안 들면
        손으로 고칠 수 있습니다.
      </p>

      <div style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.secondary }}>
        볼륨 라이딩 — 트랙 자기 중앙값 기준으로 흔들림만 되돌립니다
      </div>
      <div className="flex flex-wrap gap-1.5">
        {audio.map((track) => (
          <button key={track.id} disabled={!!busy}
                  onClick={() => void runRide(track.id)} style={chip}>{track.name}</button>
        ))}
      </div>

      <div style={{
        fontFamily: premium.type.sans, fontSize: 11, color: premium.text.secondary, marginTop: 6,
      }}>덕킹 — 소스의 트랜지언트마다 타깃이 비켜 줍니다</div>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
          <option value="">소스 (예: Kick)</option>
          {audio.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span style={hint}>→</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
          <option value="">타깃 (예: Bass)</option>
          {audio.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <Action disabled={!source || !target || source === target || !!busy}
                onClick={() => void runDuck(source, target)}>덕킹 곡선 만들기</Action>
      </div>

      <SuggestionList
        suggestions={automationSuggestions}
        onApply={() => apply(automationSuggestions)}
        applyLabel="오토메이션 적용"
        session={session}
      />
    </div>
  );
}

function RiffTab() {
  const session = useDawStore((s) => s.session);
  const open = useMidiEditorStore((s) => s.open);
  const scale = useMidiEditorStore((s) => s.scale);
  const { riffOptions, riffSuggestions } = useIntelStore();
  const setOptions = useIntelStore((s) => s.setRiffOptions);
  const runRiff = useIntelStore((s) => s.runRiff);
  const runVariation = useIntelStore((s) => s.runVariation);
  const apply = useIntelStore((s) => s.apply);

  const part = useMemo(() => {
    if (!open) return null;
    const track = session.tracks.find((t) => t.id === open.trackId);
    const clip = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === open.clipId);
    return track && clip ? { trackName: track.name, clip } : null;
  }, [session, open]);

  const harmony = useMemo(() => {
    if (!part) return '';
    const chords = chordsForClip(session, part.clip);
    return chords.length === 0
      ? '코드 트랙이 비어 있습니다 — 스케일만 참고합니다'
      : chords.slice(0, 6).map((c) => formatChord(c.chord)).join(' → ')
        + (chords.length > 6 ? ' …' : '');
  }, [session, part]);

  return (
    <div className="flex flex-col gap-3">
      <div style={{ fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light }}>
        Riff Machine
      </div>
      <p style={hint}>
        스케일에서 아무 음이나 고르는 생성기는 쓸모가 없습니다 — <b>스케일에 맞는 노이즈도
        노이즈</b>입니다. 여기서는 강박에 코드 톤, 약박에 경과음을 놓고, 프레이즈에 모양을
        주고, 도약 뒤에는 반대 방향 순차진행으로 해소하고, 뒷마디가 앞마디를 되풀이합니다.
      </p>

      <div style={{
        padding: '6px 10px', borderRadius: 4, background: premium.surface.well,
        border: `1px solid ${premium.surface.hairline}`,
        fontFamily: premium.type.mono, fontSize: 10.5, color: premium.text.secondary,
      }}>
        {part
          ? <>대상: {part.trackName} · {part.clip.name} · {harmony}</>
          : 'Key Editor 에서 MIDI 파트를 열면 그 파트에 씁니다'}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {RIFF_STYLES.map((style) => (
          <button key={style} onClick={() => setOptions({ style })}
            style={{
              height: 24, padding: '0 11px', borderRadius: 3,
              fontFamily: premium.type.sans, fontSize: 10.5,
              color: riffOptions.style === style ? premium.text.onAccent : premium.text.muted,
              background: riffOptions.style === style ? premium.accent.base : premium.surface.well,
              border: `1px solid ${premium.surface.hairline}`,
            }}>{styleLabel(style)}</button>
        ))}
        <span className="w-px h-5" style={{ background: premium.surface.hairline }} />
        {CONTOURS.map((contour) => (
          <button key={contour} onClick={() => setOptions({ contour })}
            title="프레이즈의 모양 — 어디로 갔다가 돌아오는가"
            style={{
              height: 24, padding: '0 10px', borderRadius: 3,
              fontFamily: premium.type.sans, fontSize: 10,
              color: riffOptions.contour === contour ? premium.text.onAccent : premium.text.muted,
              background: riffOptions.contour === contour ? premium.accent.base : premium.surface.well,
              border: `1px solid ${premium.surface.hairline}`,
            }}>{contourLabel(contour)}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <Slider label="DENSITY" value={riffOptions.density ?? 0.5} min={0.1} max={1} step={0.05}
                onChange={(v) => setOptions({ density: v })} note="그리드의 몇 칸에 노트를 놓을지" />
        <Slider label="SYNCOPATION" value={riffOptions.syncopation ?? 0.25} min={0} max={1} step={0.05}
                onChange={(v) => setOptions({ syncopation: v })}
                note="박에서 얼마나 벗어날지 — 다운비트는 절대 움직이지 않습니다" />
        <Slider label="REPETITION" value={riffOptions.repetition ?? 0.5} min={0} max={1} step={0.05}
                onChange={(v) => setOptions({ repetition: v })}
                note="뒷마디가 앞마디를 되풀이하는 정도 — 리프는 모티프 + 변형입니다" />
        <Slider label="CHROMATIC" value={riffOptions.chromaticism ?? 0.08} min={0} max={0.6} step={0.02}
                onChange={(v) => setOptions({ chromaticism: v })}
                note="스케일 밖 경과음의 빈도" />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label style={miniLabel}>
          LOW
          <input type="number" min={21} max={108} value={riffOptions.lowPitch ?? 60}
                 onChange={(e) => setOptions({ lowPitch: Number(e.target.value) })}
                 style={numberBox} />
        </label>
        <label style={miniLabel}>
          HIGH
          <input type="number" min={21} max={108} value={riffOptions.highPitch ?? 79}
                 onChange={(e) => setOptions({ highPitch: Number(e.target.value) })}
                 style={numberBox} />
        </label>
        <label style={miniLabel}>
          SEED
          <input type="number" min={1} max={9999} value={riffOptions.seed ?? 1}
                 onChange={(e) => setOptions({ seed: Number(e.target.value) })}
                 style={numberBox} />
        </label>
        <button onClick={() => setOptions({ seed: ((riffOptions.seed ?? 1) % 999) + 1 })}
                style={chip} title="다음 시드 — 같은 시드는 언제나 같은 리프입니다">다시 굴리기</button>
        <span style={{ ...hint, marginLeft: 4 }}>
          스케일: Key Editor 설정 ({scale.scaleId})
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Action primary disabled={!part} onClick={() => runRiff(false)}>리프 생성 (대체)</Action>
        <Action disabled={!part} onClick={() => runRiff(true)}>기존 노트에 추가</Action>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span style={{ ...hint, marginRight: 2 }}>변형:</span>
        {VARIATIONS.map((kind) => (
          <button key={kind} onClick={() => runVariation(kind)} disabled={!part}
                  title={variationLabel(kind)} style={chip}>{variationLabel(kind).split(' ')[0]}</button>
        ))}
      </div>

      <SuggestionList
        suggestions={riffSuggestions}
        onApply={() => apply(riffSuggestions)}
        applyLabel="파트에 쓰기"
        session={session}
      />
      <p style={hint}>
        생성기는 <b>출발점이지 답이 아닙니다</b> — 그래서 체크가 해제된 채로 도착합니다.
        패턴에 링크된 파트라면 쓰기가 패턴을 고치므로 <b>모든 배치가 함께 바뀝니다</b>.
      </p>
    </div>
  );
}

function Slider(
  { label, value, min, max, step, onChange, note }: {
    label: string; value: number; min: number; max: number; step: number;
    onChange: (v: number) => void; note?: string;
  },
) {
  return (
    <div title={note} style={{ width: 168 }}>
      <div className="flex items-center justify-between">
        <span style={{
          fontFamily: premium.type.sans, fontSize: 9, letterSpacing: '0.12em',
          color: premium.text.faint,
        }}>{label}</span>
        <span style={{
          fontFamily: premium.type.mono, fontSize: 10, color: premium.text.secondary,
        }}>{Math.round(value * 100)}%</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ width: '100%', accentColor: premium.accent.base }} />
    </div>
  );
}

function CommandTab() {
  const session = useDawStore((s) => s.session);
  const { command, answer, busy, preferModel, chat } = useIntelStore();
  const setCommand = useIntelStore((s) => s.setCommand);
  const setPreferModel = useIntelStore((s) => s.setPreferModel);
  const run = useIntelStore((s) => s.runCommand);
  const applyIt = useIntelStore((s) => s.applyInterpretation);
  const clearChat = useIntelStore((s) => s.clearChat);
  const vocab = useMemo(() => vocabulary(), []);
  const [model, setModel] = useState<AssistantStatus>({ ok: false });
  const [keyDraft, setKeyDraft] = useState('');

  const refreshStatus = useCallback(() => {
    void assistantStatus().then(setModel);
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const saveKey = async (): Promise<void> => {
    const result = await setAssistantKey(keyDraft);
    setKeyDraft('');
    if (!result.ok && result.reason) window.alert(result.reason);
    else if (result.reason) window.alert(result.reason);
    refreshStatus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div style={{ fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light }}>
        Natural Language Control
      </div>
      <p style={hint}>
        먼저 <b>규칙 파서</b>가 봅니다 — 아는 문장이면 아무것도 밖으로 나가지 않고 즉시 해석합니다.
        모르는 문장일 때만 <b>언어 모델</b>에게 넘어가고, 모델이 만든 동작도 세션에 있는 트랙과
        장치만 통과합니다. 어느 쪽이든 <b>읽고 동의해야</b> 적용됩니다.
      </p>

      {/* Where the answer will come from, and how to change it.  A user who
          cannot tell whether their words left the machine cannot consent to
          it, so this row is never hidden. */}
      <div className="flex items-center gap-2 flex-wrap" style={{
        padding: '6px 8px', borderRadius: 4, background: premium.surface.well,
        border: `1px solid ${premium.surface.hairline}`,
      }}>
        <span style={{ ...hint, margin: 0 }}>
          {model.ok ? `모델 준비됨 · ${model.model ?? ''}` : `모델 없음 — ${model.reason ?? '규칙 파서만 씁니다'}`}
        </span>
        {model.ok ? (
          <>
            <label className="flex items-center gap-1" style={{ ...hint, margin: 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={preferModel}
                     onChange={(e) => setPreferModel(e.target.checked)} />
              규칙이 알아들어도 모델에게 묻기
            </label>
            {model.persisted === false && (
              <span style={{ ...hint, margin: 0, color: premium.accent.danger }}>
                키를 안전하게 저장할 수 없어 이번 실행에만 유지됩니다
              </span>
            )}
            <button onClick={() => { void clearAssistantKey().then(refreshStatus); }}
                    style={chip}>키 지우기</button>
            {chat.length > 0 && <button onClick={clearChat} style={chip}>대화 비우기</button>}
          </>
        ) : (
          <>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="sk-ant-…"
              style={{
                flex: 1, minWidth: 160, height: 22, padding: '0 6px', borderRadius: 3,
                background: premium.surface.frame, color: premium.text.primary,
                border: `1px solid ${premium.surface.hairline}`,
                fontFamily: premium.type.mono, fontSize: 10.5,
              }}
            />
            <button onClick={() => { void saveKey(); }} style={chip}>저장</button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder='예: "보컬 2dB 올려" · "킥 펀치 더" · "보컬이 좀 답답한데 뚫어줘"'
          style={{
            flex: 1, height: 30, padding: '0 10px', borderRadius: 4,
            background: premium.surface.well, color: premium.text.primary,
            border: `1px solid ${premium.surface.hairline}`,
            fontFamily: premium.type.sans, fontSize: 12,
          }}
        />
        <Action onClick={() => { void run(); }}>{busy ? '…' : '해석'}</Action>
      </div>

      {answer && (
        <div style={{
          padding: '10px 12px', borderRadius: 5, background: premium.surface.frame,
          border: `1px solid ${answer.actions.length === 0 ? premium.accent.danger : premium.accent.deep}`,
        }}>
          <div className="flex items-center gap-2 mb-1">
            <span style={{
              padding: '1px 6px', borderRadius: 3, fontFamily: premium.type.mono, fontSize: 9,
              color: premium.text.faint, border: `1px solid ${premium.surface.hairline}`,
            }}>{answer.source === 'model' ? '모델' : '규칙'}</span>
            {answer.degraded && (
              <span style={{ ...hint, margin: 0 }}>{answer.degraded}</span>
            )}
          </div>

          {answer.actions.length === 0 ? (
            <div style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.accent.danger }}>
              {answer.refusal ?? '적용할 동작이 없습니다'}
            </div>
          ) : (
            <>
              <div style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.primary }}>
                {answer.understood}
              </div>
              <ul style={{ margin: '5px 0 0' }}>
                {answer.actions.map((action, i) => (
                  <li key={i} style={{
                    fontFamily: premium.type.mono, fontSize: 10.5, color: premium.text.muted,
                  }}>· {describeAction(session, action)}</li>
                ))}
              </ul>
              <div className="mt-2">
                <Action primary onClick={applyIt}>적용</Action>
              </div>
            </>
          )}

          {/* Anything thrown away is shown.  A plan that lost half its actions
              to validation must never read as "understood". */}
          {answer.rejected.length > 0 && (
            <ul style={{ margin: '6px 0 0' }}>
              {answer.rejected.map((why, i) => (
                <li key={i} style={{
                  fontFamily: premium.type.mono, fontSize: 10, color: premium.accent.danger,
                }}>✕ {why}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ marginTop: 4 }}>
        <div style={{ ...hint, marginBottom: 3 }}>규칙 파서가 아는 말</div>
        <div className="flex flex-wrap gap-1">
          {[...vocab.verbs, ...vocab.targets].map((word) => (
            <span key={word} style={{
              padding: '2px 7px', borderRadius: 3, fontFamily: premium.type.mono, fontSize: 10,
              background: premium.surface.well, color: premium.text.faint,
              border: `1px solid ${premium.surface.hairline}`,
            }}>{word}</span>
          ))}
        </div>
      </div>
    </div>
  );
}


// ── Per-track reference ───────────────────────────────────────────────────────

function TrackReferenceTab() {
  const session = useDawStore((s) => s.session);
  const notify = useAppStore((s) => s.notify);
  const {
    analysis, trackRefs, trackComparison, trackMatchSuggestions,
  } = useIntelStore();
  const setTrackReference = useIntelStore((s) => s.setTrackReference);
  const setTrackReferenceMix = useIntelStore((s) => s.setTrackReferenceMix);
  const clearTrackReference = useIntelStore((s) => s.clearTrackReference);
  const runTrackMatch = useIntelStore((s) => s.runTrackMatch);
  const applySuggestions = useIntelStore((s) => s.apply);

  const [trackId, setTrackId] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);

  // Only tracks the analysis actually measured can be compared; offering the
  // rest would be a picker whose entries fail on click.
  const candidates = useMemo(
    () => (analysis?.tracks ?? []).filter((t) => !t.silent),
    [analysis],
  );
  const current = trackId || candidates[0]?.trackId || '';
  const reference = current ? trackRefs[current] : undefined;

  const load = useCallback(async (what: 'stem' | 'mix') => {
    const api = window.electronAPI;
    if (!api) { notify('electronAPI를 사용할 수 없습니다', 'error'); return; }
    if (!current) { notify('먼저 트랙을 고르세요', 'warning'); return; }
    const paths = await api.invoke('file:open-dialog-multi') as string[] | null;
    const first = paths?.[0];
    if (!first) return;
    const ctx = decodeContext();
    if (!ctx) { notify('오디오 디코더를 사용할 수 없습니다', 'error'); return; }
    setBusy(what === 'stem' ? '스템 분석 중…' : '레퍼런스 믹스 분석 중…');
    try {
      const buffer = await decodeAudioFile(ctx, first);
      const name = first.split(/[\\/]/).pop() ?? 'REFERENCE';
      if (what === 'stem') setTrackReference(current as never, buffer, name, 'stem');
      else setTrackReferenceMix(current as never, buffer, name);
      notify(`${name} 을 분석했습니다`, 'success');
    } catch (err) {
      notify(`분석 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [current, notify, setTrackReference, setTrackReferenceMix]);

  return (
    <div className="flex flex-col gap-3">
      <div style={{ fontFamily: premium.type.display, fontSize: 15, color: premium.accent.light }}>
        Per-Track Reference
      </div>
      <p style={hint}>
        트랙 하나를 <b>같은 종류의 소스</b>와 비교합니다. 완성된 믹스는 받지 않습니다 —
        보컬을 풀 믹스와 비교하면 킥과 심벌의 에너지가 보컬의 EQ 로 둔갑합니다.
        스템과 <b>그 스템이 나온 믹스</b>를 함께 넣으면 절대 레벨이 아니라
        <b> 믹스와의 관계</b>로 페이더를 맞춥니다.
      </p>

      {!analysis && (
        <div style={{ ...hint, color: premium.accent.danger }}>
          먼저 ANALYZE 탭에서 믹스를 분석하세요 — 비교하려면 내 트랙도 측정되어 있어야 합니다.
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={current}
          onChange={(e) => setTrackId(e.target.value)}
          style={{
            height: 26, minWidth: 150, padding: '0 6px', borderRadius: 3,
            background: premium.surface.well, color: premium.text.primary,
            border: `1px solid ${premium.surface.hairline}`,
            fontFamily: premium.type.sans, fontSize: 11,
          }}
        >
          {candidates.length === 0 && <option value="">분석된 트랙 없음</option>}
          {candidates.map((t) => (
            <option key={t.trackId} value={t.trackId}>{t.name}</option>
          ))}
        </select>
        <Action onClick={() => { void load('stem'); }}>스템 불러오기</Action>
        {reference && <Action onClick={() => { void load('mix'); }}>그 스템의 믹스</Action>}
        {reference && (
          <Action onClick={() => clearTrackReference(current as never)}>비우기</Action>
        )}
        <Action primary onClick={() => runTrackMatch(current as never)}>비교</Action>
        {busy && <span style={{ fontSize: 11, color: premium.accent.base }}>{busy}</span>}
      </div>

      {reference && (
        <div style={{ ...hint }}>
          레퍼런스: <b>{reference.name}</b>
          {reference.mix ? ` · 믹스: ${reference.mix.name}` : ' · 믹스 없음 (레벨은 비교하지 않습니다)'}
        </div>
      )}

      {trackComparison?.blocked && (
        <div style={{
          padding: '10px 12px', borderRadius: 5, background: premium.surface.frame,
          border: `1px solid ${premium.accent.danger}`,
          fontFamily: premium.type.sans, fontSize: 12, color: premium.accent.danger,
        }}>{trackComparison.blocked}</div>
      )}

      {trackComparison && !trackComparison.blocked && (
        <>
          <div style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.primary }}>
            {trackMatchSummary(trackComparison, trackMatchSuggestions)}
          </div>

          <table style={{ borderCollapse: 'collapse', fontFamily: premium.type.mono, fontSize: 10.5 }}>
            <tbody>
              {trackComparison.rows.map((row) => (
                <tr key={row.id} style={{ opacity: row.skipped ? 0.45 : 1 }}>
                  <td style={cell(premium.text.secondary)}>{row.label}</td>
                  <td style={cell(premium.text.muted)}>{row.reference.toFixed(1)}</td>
                  <td style={cell(premium.text.muted)}>{row.mine.toFixed(1)}</td>
                  <td style={cell(row.skipped ? premium.text.faint
                    : row.verdict === 'match' ? premium.accent.base : premium.accent.danger)}>
                    {row.skipped ?? `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(1)} ${row.unit}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {trackComparison.notes.map((note, i) => (
            <div key={i} style={{ ...hint, color: premium.text.muted }}>· {note}</div>
          ))}

          <SuggestionList
            suggestions={trackMatchSuggestions}
            onApply={() => applySuggestions(trackMatchSuggestions)}
            applyLabel="이 트랙에 적용"
            session={session}
          />
        </>
      )}
    </div>
  );
}

function cell(color: string): React.CSSProperties {
  return { padding: '2px 10px 2px 0', color, whiteSpace: 'nowrap' };
}

// ── Shared ────────────────────────────────────────────────────────────────────

function SuggestionList(
  { suggestions, onApply, applyLabel, session }: {
    suggestions: Suggestion[]; onApply: () => void; applyLabel: string;
    session: ReturnType<typeof useDawStore.getState>['session'];
  },
) {
  const selected = useIntelStore((s) => s.selected);
  const toggle = useIntelStore((s) => s.toggleSelected);
  const selectAll = useIntelStore((s) => s.selectAll);
  const clear = useIntelStore((s) => s.clearSelection);
  if (suggestions.length === 0) return null;
  const chosen = suggestions.filter((s) => selected.has(s.id)).length;

  return (
    <div className="flex flex-col gap-1.5 mt-1">
      <div className="flex items-center gap-2">
        <Action primary disabled={chosen === 0} onClick={onApply}>
          {applyLabel} ({chosen})
        </Action>
        <Action onClick={() => selectAll(suggestions)}>전체 선택</Action>
        <Action onClick={clear}>선택 해제</Action>
      </div>

      {suggestions.map((suggestion) => {
        const on = selected.has(suggestion.id);
        return (
          <button key={suggestion.id} onClick={() => toggle(suggestion.id)}
            className="text-left"
            style={{
              padding: '8px 11px', borderRadius: 5,
              background: on ? premium.surface.overlay : premium.surface.frame,
              border: `1px solid ${on ? premium.accent.deep : premium.surface.hairline}`,
            }}>
            <div className="flex items-center gap-2">
              <span style={{
                width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                background: on ? premium.accent.base : 'transparent',
                border: `1px solid ${on ? premium.accent.deep : premium.surface.hairlineStrong}`,
              }} />
              <span style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.primary }}>
                {suggestion.title}
              </span>
              <span style={{
                marginLeft: 'auto', fontFamily: premium.type.mono, fontSize: 9.5,
                color: suggestion.confidence >= 0.7 ? premium.accent.good
                  : suggestion.confidence >= 0.5 ? premium.accent.base : premium.text.faint,
              }}>확신도 {Math.round(suggestion.confidence * 100)}%</span>
            </div>
            <p style={{ ...hint, margin: '3px 0 0 20px' }}>{suggestion.reason}</p>
            <ul style={{ margin: '3px 0 0 20px' }}>
              {suggestion.actions.map((action, i) => (
                <li key={i} style={{
                  fontFamily: premium.type.mono, fontSize: 10, color: premium.text.faint,
                }}>· {describeAction(session, action)}</li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

const hint: React.CSSProperties = {
  fontFamily: premium.type.sans, fontSize: 10.5, lineHeight: 1.55, color: premium.text.muted,
};
const selectStyle: React.CSSProperties = {
  height: 26, borderRadius: 3, fontSize: 11, minWidth: 150,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`,
};
const miniLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 3,
  fontFamily: premium.type.sans, fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint,
};
const numberBox: React.CSSProperties = {
  width: 52, height: 22, borderRadius: 3, padding: '0 5px',
  background: premium.surface.well, color: premium.text.primary,
  border: `1px solid ${premium.surface.hairline}`,
  fontFamily: premium.type.mono, fontSize: 10.5,
};
const chip: React.CSSProperties = {
  height: 24, padding: '0 10px', borderRadius: 3,
  fontFamily: premium.type.sans, fontSize: 10.5, color: premium.text.secondary,
  background: premium.surface.well, border: `1px solid ${premium.surface.hairline}`,
};

function Action(
  { onClick, children, disabled, primary }: {
    onClick: () => void; children: React.ReactNode; disabled?: boolean; primary?: boolean;
  },
) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      height: 26, padding: '0 13px', borderRadius: 4,
      fontFamily: premium.type.sans, fontSize: 11,
      color: disabled ? premium.text.faint : primary ? premium.text.onAccent : premium.text.secondary,
      background: disabled ? premium.surface.well : primary ? premium.accent.base : premium.surface.well,
      border: `1px solid ${disabled ? premium.surface.hairline
        : primary ? premium.accent.deep : premium.surface.hairline}`,
      cursor: disabled ? 'default' : 'pointer',
    }}>{children}</button>
  );
}
