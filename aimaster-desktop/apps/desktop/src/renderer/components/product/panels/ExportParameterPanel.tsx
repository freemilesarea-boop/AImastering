// ExportParameterPanel — result-first export UX.
//
// Users pick a PURPOSE (Streaming / YouTube / High Quality / MP3 share /
// Expert) and export with one button.  The technical knobs (format / sample
// rate / bit depth / dither / normalize target) live under "전문가 설정".
// Developer-only status (applied keys, staged-only, render mapping, echo
// from limiter) is shown ONLY in dev mode.
//
// The export PIPELINE is unchanged — presets just set the same export
// parameters + (optionally) the limiter loudness target, and the buttons
// still call onReMasterExport / onExportAsIs.

import React from 'react';
import {
  LouiSectionCard,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, meter, space, radius } from '../../../theme/loui-theme.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../../audio/parameters/index.js';
import { usePanelStateBridge, type ControlledPanelProps } from './usePanelStateBridge.js';
import { ExportSupportSummary } from '../modules/ExportSupportBadge.js';
import { isDevMode } from '../../../audio/dev-mode.js';

type ExportFormat = 'wav' | 'flac' | 'mp3' | 'aiff' | 'ogg';
type SampleRateStr = '44100' | '48000' | '88200' | '96000' | '192000';
type BitDepthStr   = '16' | '24' | '32';
type DitherMode    = 'none' | 'tpdf' | 'shaped';

interface ExportState {
  format:     ExportFormat;
  sampleRate: SampleRateStr;
  bitDepth:   BitDepthStr;
  dither:     DitherMode;
}

const findExp = (id: string) =>
  ALL_MODULE_PARAMETER_DEFS.export.parameters.find((p) => p.id === id)!.default;
const DEFAULTS: ExportState = {
  format:     findExp('format')     as ExportFormat,
  sampleRate: findExp('sampleRate') as SampleRateStr,
  bitDepth:   findExp('bitDepth')   as BitDepthStr,
  dither:     findExp('dither')     as DitherMode,
};

// ── Export-purpose presets (result-first) ────────────────────────────────
type PresetId = 'streaming' | 'youtube' | 'hq' | 'mp3' | 'expert';
interface ExportPreset {
  id: PresetId;
  label: string;
  sub: string;
  format?: ExportFormat;
  sampleRate?: SampleRateStr;
  bitDepth?: BitDepthStr;
  dither?: DitherMode;
  lufs?: number;
  tp?: number;
  /** 권장 용도. */
  use: string;
}

const PRESETS: ExportPreset[] = [
  { id: 'streaming', label: '스트리밍 추천', sub: 'Spotify·애플뮤직', format: 'wav', sampleRate: '44100', bitDepth: '24', dither: 'none', lufs: -14, tp: -1, use: '스트리밍/일반 업로드에 가장 안전한 기본값입니다.' },
  { id: 'youtube',   label: 'YouTube 추천',  sub: '유튜브·영상',     format: 'wav', sampleRate: '48000', bitDepth: '24', dither: 'none', lufs: -14, tp: -1, use: '영상/유튜브 업로드용 48kHz 설정입니다.' },
  { id: 'hq',        label: '고음질',        sub: '마스터 보관',     format: 'flac', sampleRate: '96000', bitDepth: '24', dither: 'none', lufs: -14, tp: -1, use: '고음질 보관·배포용 (FLAC · 96kHz).' },
  { id: 'mp3',       label: 'MP3 공유용',    sub: '간편 공유',       format: 'mp3', sampleRate: '44100', bitDepth: '24', dither: 'none', lufs: -14, tp: -1, use: '카톡·메일 등 간편 공유용 MP3입니다.' },
  { id: 'expert',    label: '전문가 설정',   sub: '직접 조정',       use: '모든 출력 옵션을 직접 설정합니다.' },
];

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'wav',  label: 'WAV',  hint: 'PCM · 무압축' },
  { id: 'flac', label: 'FLAC', hint: '무손실 압축' },
  { id: 'mp3',  label: 'MP3',  hint: '손실 · 공유용' },
  { id: 'aiff', label: 'AIFF', hint: 'PCM · Apple' },
  { id: 'ogg',  label: 'OGG',  hint: 'Vorbis' },
];
const SAMPLE_RATES: { id: SampleRateStr; label: string; hint?: string }[] = [
  { id: '44100',  label: '44.1 kHz' },
  { id: '48000',  label: '48 kHz', hint: '기본' },
  { id: '88200',  label: '88.2 kHz', hint: '고해상' },
  { id: '96000',  label: '96 kHz', hint: '고해상' },
  { id: '192000', label: '192 kHz', hint: '고해상' },
];
const BIT_DEPTHS: { id: BitDepthStr; label: string; hint: string }[] = [
  { id: '16', label: '16-bit', hint: 'CD · 스트리밍' },
  { id: '24', label: '24-bit', hint: '기본' },
  { id: '32', label: '32-bit Float', hint: '플로트 (무클리핑)' },
];
const DITHER_MODES: { id: DitherMode; label: string; hint: string }[] = [
  { id: 'none',   label: '없음',   hint: '노이즈 추가 안 함' },
  { id: 'tpdf',   label: 'TPDF',   hint: '표준 디더' },
  { id: 'shaped', label: 'Shaped', hint: '노이즈 셰이핑 (권장)' },
];

