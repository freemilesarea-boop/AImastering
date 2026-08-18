/**
 * StemsPage — the stem session mixer.
 *
 * Load a mix as its parts, let each part be the instrument it is, and sum
 * them back down. Not a DAW: there is no timeline and no clip editing,
 * because stems are already aligned at zero and everything a timeline adds
 * is complexity this does not need.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 스템 추가 · 분석 · 비우기                     합산 · 내보내기   │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ ▸ Kick In.wav        [킥 ▾]   ──●──  L│R   M S   ⨯         │
 *   │   이름과 측정이 일치합니다 — 킥, 중심 52 Hz, 크레스트 16.0 dB   │
 *   │ ▸ Lead Vox.wav       [보컬 ▾]  ──●──  L│R   M S   ⨯         │
 *   │   ⚠ 이름은 보컬인데 측정은 킥에 가깝습니다                      │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 합산 피크 · 정렬 · 결과                                        │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * The page owns no DSP and no audio graph. It edits `stemStore` and calls
 * `stem:render`, which does the whole job in the main process.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import {
  useStemStore, audibleFlags, pendingCount, needsAttention,
  type StemTrackState,
} from '../stores/stemStore.js';
import { STEM_ROLES, type StemRole } from '../audio/presets/stem-defaults.js';
import { stemWireFor } from '../audio/presets/stem-chain-config.js';
import { masterBusChoices, masterWireFor } from '../audio/presets/stem-master.js';

const ROLE_LABEL: Record<StemRole, string> = {
  kick: '킥', snare: '스네어', drums: '드럼/퍼커션', bass: '베이스',
  vocal: '리드 보컬', 'vocal-back': '백 보컬', guitar: '기타',
  keys: '건반/신스', fx: '효과음', mid: '중역 악기', other: '미분류',
};

/**
 * A neutral flat config, which the per-stem wire rides on.
 *
 * The stem's real settings all travel in `suiteConfig`; these flat fields
 * are the legacy path and are left bypassed so they cannot double up on it.
 */
function baseConfig(): Record<string, unknown> {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0,
    eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120,
    dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  };
}

function statusDot(t: StemTrackState): { cls: string; title: string } {
  if (t.status === 'error') return { cls: 'bg-red-500', title: t.error ?? '분석 실패' };
  if (t.status === 'analyzing') return { cls: 'bg-amber-400 animate-pulse', title: '분석 중' };
  if (t.status === 'pending') return { cls: 'bg-zinc-600', title: '분석 대기' };
  if (t.warning) return { cls: 'bg-amber-400', title: t.warning };
  return { cls: 'bg-emerald-500', title: t.why };
}

// ── One channel strip ────────────────────────────────────────────────────────

