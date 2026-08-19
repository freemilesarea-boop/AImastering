// RestorePanel — the four restoration tools.
//
// They share one idea: MEASURE first, then act.  The denoiser will not run
// without a learned profile, the de-clicker shows you the list of what it
// found before it touches anything, the de-hummer refuses to notch a comb it
// did not detect, and de-reverb reads T60 off the material.  Restoration goes
// wrong when a process is applied blind, so none of them can be.
//
// The noise region is the Edit window's own time selection — the same range
// you would trim or fade — because that is the selection the user already
// knows how to make.

import React, { useCallback, useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { getCached } from '../../../daw/engine/audio-cache.js';
import { profileBands, type NoiseProfile } from '../../../daw/audio/noise-reduction.js';
import type { ClickEvent } from '../../../daw/audio/declick.js';
import { describeHum, type HumDetection } from '../../../daw/audio/dehum.js';
import { describeReverb, type ReverbEstimate } from '../../../daw/audio/dereverb.js';
import {
  declickClip, declipClip, dehumClip, denoiseClip, dereverbClip, detectClipHum,
  estimateClipReverb, learnClipNoise, scanClipClicks, scanClipClipping,
  type ClippingReport,
} from '../../../daw/edit/restore-actions.js';
import { premium } from '../../../theme/premium.js';
import type { Clip, Track } from '../../../daw/model/types.js';

export default function RestorePanel() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const selection = useDawStore((s) => s.selection);

  const [profile, setProfile] = useState<NoiseProfile | null>(null);
  const [floorDb, setFloorDb] = useState<number | null>(null);
  const [reductionDb, setReductionDb] = useState(12);
  const [sensitivity, setSensitivity] = useState(1);
  const [strength, setStrength] = useState(1.5);
  const [smoothing, setSmoothing] = useState(0.5);

  const [hum, setHum] = useState<HumDetection | null>(null);
  const [humScanned, setHumScanned] = useState(false);
  const [humReductionDb, setHumReductionDb] = useState(24);
  const [humHarmonics, setHumHarmonics] = useState(40);

  const [reverb, setReverb] = useState<ReverbEstimate | null>(null);
  const [reverbScanned, setReverbScanned] = useState(false);
  const [t60, setT60] = useState(0.8);
  const [reverbStrength, setReverbStrength] = useState(1);
  const [reverbReductionDb, setReverbReductionDb] = useState(18);
  const [earlyMs, setEarlyMs] = useState(40);

  const [clipping, setClipping] = useState<ClippingReport | null>(null);

  const [clicks, setClicks] = useState<ClickEvent[] | null>(null);
  const [clickSensitivity, setClickSensitivity] = useState(8);
  const [maxWidthMs, setMaxWidthMs] = useState(3);
  const [busy, setBusy] = useState<string | null>(null);

  const target = useMemo((): { track: Track; clip: Clip } | null => {
    const tracks = focusedTrackId
      ? ([findTrack(session, focusedTrackId)].filter(Boolean) as Track[])
      : session.tracks;
    for (const track of tracks) {
      const audio = trackClips(track).filter((c) => c.kind === 'audio');
      const under = audio.find((c) => playheadSec >= c.startSec && playheadSec < c.startSec + c.durationSec);
      const clip = under ?? audio[0];
      if (clip) return { track, clip };
    }
    for (const track of session.tracks) {
      const clip = trackClips(track).find((c) => c.kind === 'audio');
      if (clip) return { track, clip };
    }
    return null;
  }, [session, focusedTrackId, playheadSec]);

  const cached = target ? getCached(target.clip.fileId) : undefined;
  const selectionLength = Math.abs(selection.endSec - selection.startSec);

  const learn = useCallback(() => {
    if (!target) return;
    try {
      const result = learnClipNoise(
        useDawStore.getState().session, target.track.id, target.clip.id,
        selection.startSec, selection.endSec);
      setProfile(result.profile);
      setFloorDb(result.floorDb);
      notify(`노이즈 프로파일 학습 완료 — 플로어 ${result.floorDb.toFixed(1)} dBFS`, 'success');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  }, [target, selection.startSec, selection.endSec, notify]);

  const runDenoise = useCallback(async (output: 'clean' | 'residual') => {
    if (!target || !profile) return;
    setBusy(output === 'clean' ? '노이즈 제거 중…' : '잔차 만드는 중…');
    try {
      const result = await denoiseClip(
        useDawStore.getState().session, target.track.id, target.clip.id, profile,
        { reductionDb, sensitivity, strength, smoothing, output });
      apply(() => result.session);
      notify(result.message, 'success');
    } catch (err) {
      notify(`노이즈 리덕션 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [target, profile, reductionDb, sensitivity, strength, smoothing, apply, notify]);

  const scan = useCallback(() => {
    if (!target) return;
    try {
      const result = scanClipClicks(
        useDawStore.getState().session, target.track.id, target.clip.id,
        { sensitivity: clickSensitivity, maxWidthMs });
      setClicks(result.clicks);
      notify(result.clicks.length === 0
        ? '클릭을 찾지 못했습니다'
        : `클릭 ${result.clicks.length}개를 찾았습니다`, result.clicks.length ? 'success' : 'info');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  }, [target, clickSensitivity, maxWidthMs, notify]);

  const repairAll = useCallback(async () => {
    if (!target) return;
    setBusy('클릭 복원 중…');
    try {
      const result = await declickClip(
        useDawStore.getState().session, target.track.id, target.clip.id,
        { sensitivity: clickSensitivity, maxWidthMs });
      if (result.detected > 0) apply(() => result.session);
      setClicks(null);
      notify(result.message, result.detected > 0 ? 'success' : 'info');
    } catch (err) {
      notify(`디클릭 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [target, clickSensitivity, maxWidthMs, apply, notify]);

  const scanClipping = useCallback(() => {
    if (!target) return;
    try {
      const report = scanClipClipping(
        useDawStore.getState().session, target.track.id, target.clip.id);
      setClipping(report);
      notify(report.description, report.runs > 0 ? 'warning' : 'info');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  }, [target, notify]);

  const runDeclip = useCallback(async () => {
    if (!target) return;
    setBusy('클리핑 복원 중…');
    try {
      const result = await declipClip(
        useDawStore.getState().session, target.track.id, target.clip.id);
      if (result.repaired > 0) apply(() => result.session);
      setClipping(null);
      notify(result.message, result.repaired > 0 ? 'success' : 'info');
    } catch (err) {
      notify(`디클립 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [target, apply, notify]);

  const scanHum = useCallback(() => {
    if (!target) return;
    try {
      const found = detectClipHum(useDawStore.getState().session, target.track.id, target.clip.id);
      setHum(found);
      setHumScanned(true);
      notify(describeHum(found), found ? 'success' : 'info');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  }, [target, notify]);

  const runDehum = useCallback(async (output: 'clean' | 'residual') => {
    if (!target || !hum) return;
    setBusy(output === 'clean' ? '험 제거 중…' : '험 잔차 만드는 중…');
    try {
      const result = await dehumClip(
        useDawStore.getState().session, target.track.id, target.clip.id, hum,
        { reductionDb: humReductionDb, maxHarmonics: humHarmonics, output });
      apply(() => result.session);
      notify(result.message, 'success');
    } catch (err) {
      notify(`디험 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [target, hum, humReductionDb, humHarmonics, apply, notify]);

  const measureReverb = useCallback(() => {
    if (!target) return;
    try {
      const estimate = estimateClipReverb(useDawStore.getState().session, target.track.id, target.clip.id);
      setReverb(estimate);
      setReverbScanned(true);
      if (estimate) setT60(Number(estimate.t60.toFixed(2)));
      notify(describeReverb(estimate), estimate ? 'success' : 'info');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  }, [target, notify]);

  const runDereverb = useCallback(async (output: 'clean' | 'residual') => {
    if (!target) return;
    setBusy(output === 'clean' ? '잔향 제거 중…' : '잔향 꼬리 분리 중…');
    try {
      const result = await dereverbClip(
        useDawStore.getState().session, target.track.id, target.clip.id, t60,
        { strength: reverbStrength, reductionDb: reverbReductionDb, earlyMs, output });
      apply(() => result.session);
      notify(result.message, 'success');
    } catch (err) {
      notify(`디리버브 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [target, t60, reverbStrength, reverbReductionDb, earlyMs, apply, notify]);

  if (!target) return <Empty message="오디오 클립이 있는 트랙이 필요합니다" />;
  if (!cached) return <Empty message="오디오를 디코딩하는 중입니다 — Edit 창에서 클립을 먼저 여세요" />;

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: premium.surface.abyss }}>
      <div className="flex items-center gap-3 px-4 py-2"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Restoration
        </span>
        <span style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
          {target.track.name} · {target.clip.name}
        </span>
        <div className="flex-1" />
        {busy && <span style={{ fontSize: 11, color: premium.accent.base }}>{busy}</span>}
      </div>

      <div className="p-4 flex gap-4 flex-wrap items-start">
        {/* Noise reduction */}
        <Module title="Noise Reduction">
          <p style={hint}>
            Edit 창에서 <b>노이즈만 있는 구간</b>을 선택하고 학습을 누르세요. 학습한 스펙트럼만
            빼기 때문에, 조용한 연주가 노이즈와 함께 사라지지 않습니다.
          </p>

          <div className="flex items-center gap-2 my-2">
            <Action onClick={learn} disabled={selectionLength < 0.1}>노이즈 학습</Action>
            <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.muted }}>
              선택 {selectionLength.toFixed(3)} s
              {selectionLength < 0.1 && ' — 0.1 s 이상 필요'}
            </span>
          </div>

          {profile && (
            <div className="mb-2 px-2 py-1.5 rounded"
                 style={{ background: premium.surface.well, border: `1px solid ${premium.surface.hairline}` }}>
              <div style={{ fontFamily: premium.type.mono, fontSize: 11, color: premium.accent.base }}>
                플로어 {floorDb?.toFixed(1)} dBFS · {profile.frames} 프레임 · {profile.durationSec.toFixed(2)} s
              </div>
              <ProfileCurve profile={profile} />
            </div>
          )}

          <Slider label="REDUCTION" value={reductionDb} min={3} max={36} step={1} unit=" dB"
                  onChange={setReductionDb}
                  note="노이즈 전용 빈이 받는 최대 감쇠. 깎아낸 구멍이 노이즈보다 더 들릴 수 있으니 무한대는 없습니다." />
          <Slider label="SENSITIVITY" value={sensitivity} min={0} max={3} step={0.1}
                  onChange={setSensitivity}
                  note="임계값 = 평균 + 이 값 × 표준편차. 높이면 더 많이 지웁니다." />
          <Slider label="STRENGTH" value={strength} min={1} max={3} step={0.1} unit="×"
                  onChange={setStrength}
                  note="측정치보다 얼마나 더 빼는가 (오버서브트랙션)." />
          <Slider label="SMOOTHING" value={smoothing} min={0} max={0.9} step={0.05}
                  onChange={setSmoothing}
                  note="프레임 간 게인 이동 속도. 낮추면 반응이 빠르고 뮤지컬 노이즈가 늘어납니다." />

          <div className="flex items-center gap-2 mt-2">
            <Action onClick={() => void runDenoise('clean')} disabled={!profile || !!busy} primary>
              적용
            </Action>
            <Action onClick={() => void runDenoise('residual')} disabled={!profile || !!busy}>
              잔차 듣기
            </Action>
          </div>
          <p style={hint}>
            잔차는 <b>제거될 성분만</b> 남긴 버전입니다. 거기서 음악이 들리면 과처리입니다.
          </p>
        </Module>

        {/* De-click */}
        <Module title="De-click">
          <p style={hint}>
            클릭은 파형의 <b>불연속</b>입니다. 2차 차분이 스파이크를 잡고, 폭 검사가 스네어와
            구분합니다 — 둘 다 날카롭지만 클릭만 짧습니다.
          </p>

          <Slider label="SENSITIVITY" value={clickSensitivity} min={3} max={20} step={0.5} unit="×"
                  onChange={setClickSensitivity}
                  note="국소 평균 대비 몇 배 튀어야 후보인가." />
          <Slider label="MAX WIDTH" value={maxWidthMs} min={0.5} max={10} step={0.5} unit=" ms"
                  onChange={setMaxWidthMs}
                  note="이보다 길면 클릭이 아니라 악기의 어택입니다. 올릴수록 연주를 먹습니다." />

          <div className="flex items-center gap-2 mt-2">
            <Action onClick={scan} disabled={!!busy}>스캔</Action>
            <Action onClick={() => void repairAll()} disabled={!!busy} primary>전부 복원</Action>
          </div>

          {clicks && (
            <div className="mt-2 rounded overflow-auto"
                 style={{
                   maxHeight: 190, background: premium.surface.well,
                   border: `1px solid ${premium.surface.hairline}`,
                 }}>
              {clicks.length === 0 && (
                <p className="px-2 py-2" style={{ ...hint, margin: 0 }}>찾은 클릭이 없습니다.</p>
              )}
              {clicks.map((c, i) => (
                <div key={`${c.startSec}-${i}`} className="flex items-center gap-3 px-2 py-1"
                     style={{
                       borderBottom: `1px solid ${premium.surface.hairline}`,
                       fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary,
                     }}>
                  <span style={{ width: 78 }}>{c.startSec.toFixed(4)} s</span>
                  <span style={{ width: 62, color: premium.text.muted }}>
                    {((c.endSec - c.startSec) * 1000).toFixed(2)} ms
                  </span>
                  <span style={{ color: premium.accent.base }}>×{c.strength.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}
          <p style={hint}>
            복원은 구멍을 매끄럽게 잇는 게 아니라, 주변 오디오로 만든 AR 모델을 풀어 그 자리에
            <b> 같은 배음</b>을 다시 씁니다.
          </p>
        </Module>

        {/* De-clip */}
        <Module title="De-clip">
          <p style={hint}>
            클리핑된 샘플은 <b>망가진 게 아니라 없는 것</b>입니다. 파형이 변환기가 표현할 수 있는
            범위를 넘어갔다가 윗부분이 잘려 돌아온 것이라, 정보가 오염된 게 아니라 부재합니다.
            그래서 디클릭의 AR 보간을 그대로 씁니다 — 평평한 꼭대기를 결측 구간이라 부르면 됩니다.
          </p>

          <div className="flex items-center gap-2 my-2">
            <Action onClick={scanClipping} disabled={!!busy}>클리핑 검사</Action>
            <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.muted }}>
              {clipping
                ? `${clipping.description} · 포화 ${(clipping.ratio * 100).toFixed(2)}%`
                : '아직 검사하지 않았습니다'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Action onClick={() => void runDeclip()} disabled={!!busy} primary>복원</Action>
          </div>
          <p style={hint}>
            복원은 <b>풀스케일을 넘어도 됩니다</b> — ±1 로 묶으면 더 부드럽게 다시 클리핑할 뿐입니다.
            피크가 1.0 위로 돌아온 뒤 전체를 한 번에 낮춰서, 레벨이 아니라 <b>모양</b>을 되돌립니다.
          </p>
          <p style={hint}>
            풀스케일에 닿은 샘플 <b>하나는 클리핑이 아닙니다.</b> 0 dBFS 를 스치는 사인은 원래
            그 지점에 샘플이 하나 있습니다. 클리핑은 <b>연속</b>이고 평평합니다.
          </p>
        </Module>

        {/* De-hum */}
        <Module title="De-hum">
          <p style={hint}>
            전원 험은 <b>빗살 모양의 노이즈 프로파일</b>입니다. 각 하모닉에서 <b>시간축 하위
            백분위</b>를 빼기 때문에, 100 Hz에 걸린 베이스 음은 살아남고 계속 깔려 있던 험만
            사라집니다.
          </p>

          <div className="flex items-center gap-2 my-2">
            <Action onClick={scanHum} disabled={!!busy}>험 검사</Action>
            <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.muted }}>
              {humScanned ? describeHum(hum) : '아직 검사하지 않았습니다'}
            </span>
          </div>

          {hum && (
            <div className="mb-2 px-2 py-1.5 rounded"
                 style={{ background: premium.surface.well, border: `1px solid ${premium.surface.hairline}` }}>
              <div style={{ fontFamily: premium.type.mono, fontSize: 10.5, color: premium.text.secondary }}>
                {hum.harmonics.slice(0, 8).map((h) => `${h.hz.toFixed(1)}`).join(' · ')}
                {hum.harmonics.length > 8 ? ` … +${hum.harmonics.length - 8}` : ''} Hz
              </div>
            </div>
          )}

          <Slider label="REDUCTION" value={humReductionDb} min={6} max={48} step={1} unit=" dB"
                  onChange={setHumReductionDb} note="각 하모닉이 받는 최대 감쇠." />
          <Slider label="HARMONICS" value={humHarmonics} min={1} max={60} step={1}
                  onChange={setHumHarmonics}
                  note="몇 번째 하모닉까지 지울지. 낮추면 저역만 정리합니다." />

          <div className="flex items-center gap-2 mt-2">
            <Action onClick={() => void runDehum('clean')} disabled={!hum || !!busy} primary>적용</Action>
            <Action onClick={() => void runDehum('residual')} disabled={!hum || !!busy}>잔차 듣기</Action>
          </div>
          <p style={hint}>
            검출되지 않으면 아무것도 하지 않습니다 — 험이 아닌 빗살을 지우면 베이스가 사라집니다.
          </p>
        </Module>

        {/* De-reverb */}
        <Module title="De-reverb">
          <p style={hint}>
            잔향은 <b>수십 ms 전의 소리가 감쇠한 복사본</b>입니다. 그래서 같은 빈의 과거 값에
            방의 감쇠를 곱해 빼면 남는 건 직접음입니다. 잘못된 T60은 복원이 아니라 손상이므로
            먼저 재고 시작합니다.
          </p>

          <div className="flex items-center gap-2 my-2">
            <Action onClick={measureReverb} disabled={!!busy}>잔향 측정</Action>
            <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.muted }}>
              {reverbScanned ? describeReverb(reverb) : '아직 재지 않았습니다'}
            </span>
          </div>

          <Slider label="T60" value={t60} min={0.1} max={3} step={0.05} unit=" s"
                  onChange={setT60} note="방이 60 dB 감쇠하는 시간. 측정값을 귀로 보정하세요." />
          <Slider label="STRENGTH" value={reverbStrength} min={0} max={3} step={0.1} unit="×"
                  onChange={setReverbStrength} note="추정된 꼬리를 얼마나 빼는가. 0은 무처리." />
          <Slider label="REDUCTION" value={reverbReductionDb} min={3} max={36} step={1} unit=" dB"
                  onChange={setReverbReductionDb} note="한 빈이 받을 수 있는 최대 감쇠." />
          <Slider label="EARLY" value={earlyMs} min={10} max={120} step={5} unit=" ms"
                  onChange={setEarlyMs}
                  note="이보다 이른 반사는 방의 성격이라 건드리지 않습니다. 줄이면 파이프 안에서 녹음한 소리가 됩니다." />

          <div className="flex items-center gap-2 mt-2">
            <Action onClick={() => void runDereverb('clean')} disabled={!!busy} primary>적용</Action>
            <Action onClick={() => void runDereverb('residual')} disabled={!!busy}>꼬리만 듣기</Action>
          </div>
          <p style={hint}>
            <b>지속음은 이 모델에서 잔향처럼 보입니다.</b> 타악·보컬·발현악기용이고, 길게 끄는
            패드에서는 음이 얇아집니다 — STRENGTH 로 조절하세요.
          </p>
        </Module>
      </div>
    </div>
  );
}

const hint: React.CSSProperties = {
  fontFamily: premium.type.sans, fontSize: 10.5, lineHeight: 1.5,
  color: premium.text.muted, margin: '4px 0',
};

function Module({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      width: 420, maxWidth: '100%', padding: '12px 14px', borderRadius: 6,
      background: premium.surface.frame, backgroundImage: premium.gradient.frame,
      border: `1px solid ${premium.surface.hairline}`, boxShadow: premium.shadow.frame,
    }}>
      <h3 style={{
        fontFamily: premium.type.display, fontSize: 16, color: premium.accent.light,
        marginBottom: 6, borderBottom: `1px solid ${premium.surface.engrave}`, paddingBottom: 4,
      }}>{title}</h3>
      {children}
    </section>
  );
}

function Slider(
  { label, value, min, max, step, unit = '', onChange, note }: {
    label: string; value: number; min: number; max: number; step: number;
    unit?: string; onChange: (v: number) => void; note?: string;
  },
) {
  return (
    <div className="mt-1.5" title={note}>
      <div className="flex items-center justify-between">
        <span style={{
          fontFamily: premium.type.sans, fontSize: 9.5, letterSpacing: '0.12em',
          color: premium.text.faint,
        }}>{label}</span>
        <span style={{
          fontFamily: premium.type.mono, fontSize: 11, color: premium.text.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ width: '100%', accentColor: premium.accent.base }} />
    </div>
  );
}

/** The learned noise floor, drawn low to high. */
function ProfileCurve({ profile }: { profile: NoiseProfile }) {
  const bands = useMemo(() => profileBands(profile, 24), [profile]);
  const width = 380;
  const height = 46;
  const path = bands.map((b, i) => {
    const x = (i / Math.max(1, bands.length - 1)) * width;
    const y = height * (1 - Math.max(0, Math.min(1, (b.db + 100) / 100)));
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, marginTop: 4 }}>
      <path d={path} fill="none" stroke={premium.accent.cool} strokeWidth={1.4} />
    </svg>
  );
}

function Action(
  { onClick, children, disabled, primary }: {
    onClick: () => void; children: React.ReactNode; disabled?: boolean; primary?: boolean;
  },
) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      height: 26, padding: '0 13px', borderRadius: 4,
      fontFamily: premium.type.sans, fontSize: 11,
      color: disabled ? premium.text.faint
        : primary ? premium.text.onAccent : premium.text.secondary,
      background: disabled ? premium.surface.well
        : primary ? premium.accent.base : premium.surface.well,
      border: `1px solid ${disabled ? premium.surface.hairline
        : primary ? premium.accent.deep : premium.surface.hairline}`,
      cursor: disabled ? 'default' : 'pointer',
    }}>{children}</button>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: premium.surface.abyss }}>
      <p style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>{message}</p>
    </div>
  );
}