const formatExportLabel = (f: ExportFormat): string => `${f.toUpperCase()}로 내보내기`;

function ChipRow<T extends string>({ options, active, onChange, ariaLabel }: {
  options: { id: T; label: string; hint?: string }[];
  active: T; onChange: (v: T) => void; ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'flex', flexWrap: 'wrap', gap: space['2'] }}>
      {options.map((o) => {
        const sel = o.id === active;
        return (
          <button key={String(o.id)} type="button" role="radio" aria-checked={sel} onClick={() => onChange(o.id)}
            style={{
              display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 84,
              paddingInline: space['3'], paddingBlock: space['2'],
              background: sel ? 'rgba(167,139,250,0.10)' : surface.well,
              border: `1px solid ${sel ? meter.accent.foreground : surface.border}`,
              borderRadius: radius.chip, cursor: 'pointer', textAlign: 'left',
              transition: 'background 120ms ease-out, border-color 120ms ease-out',
            }}>
            <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.sm, fontWeight: typography.weight.semi, color: sel ? text.primary : text.secondary }}>{o.label}</span>
            {o.hint && <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type ExportActionPhase = 'idle' | 'exporting' | 'done' | 'error';

export interface ExportAsIsInfo {
  available: boolean;
  phase: ExportActionPhase;
  error?: string | null;
  lastExportPath?: string | null;
  onExportAsIs: () => void;
}

export interface ReMasterExportInfo {
  appliedKeys: string[];
  skippedParameterIds: string[];
  hasUnpreviewedChanges: boolean;
  phase: ExportActionPhase;
  error?: string | null;
  lastExportPath?: string | null;
  onReMasterExport: () => void;
  asIs: ExportAsIsInfo;
  quality?: {
    label: string;
    willApply: boolean;
    format?: string;
    transcodeRequired?: boolean;
    ditherIgnored?: boolean;
  };
}

export interface ExportParameterPanelProps extends ControlledPanelProps {
  targetLufs?: number;
  targetTp?:   number;
  showExportButton?: boolean;
  onExport?:   () => void;
  reMasterExport?: ReMasterExportInfo;
  /** Apply a loudness target to the limiter (used by export purpose presets). */
  onApplyLoudness?: (lufs: number, tp: number) => void;
}

function detectPreset(s: ExportState): PresetId {
  for (const p of PRESETS) {
    if (p.id === 'expert') continue;
    if (p.format === s.format && p.sampleRate === s.sampleRate && p.bitDepth === s.bitDepth) return p.id;
  }
  return 'expert';
}

export function ExportParameterPanel(props: ExportParameterPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<ExportState>(DEFAULTS, props);
  const tLufs = props.targetLufs ?? -14;
  const tTp   = props.targetTp ?? -1;
  const dev = isDevMode();

  const detected = detectPreset(s);
  const [expanded, setExpanded] = React.useState(detected === 'expert');
  const selected = detected;

  const applyPreset = (p: ExportPreset) => {
    if (p.id === 'expert') { setExpanded(true); return; }
    if (p.format) setParam('format', p.format);
    if (p.sampleRate) setParam('sampleRate', p.sampleRate);
    if (p.bitDepth) setParam('bitDepth', p.bitDepth);
    if (p.dither) setParam('dither', p.dither);
    if (typeof p.lufs === 'number' && typeof p.tp === 'number') props.onApplyLoudness?.(p.lufs, p.tp);
    setExpanded(false);
  };

  const current = PRESETS.find((p) => p.id === selected) ?? PRESETS[0]!;
  const qualityText = s.format === 'mp3'
    ? `${s.format.toUpperCase()} · ${(Number(s.sampleRate) / 1000)} kHz`
    : `${s.format.toUpperCase()} · ${(Number(s.sampleRate) / 1000)} kHz · ${s.bitDepth}-bit`;

  return (
    <>
      {/* 1) Export 목적 선택 */}
      <LouiSectionCard title="내보내기 목적">
        <div role="radiogroup" aria-label="내보내기 목적" style={{ display: 'flex', flexWrap: 'wrap', gap: space['2'] }}>
          {PRESETS.map((p) => {
            const sel = p.id === selected;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={sel} onClick={() => applyPreset(p)}
                style={{
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 96,
                  paddingInline: space['3'], paddingBlock: space['2'],
                  background: sel ? 'rgba(167,139,250,0.12)' : surface.well,
                  border: `1px solid ${sel ? meter.accent.foreground : surface.border}`,
                  borderRadius: radius.chip, cursor: 'pointer', textAlign: 'left',
                }}>
                <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.sm, fontWeight: typography.weight.semi, color: sel ? text.primary : text.secondary }}>{p.label}</span>
                <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>{p.sub}</span>
              </button>
            );
          })}
        </div>
      </LouiSectionCard>

      {/* 7) 출력 설정 요약 카드 */}
      <LouiSectionCard title="출력 설정 요약">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['2'] }}>
          <LouiValueBadge label="포맷" status="accent">{s.format.toUpperCase()}</LouiValueBadge>
          <LouiValueBadge label="품질">{qualityText.replace(/^[A-Z0-9]+ · /, '')}</LouiValueBadge>
          <LouiValueBadge label="목표 음량">{tLufs.toFixed(1)} LUFS</LouiValueBadge>
          <LouiValueBadge label="트루 피크">{tTp.toFixed(1)} dBTP</LouiValueBadge>
        </div>
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.sm, color: text.secondary, lineHeight: 1.5 }}>
          {current.use}
        </span>
        <span title="LUFS: 스트리밍 음량 기준 · dBTP: 클리핑 방지 피크 기준 · Dither: 비트 변환 시 노이즈 처리"
          style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted, cursor: 'help', lineHeight: 1.4 }}>
          ⓘ 용어 설명 (LUFS · dBTP · Dither)
        </span>
      </LouiSectionCard>

      {/* 5) 메인 내보내기 */}
      {props.reMasterExport ? (
        <UserExportSection info={props.reMasterExport} formatLabel={formatExportLabel(s.format)} />
      ) : props.showExportButton ? (
        <button type="button" onClick={props.onExport}
          style={{ height: 36, paddingInline: space['4'], background: meter.accent.foreground, color: surface.background, border: 'none', borderRadius: radius.chip, fontFamily: typography.family.sans, fontSize: typography.size.sm, fontWeight: typography.weight.semi, cursor: 'pointer' }}>
          {formatExportLabel(s.format)}
        </button>
      ) : null}

      {/* 6) 전문가 설정 (접기) */}
      <LouiSectionCard
        title="전문가 설정"
        trailing={
          <button type="button" onClick={() => setExpanded((v) => !v)}
            style={{ background: 'transparent', border: `1px solid ${surface.border}`, borderRadius: radius.chip, color: text.secondary, fontFamily: typography.family.sans, fontSize: typography.size.xs, padding: '3px 8px', cursor: 'pointer' }}>
            {expanded ? '접기' : '펼치기'}
          </button>
        }
      >
        {!expanded ? (
          <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>
            포맷 · 샘플레이트 · 비트뎁스 · 디더 · 음량 목표를 직접 조정합니다.
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
            <Sub title="포맷"><ChipRow options={FORMATS} active={s.format} onChange={(v) => setParam('format', v)} ariaLabel="포맷" /></Sub>
            <Sub title="샘플레이트"><ChipRow options={SAMPLE_RATES} active={s.sampleRate} onChange={(v) => setParam('sampleRate', v)} ariaLabel="샘플레이트" /></Sub>
            <Sub title="비트뎁스"><ChipRow options={BIT_DEPTHS} active={s.bitDepth} onChange={(v) => setParam('bitDepth', v)} ariaLabel="비트뎁스" /></Sub>
            <Sub title="디더 (Dither)">
              <ChipRow options={DITHER_MODES} active={s.dither} onChange={(v) => setParam('dither', v)} ariaLabel="디더" />
              {s.bitDepth === '32' && s.dither !== 'none' && (
                <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.warn.foreground, lineHeight: 1.4 }}>
                  ⚠ 32-bit float에서는 디더가 효과 없습니다.
                </span>
              )}
            </Sub>
            <Sub title="음량 목표 (Normalize)">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space['2'] }}>
                <LouiValueBadge label="Target LUFS">{tLufs.toFixed(1)} LUFS</LouiValueBadge>
                <LouiValueBadge label="Ceiling">{tTp.toFixed(1)} dBTP</LouiValueBadge>
              </div>
              <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted, lineHeight: 1.4 }}>
                음량 목표는 Limiter 모듈에서 조정합니다.
              </span>
            </Sub>
          </div>
        )}
      </LouiSectionCard>

      {/* dev only — detailed render-mapping diagnostics */}
      {dev && props.reMasterExport && <ReMasterExportSection info={props.reMasterExport} />}
    </>
  );
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
      <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</span>
      {children}
    </div>
  );
}

