// Problem detection — what is actually wrong, and what to do about it.
//
// A meter tells you a number.  A diagnosis tells you a number IS A PROBLEM,
// and that is a different claim: it needs a threshold, a reason the threshold
// exists, and — this is the part most tools skip — a fix that can be applied.
//
// So every finding here carries three things:
//
//   the measurement   the number, so the user can disagree with the verdict
//   the reason        why that number matters, in one sentence
//   the fix           a list of actions, or none if there is nothing honest
//                     to suggest
//
// A finding with no fix is still worth reporting ("your left and right are
// out of phase") — but a finding whose fix is guesswork is worse than silence,
// so those ship with `actions: []` and say what to check instead.

import { findTrack } from '../model/session-ops.js';
import { bandLevelDb } from '../analysis/reference.js';
import { masterBands, type MixAnalysis, type TrackAnalysis } from './analysis.js';
import { ROLE_PROFILES, roleLabel } from './roles.js';
import type { IntelAction } from './actions.js';
import type { DawSession, TrackId } from '../model/types.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  /** Short enough to scan in a list. */
  title: string;
  /** The measurement, stated plainly. */
  measurement: string;
  /** Why it matters. */
  reason: string;
  trackId?: TrackId;
  /** Empty when there is nothing honest to suggest. */
  actions: IntelAction[];
  /** What to do by hand when `actions` is empty. */
  manual?: string;
}

export interface DiagnoseOptions {
  /** Delivery target, LUFS.  −14 is the streaming norm. */
  targetLufs?: number;
  /** True-peak ceiling, dBTP. */
  ceilingDbtp?: number;
}

const DEFAULTS = { targetLufs: -14, ceilingDbtp: -1 };