function StemRow({ track, audible }: { track: StemTrackState; audible: boolean }): React.ReactElement {
  const { setRole, setGain, setPan, toggleMute, toggleSolo, remove } = useStemStore();
  const dot = statusDot(track);

  return (
    <div className={`px-4 py-3 border-b border-zinc-800/60 last:border-0 ${audible ? '' : 'opacity-40'}`}>
      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot.cls}`} title={dot.title} />

        <span className="text-sm text-zinc-200 truncate flex-1 min-w-0" title={track.filePath}>
          {track.name}
        </span>

        <select
          value={track.role}
          onChange={(e) => setRole(track.id, e.target.value as StemRole)}
          className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-300
                     focus:outline-none focus:border-zinc-500 shrink-0"
          title={track.roleLocked ? '직접 지정한 악기 — 재분석해도 바뀌지 않습니다' : track.why}
        >
          {STEM_ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>

        {/* Fader */}
        <div className="flex items-center gap-2 shrink-0 w-40">
          <input
            type="range" min={-30} max={12} step={0.5}
            value={track.gainDb}
            onChange={(e) => setGain(track.id, Number(e.target.value))}
            className="flex-1 accent-zinc-400"
            aria-label={`${track.name} 페이더`}
          />
          <span className="font-mono text-[11px] text-zinc-500 w-12 text-right tabular-nums">
            {track.gainDb > 0 ? '+' : ''}{track.gainDb.toFixed(1)}
          </span>
        </div>

        {/* Balance */}
        <div className="flex items-center gap-2 shrink-0 w-28">
          <input
            type="range" min={-1} max={1} step={0.05}
            value={track.pan}
            onChange={(e) => setPan(track.id, Number(e.target.value))}
            className="flex-1 accent-zinc-500"
            aria-label={`${track.name} 밸런스`}
          />
          <span className="font-mono text-[11px] text-zinc-600 w-8 text-right tabular-nums">
            {track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`}
          </span>
        </div>

        <button
          onClick={() => toggleMute(track.id)}
          className={`w-7 h-6 text-[11px] rounded border shrink-0 transition-colors ${
            track.mute
              ? 'bg-red-500/20 border-red-500/50 text-red-300'
              : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'
          }`}
          title="뮤트"
        >M</button>

        <button
          onClick={() => toggleSolo(track.id)}
          className={`w-7 h-6 text-[11px] rounded border shrink-0 transition-colors ${
            track.solo
              ? 'bg-amber-400/20 border-amber-400/50 text-amber-300'
              : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'
          }`}
          title="솔로"
        >S</button>

        <button
          onClick={() => remove(track.id)}
          className="w-6 h-6 text-zinc-600 hover:text-red-400 transition-colors shrink-0"
          title="세션에서 제거"
        >✕</button>
      </div>

      {/* One line of explanation, because a role the user cannot question is
          a role the user cannot correct. */}
      {track.warning ? (
        <p className="mt-1.5 ml-5 text-[11px] text-amber-400/90 leading-snug">⚠ {track.warning}</p>
      ) : track.status === 'error' ? (
        <p className="mt-1.5 ml-5 text-[11px] text-red-400/90 leading-snug">{track.error}</p>
      ) : (
        <p className="mt-1.5 ml-5 text-[11px] text-zinc-600 leading-snug">{track.why}</p>
      )}
    </div>
  );
}

// ── Master bus ───────────────────────────────────────────────────────────────