// ── User-facing export section (result-first) ─────────────────────────────

function UserExportSection({ info, formatLabel }: { info: ReMasterExportInfo; formatLabel: string }) {
  const exporting = info.phase === 'exporting' || info.asIs.phase === 'exporting';
  const hasChanges = info.appliedKeys.length > 0;
  const hasMaster = info.asIs.available;
  const canExport = hasChanges || hasMaster;

  const primaryClick = hasChanges ? info.onReMasterExport : info.asIs.onExportAsIs;
  const primaryLabel = exporting ? '내보내는 중…' : formatLabel;

  return (
    <LouiSectionCard title="내보내기">
      {/* 4) 지금 들리는 소리 = Export 안내 */}
      <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.secondary, lineHeight: 1.5 }}>
        현재 AFTER로 듣고 있는 마스터 설정 기준으로 내보냅니다.
      </span>
      {hasChanges && (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.tertiary, lineHeight: 1.5 }}>
          변경사항이 내보내기에 반영됩니다(재마스터 후 저장).
        </span>
      )}
      {info.hasUnpreviewedChanges && hasChanges && (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.warn.foreground, lineHeight: 1.5 }}>
          변경사항을 정확히 반영하려면 먼저 미리듣기 업데이트를 권장합니다.
        </span>
      )}

      {/* Primary export button */}
      <button type="button" onClick={primaryClick} disabled={exporting || !canExport}
        style={{
          height: 38, paddingInline: space['4'],
          background: (exporting || !canExport) ? 'transparent' : meter.accent.foreground,
          color: (exporting || !canExport) ? text.disabled : surface.background,
          border: (exporting || !canExport) ? `1px solid ${surface.border}` : 'none',
          borderRadius: radius.chip, fontFamily: typography.family.sans, fontSize: typography.size.sm,
          fontWeight: typography.weight.semi, cursor: (exporting || !canExport) ? 'not-allowed' : 'pointer',
        }}>
        {!canExport ? '먼저 미리듣기를 생성해주세요' : primaryLabel}
      </button>

      {/* Secondary: save current master unchanged (only when changes + master exist) */}
      {hasChanges && hasMaster && (
        <button type="button" onClick={info.asIs.onExportAsIs} disabled={exporting}
          style={{
            height: 32, paddingInline: space['3'], background: surface.well, color: text.secondary,
            border: `1px solid ${surface.border}`, borderRadius: radius.chip,
            fontFamily: typography.family.sans, fontSize: typography.size.xs,
            cursor: exporting ? 'not-allowed' : 'pointer',
          }}>
          현재 마스터 그대로 저장 (빠름)
        </button>
      )}

      {/* Status (Korean) */}
      <ExportStatus phase={info.phase} error={info.error} path={info.lastExportPath} />
      <ExportStatus phase={info.asIs.phase} error={info.asIs.error} path={info.asIs.lastExportPath} />
    </LouiSectionCard>
  );
}