const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function diagnose(
  session: DawSession, analysis: MixAnalysis, options: DiagnoseOptions = {},
): Finding[] {
  const targetLufs = options.targetLufs ?? DEFAULTS.targetLufs;
  const ceiling = options.ceilingDbtp ?? DEFAULTS.ceilingDbtp;
  const master = analysis.master;
  const masterTrack = session.tracks.find((t) => t.kind === 'master');
  const findings: Finding[] = [];

  // ── Delivery ──────────────────────────────────────────────────────────────

  if (Number.isFinite(master.truePeakDbtp) && master.truePeakDbtp > ceiling) {
    findings.push({
      id: 'truepeak',
      severity: master.truePeakDbtp > 0 ? 'critical' : 'warning',
      title: '트루 피크가 실링을 넘습니다',
      measurement: `${master.truePeakDbtp.toFixed(2)} dBTP (실링 ${ceiling.toFixed(1)})`,
      reason: master.truePeakDbtp > 0
        ? '0 dBTP 를 넘으면 로시 인코딩 후 실제로 클리핑됩니다 — 미터가 아니라 재생기에서.'
        : '스트리밍 인코더의 인터샘플 피크 여유를 위해 실링 아래로 두는 것이 안전합니다.',
      ...(masterTrack ? { trackId: masterTrack.id } : {}),
      actions: masterTrack ? [{
        kind: 'insertParam', trackId: masterTrack.id,
        pluginId: 'limiter', paramId: 'ceilingDb', value: ceiling,
      }] : [],
    });
  }

  if (Number.isFinite(master.integratedLufs)) {
    const delta = master.integratedLufs - targetLufs;
    if (Math.abs(delta) > 1) {
      findings.push({
        id: 'loudness',
        severity: Math.abs(delta) > 3 ? 'warning' : 'info',
        title: delta > 0 ? '타깃보다 큽니다' : '타깃보다 작습니다',
        measurement: `${master.integratedLufs.toFixed(1)} LUFS (타깃 ${targetLufs})`,
        reason: delta > 0
          ? '스트리밍 플랫폼이 재생 시 되돌려 내리므로, 크게 만든 만큼 다이내믹만 잃습니다.'
          : '타깃보다 작으면 플랫폼이 올려주지만 경쟁 트랙 사이에서 작게 들립니다.',
        ...(masterTrack ? { trackId: masterTrack.id } : {}),
        actions: masterTrack ? [{
          kind: 'trackVolume', trackId: masterTrack.id,
          db: (findTrack(session, masterTrack.id)?.volumeDb ?? 0) - delta,
        }] : [],
      });
    }
  }

  // ── Dynamics ──────────────────────────────────────────────────────────────

  if (master.dr > 0 && master.dr < 5) {
    findings.push({
      id: 'oversquashed',
      severity: 'warning',
      title: '과압축입니다',
      measurement: `PLR ${master.dr.toFixed(1)} dB`,
      reason: '피크와 평균의 거리가 5 dB 아래면 트랜지언트가 남아 있지 않습니다 — 크게 들리는 대신 지칩니다.',
      actions: [],
      manual: '리미터 입력을 낮추거나 마스터 컴프레서 레이시오를 줄이세요.',
    });
  } else if (master.dr > 16) {
    findings.push({
      id: 'undercontrolled',
      severity: 'info',
      title: '다이내믹이 넓습니다',
      measurement: `PLR ${master.dr.toFixed(1)} dB`,
      reason: '문제는 아니지만, 타깃 라우드니스에 도달하려면 피크를 먼저 다스려야 합니다.',
      actions: [],
      manual: '마스터에 컴프레서를 얹거나 트랙별 라이딩을 먼저 하세요.',
    });
  }

  // ── Stereo ────────────────────────────────────────────────────────────────

  if (master.correlation < -0.1) {
    findings.push({
      id: 'phase',
      severity: 'critical',
      title: '좌우가 위상 상쇄 중입니다',
      measurement: `상관도 ${master.correlation.toFixed(2)} · 폭 ${master.widthPercent.toFixed(0)}%`,
      reason: '모노로 합쳐지면 (클럽 · 라디오 · 스마트폰 스피커) 상쇄된 성분이 사라집니다.',
      actions: [],
      manual: '와이드너를 과하게 쓴 트랙을 찾거나, 마이크 두 대의 극성을 확인하세요.',
    });
  } else if (master.widthPercent < 40) {
    findings.push({
      id: 'narrow',
      severity: 'info',
      title: '거의 모노입니다',
      measurement: `폭 ${master.widthPercent.toFixed(0)}%`,
      reason: '의도한 것이 아니라면, 스테레오 소스가 센터로 뭉쳐 있을 수 있습니다.',
      actions: [],
      manual: '패닝과 와이드너를 확인하세요.',
    });
  }

  // ── Tonal balance ─────────────────────────────────────────────────────────

  const bands = masterBands(analysis);
  const mud = bandLevelDb(master.spectrum, 200, 450) - bands.mid;
  if (mud > 3) {
    findings.push({
      id: 'mud',
      severity: 'warning',
      title: '200–450 Hz 가 뭉칩니다',
      measurement: `중역 대비 ${mud.toFixed(1)} dB`,
      reason: '이 대역이 쌓이면 믹스가 두꺼운 게 아니라 흐려집니다.',
      ...(masterTrack ? { trackId: masterTrack.id } : {}),
      actions: masterTrack ? [
        { kind: 'insertParam', trackId: masterTrack.id, pluginId: 'eq3', paramId: 'midHz', value: 300 },
        { kind: 'insertParam', trackId: masterTrack.id, pluginId: 'eq3', paramId: 'midDb', value: -Math.min(4, mud - 1) },
      ] : [],
    });
  }

  const harsh = bandLevelDb(master.spectrum, 2000, 5000) - bands.mid;
  if (harsh > 4) {
    findings.push({
      id: 'harsh',
      severity: 'warning',
      title: '2–5 kHz 가 거칩니다',
      measurement: `중역 대비 ${harsh.toFixed(1)} dB`,
      reason: '귀가 가장 예민한 대역이라, 여기가 많으면 크게 들리는 대신 오래 못 듣습니다.',
      ...(masterTrack ? { trackId: masterTrack.id } : {}),
      actions: masterTrack ? [
        { kind: 'insertParam', trackId: masterTrack.id, pluginId: 'eq3', paramId: 'midHz', value: 3200 },
        { kind: 'insertParam', trackId: masterTrack.id, pluginId: 'eq3', paramId: 'midDb', value: -Math.min(3, harsh - 2) },
      ] : [],
    });
  }

  if (bands.high < bands.mid - 12) {
    findings.push({
      id: 'dull',
      severity: 'info',
      title: '고역이 부족합니다',
      measurement: `HIGH ${bands.high.toFixed(1)} dB · MID ${bands.mid.toFixed(1)} dB`,
      reason: '4 kHz 위가 중역보다 12 dB 이상 낮으면 답답하게 들립니다.',
      ...(masterTrack ? { trackId: masterTrack.id } : {}),
      actions: masterTrack ? [{
        kind: 'macro', trackId: masterTrack.id, macroId: 'air', value: 0.35,
      }] : [],
    });
  }

  // ── Per track ─────────────────────────────────────────────────────────────

  for (const track of analysis.tracks) {
    findings.push(...diagnoseTrack(session, analysis, track));
  }

  return findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

function diagnoseTrack(
  session: DawSession, analysis: MixAnalysis, track: TrackAnalysis,
): Finding[] {
  const out: Finding[] = [];
  const label = roleLabel(track.guess.role);

  if (track.silent) {
    out.push({
      id: `silent:${track.trackId}`,
      severity: 'info',
      title: `${track.name} 가 들리지 않습니다`,
      measurement: '통합 라우드니스 측정 불가',
      reason: '무음이거나, 클립이 없거나, 라우팅이 끊겼습니다.',
      trackId: track.trackId,
      actions: [],
      manual: '클립 · 뮤트 · 출력 라우팅을 확인하세요.',
    });
    return out;
  }

  if (Number.isFinite(track.truePeakDbtp) && track.truePeakDbtp > 0) {
    out.push({
      id: `clip:${track.trackId}`,
      severity: 'critical',
      title: `${track.name} 가 클리핑합니다`,
      measurement: `${track.truePeakDbtp.toFixed(2)} dBTP`,
      reason: '트랙 단계에서 0 dBFS 를 넘으면 마스터에서 아무리 줄여도 왜곡은 이미 들어가 있습니다.',
      trackId: track.trackId,
      actions: [{
        kind: 'trackVolume', trackId: track.trackId,
        db: (findTrack(session, track.trackId)?.volumeDb ?? 0) - (track.truePeakDbtp + 1),
      }],
    });
  }

  if (track.correlation < -0.2) {
    out.push({
      id: `phase:${track.trackId}`,
      severity: 'warning',
      title: `${track.name} 의 좌우가 상쇄됩니다`,
      measurement: `상관도 ${track.correlation.toFixed(2)}`,
      reason: '모노 합산에서 이 트랙이 거의 사라집니다.',
      trackId: track.trackId,
      actions: [],
      manual: '와이드너를 줄이거나 한쪽 채널의 극성을 뒤집어 보세요.',
    });
  }

  // A bass part with nothing under 120 Hz is usually a routing or HPF mistake.
  if ((track.guess.role === 'bass' || track.guess.role === 'kick')
    && track.guess.confidence >= 0.7 && track.shape.lowShare < 0.25) {
    out.push({
      id: `thin:${track.trackId}`,
      severity: 'warning',
      title: `${track.name} 에 저역이 없습니다`,
      measurement: `120 Hz 이하 에너지 ${(track.shape.lowShare * 100).toFixed(0)}%`,
      reason: `${label} 로 보이는데 저역이 비어 있습니다 — 하이패스가 너무 높거나 소스가 다릅니다.`,
      trackId: track.trackId,
      actions: [{
        kind: 'insertParam', trackId: track.trackId, pluginId: 'eq3', paramId: 'hpfHz', value: 20,
      }],
    });
  }

  // Sibilance: a vocal with a lot of 5–9 kHz relative to its own body.
  if ((track.guess.role === 'vocal' || track.guess.role === 'backing') && track.guess.confidence >= 0.7) {
    const body = bandLevelDb(track.spectrum, 200, 2000);
    const sss = bandLevelDb(track.spectrum, 5000, 9000);
    if (sss > body - 6) {
      out.push({
        id: `sibilance:${track.trackId}`,
        severity: 'warning',
        title: `${track.name} 의 치찰음이 셉니다`,
        measurement: `5–9 kHz ${sss.toFixed(1)} dB · 바디 ${body.toFixed(1)} dB`,
        reason: '치찰음이 바디에서 6 dB 안쪽까지 올라오면 리미터를 지나며 더 튑니다.',
        trackId: track.trackId,
        actions: [
          { kind: 'addInsert', trackId: track.trackId, pluginId: 'deesser' },
          { kind: 'insertParam', trackId: track.trackId, pluginId: 'deesser', paramId: 'amount', value: 0.5 },
        ],
      });
    }
  }

  // A track sitting far below where its role usually sits.
  const loudest = analysis.tracks.reduce(
    (max, t) => (t.silent ? max : Math.max(max, t.integratedLufs)), -Infinity);
  if (Number.isFinite(loudest)) {
    const expected = loudest + ROLE_PROFILES[track.guess.role].offsetLu;
    const delta = track.integratedLufs - expected;
    if (track.guess.confidence >= 0.7 && delta < -9) {
      out.push({
        id: `buried:${track.trackId}`,
        severity: 'info',
        title: `${track.name} 가 묻혀 있습니다`,
        measurement: `${track.integratedLufs.toFixed(1)} LUFS · ${label} 기준 ${expected.toFixed(1)}`,
        reason: `${label} 치고 ${Math.abs(delta).toFixed(1)} LU 낮습니다. 의도한 것이 아니라면 페이더를 확인하세요.`,
        trackId: track.trackId,
        actions: [{
          kind: 'trackVolume', trackId: track.trackId,
          db: (findTrack(session, track.trackId)?.volumeDb ?? 0) - delta * 0.6,
        }],
      });
    }
  }

  return out;
}

export function summarise(findings: readonly Finding[]): string {
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  if (findings.length === 0) return '문제를 찾지 못했습니다';
  return `심각 ${critical} · 주의 ${warning} · 참고 ${findings.length - critical - warning}`;
}

/** Findings that ship a fix, ready to apply in one press. */
export function fixable(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.actions.length > 0);
}