function MasterBus(): React.ReactElement {
  const { masterPresetId, masterTargetLufs, setMasterPreset, setMasterTargetLufs } = useStemStore();
  const choices = useMemo(() => masterBusChoices(), []);
  const active = choices.find((c) => c.id === masterPresetId) ?? null;
  const effectiveLufs = masterTargetLufs ?? active?.targetLufs ?? null;

  return (
    <div className="shrink-0 border-t border-zinc-800/60 px-4 py-3 bg-zinc-950/40">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] uppercase tracking-widest text-zinc-600 shrink-0">마스터 버스</span>

        <select
          value={masterPresetId ?? ''}
          onChange={(e) => setMasterPreset(e.target.value === '' ? null : e.target.value)}
          className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-300
                     focus:outline-none focus:border-zinc-500"
          title={active?.description ?? '마스터 버스 없이 합산만 합니다'}
        >
          <option value="">없음 (합산만)</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName}</option>
          ))}
        </select>

        {active && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-600">목표 라우드니스</span>
              <input
                type="range" min={-20} max={-6} step={0.5}
                value={effectiveLufs ?? -14}
                onChange={(e) => setMasterTargetLufs(Number(e.target.value))}
                className="w-32 accent-zinc-400"
                aria-label="목표 라우드니스"
              />
              <span className="font-mono text-[11px] text-zinc-400 w-16 tabular-nums">
                {(effectiveLufs ?? -14).toFixed(1)} LUFS
              </span>
              {masterTargetLufs !== null && masterTargetLufs !== active.targetLufs && (
                <button
                  onClick={() => setMasterTargetLufs(null)}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                  title={`프리셋 기본값 ${active.targetLufs} LUFS 로 되돌립니다`}
                >
                  기본값
                </button>
              )}
            </div>

            <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
              실링 {active.ceilingDbtp.toFixed(1)} dBTP
            </span>
          </>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-zinc-600 leading-snug">
        {active
          ? active.description
          : '마스터 버스를 끄면 스템 체인과 페이더만 적용된 합산본이 나옵니다 — 다른 곳에서 마스터링할 파일을 만들 때 쓰세요.'}
      </p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StemsPage(): React.ReactElement {
  const setPage = useAppStore((s) => s.setPage);
  const {
    tracks, rendering, lastReport, lastOutputPath, renderError,
    masterPresetId, masterTargetLufs,
    addFiles, clear, analyzePending, setRendering, setRenderResult,
  } = useStemStore();

  const audible = useMemo(() => audibleFlags(tracks), [tracks]);
  const pending = pendingCount(tracks);
  const attention = needsAttention(tracks);

  // Analyse whatever has just been added. Runs on mount too, so a session
  // restored from a previous run is re-measured rather than shown with a
  // stale verdict.
  useEffect(() => {
    if (pending > 0 && !rendering) void analyzePending();
  }, [pending, rendering, analyzePending]);

  const handleAdd = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const paths = await api.invoke('file:open-dialog-multi') as string[] | null;
    if (paths && paths.length > 0) addFiles(paths);
  }, [addFiles]);

  const handleRender = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || tracks.length === 0) return;
    setRendering(true);
    try {
      // The master bus is one of the app's own mastering presets, applied
      // to the sum. Its loudness target rides alongside rather than inside
      // the chain — the renderer normalises in two passes, which lands on
      // the target instead of near it.
      const master = masterPresetId
        ? masterWireFor(masterPresetId, masterTargetLufs ?? undefined)
        : null;

      const res = await api.invoke('stem:render', {
        tracks: tracks.map((t) => ({
          filePath: t.filePath,
          gainDb: t.gainDb,
          pan: t.pan,
          mute: t.mute,
          solo: t.solo,
          config: { ...baseConfig(), suiteConfig: stemWireFor(t.role) },
        })),
        master: master
          ? { ...baseConfig(), limCeilingDbtp: master.ceilingDbtp, suiteConfig: master.wire }
          : null,
        ...(master ? { masterTarget: { targetLufs: master.targetLufs } } : {}),
        sampleRate: 48000,
        bitDepth: 24,
      }) as {
        ok: boolean; error?: string; outputPath?: string;
        report?: import('../stores/stemStore.js').StemRenderReport;
      };
      if (res.ok && res.outputPath) setRenderResult(res.outputPath, res.report ?? null, null);
      else setRenderResult(null, null, res.error ?? '합산에 실패했습니다.');
    } catch (err) {
      setRenderResult(null, null, (err as Error).message);
    }
  }, [tracks, masterPresetId, masterTargetLufs, setRendering, setRenderResult]);

  const handleSave = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || !lastOutputPath) return;
    await api.invoke('file:save-wav', lastOutputPath);
  }, [lastOutputPath]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="스템 세션"
        actions={
          <button
            onClick={() => setPage('home')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            홈
          </button>
        }
      />

      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/60">
        <button
          onClick={() => void handleAdd()}
          className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300
                     hover:border-zinc-500 transition-colors"
        >
          스템 추가
        </button>
        <button
          onClick={() => void analyzePending()}
          disabled={pending === 0}
          className="text-xs px-3 py-1.5 rounded border border-zinc-800 text-zinc-500
                     hover:text-zinc-300 disabled:opacity-40 transition-colors"
        >
          {pending > 0 ? `분석 중 ${pending}개` : '분석 완료'}
        </button>
        <button
          onClick={clear}
          disabled={tracks.length === 0}
          className="text-xs px-3 py-1.5 rounded border border-zinc-800 text-zinc-600
                     hover:text-red-400 disabled:opacity-40 transition-colors"
        >
          비우기
        </button>

        <div className="flex-1" />

        <span className="text-[11px] text-zinc-600 tabular-nums">
          {tracks.length}개 스템 · {audible.filter(Boolean).length}개 들림
        </span>
        <button
          onClick={() => void handleRender()}
          disabled={rendering || tracks.length === 0 || pending > 0}
          className="text-xs px-3 py-1.5 rounded bg-zinc-100 text-zinc-900 font-medium
                     hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {rendering ? '합산 중…' : '합산'}
        </button>
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm text-zinc-500">스템을 불러오세요</p>
            <p className="text-xs text-zinc-600 max-w-md leading-relaxed">
              DAW에서 내보낸 파트별 파일(킥, 베이스, 보컬…)을 넣으면 파일 이름과 실제 측정으로
              악기를 판별하고, 악기마다 다른 체인을 걸어 하나로 합칩니다.
              타임라인 편집은 없습니다 — 스템은 이미 0에 정렬돼 있습니다.
            </p>
          </div>
        ) : (
          tracks.map((t, i) => <StemRow key={t.id} track={t} audible={audible[i] ?? true} />)
        )}
      </div>

      <MasterBus />

      {/* Report */}
      {(lastReport || renderError || attention.length > 0) && (
        <div className="shrink-0 border-t border-zinc-800/60 px-4 py-2.5 space-y-1.5">
          {attention.length > 0 && (
            <p className="text-[11px] text-amber-400/80">
              확인이 필요한 스템 {attention.length}개 — 악기가 맞는지 보세요.
            </p>
          )}
          {renderError && (
            <p className="text-[11px] text-red-400">{renderError}</p>
          )}
          {lastReport && (
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-[11px] text-zinc-500 tabular-nums">
                {lastReport.rendered}개 합산 · {lastReport.durationSec.toFixed(1)}초 ·
                {' '}{(lastReport.renderMs / 1000).toFixed(1)}초 소요
              </span>
              <span
                className={`text-[11px] tabular-nums ${lastReport.sumPeakDb > 0 ? 'text-amber-400' : 'text-zinc-500'}`}
                title="합산 직후의 피크. 0 dBFS를 넘으면 페이더를 내리는 편이 낫습니다."
              >
                합산 피크 {lastReport.sumPeakDb.toFixed(1)} dBFS
              </span>
              <span
                className="text-[11px] text-zinc-600 tabular-nums"
                title="스템마다 체인 지연이 달라 생기는 어긋남을 보정한 양입니다."
              >
                지연 보정 {lastReport.alignmentSamples} 샘플
              </span>
              {lastReport.loudnessNote !== 'not-requested' && (
                <span
                  className={`text-[11px] tabular-nums ${
                    lastReport.loudnessNote === 'ok' ? 'text-zinc-400' : 'text-amber-400'}`}
                  title={
                    lastReport.loudnessNote === 'ceiling-limited'
                      ? '리미터가 실링을 지키느라 더 이상 커지지 않습니다 — 이 소재로는 이 목표에 도달할 수 없습니다. 목표를 낮추거나, 곡의 밀도를 올리세요(스템 컴프레서).'
                      : lastReport.loudnessNote === 'clamped-boost'
                      ? '목표까지 올리려면 허용치보다 큰 게인이 필요해 목표에 도달하지 못했습니다. 스템 페이더를 올리세요.'
                      : lastReport.loudnessNote === 'clamped-cut'
                      ? '목표까지 내리려면 허용치보다 큰 감쇠가 필요해 목표에 도달하지 못했습니다. 스템 페이더를 내리세요.'
                      : `파일 전체를 측정해 맞춘 값입니다 (${lastReport.loudnessPasses}회 보정).`
                  }
                >
                  {lastReport.masterLufs.toFixed(1)} LUFS
                  {lastReport.loudnessNote !== 'ok' && ' · 목표 미달'}
                </span>
              )}
              <span className="text-[11px] text-zinc-600 tabular-nums" title="트루 피크">
                {lastReport.masterTruePeakDb.toFixed(1)} dBTP
              </span>
              {!lastReport.latencyAvailable && (
                <span className="text-[11px] text-amber-400">
                  이 빌드는 체인 지연을 알려주지 못해 정렬하지 못했습니다
                </span>
              )}
              {lastOutputPath && (
                <button
                  onClick={() => void handleSave()}
                  className="text-[11px] px-2.5 py-1 rounded border border-zinc-700 text-zinc-300
                             hover:border-zinc-500 transition-colors"
                >
                  WAV 저장
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