function ExportStatus({ phase, error, path }: { phase: ExportActionPhase; error?: string | null | undefined; path?: string | null | undefined }) {
  if (phase === 'done') {
    return <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.safe.foreground }}>✓ 내보내기 완료{path ? ` → ${path}` : ''}</span>;
  }
  if (phase === 'error') {
    return <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.danger.foreground }}>✗ 내보내기 실패{error ? ` · ${error}` : ''}. 다시 시도해주세요.</span>;
  }
  return null;
}

// ── Developer detail section (dev mode only) — render-mapping diagnostics ──

function StatusLine({ phase, error, path, verb }: {
  phase: ExportActionPhase; error?: string | null | undefined; path?: string | null | undefined; verb: string;
}) {
  if (phase === 'done') return <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.safe.foreground }}>✓ {verb}{path ? ` → ${path}` : ''}</span>;
  if (phase === 'error') return <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.danger.foreground }}>✗ {verb} failed{error ? ` · ${error}` : ''}</span>;
  return null;
}

function ReMasterExportSection({ info }: { info: ReMasterExportInfo }) {
  const appliedCount = info.appliedKeys.length;
  const skippedCount = info.skippedParameterIds.length;
  const EXACT_KEYS = ['targetLufs', 'targetTp', 'stereoWidth', 'outputGainDb'];
  const exactCount = info.appliedKeys.filter((k) => EXACT_KEYS.includes(k)).length;
  const exportOnlyCount = appliedCount - exactCount;
  return (
    <LouiSectionCard title="DEV · Export render mapping">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['2'] }}>
        <LouiValueBadge label="Apply" status={appliedCount > 0 ? 'accent' : 'neutral'}>{appliedCount} change{appliedCount === 1 ? '' : 's'}</LouiValueBadge>
        {info.quality && <LouiValueBadge label="Quality" status={info.quality.willApply ? 'accent' : 'neutral'}>{info.quality.label}</LouiValueBadge>}
        {skippedCount > 0 && <LouiValueBadge label="Skip" status="neutral">{skippedCount} staged-only</LouiValueBadge>}
      </div>
      {(appliedCount > 0 || skippedCount > 0) && <ExportSupportSummary exact={exactCount} exportOnly={exportOnlyCount} previewOnly={skippedCount} />}
      {appliedCount > 0 && <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.tertiary, lineHeight: 1.5 }}>Applies: {info.appliedKeys.join(', ')}</span>}
      <StatusLine phase={info.asIs.phase} error={info.asIs.error} path={info.asIs.lastExportPath} verb="Saved (as-is)" />
      <StatusLine phase={info.phase} error={info.error} path={info.lastExportPath} verb="Re-mastered & exported" />
    </LouiSectionCard>
  );
}
