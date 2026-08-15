/**
 * StudioPage — the full module rack.
 *
 * Layout is two columns and deliberately not a slide-over.  With five
 * modules an overlay was fine; with twenty, the thing you need on screen is
 * the CHAIN, permanently, so you can see what is engaged while you edit one
 * module.  So: chain on the left, the selected module's parameters on the
 * right, and nothing covering either.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ file · master bypass · reset                            │
 *   ├──────────────────┬──────────────────────────────────────┤
 *   │ Signal chain     │  Selected module                     │
 *   │  Restoration     │   ┌───────────────────────────────┐  │
 *   │   De-click    ▸  │   │ Parameters                    │  │
 *   │   De-noise    ▸  │   │  …                            │  │
 *   │  Tone            │   └───────────────────────────────┘  │
 *   │   …              │                                      │
 *   ├──────────────────┴──────────────────────────────────────┤
 *   │ engaged summary · latency                               │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The page owns no DSP.  It reads and writes the central parameter state;
 * `chain-config.ts` turns that state into the config both the preview and
 * the export render consume.
 */

import React, { useCallback, useMemo, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { LouiModuleRack, type ModuleReadout } from '../components/product/LouiModuleRack.js';
import { ModuleParameterPanel } from '../components/product/panels/ModuleParameterPanel.js';
import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../audio/parameters/index.js';
import { getModule } from '../audio/modules/loui-module-suite.js';
import {
  buildChainConfig, activeModuleIds, MASTER_NATIVE_BIT_DEPTH,
  DEFAULT_MONITOR, monitorAltersOutput, type MonitorSettings,
} from '../audio/chain-config.js';
import { LouiMonitorBar } from '../components/product/LouiMonitorBar.js';
import { surface, text, typography, space, radius, meter } from '../theme/loui-theme.js';

/** Modules whose engagement is decided by the shared spectral stage. */
const SPECTRAL_MODULE_IDS = new Set<ModuleId>(['match-eq', 'spectral-shaper', 'stabilizer']);

/**
 * Registry ids that share a parameter module.  The rack lists them as
 * separate rows (they are separate ideas to a user), but they edit the same
 * parameters, so selecting either opens the same panel.
 */
const REGISTRY_TO_PARAM: Record<string, ModuleId> = {
  maximizer: 'limiter',
  'harshness-control': 'spectral-shaper',
  'reference-match': 'match-eq',
  'ai-harshness-guard': 'dynamic-eq',
  // Dither is its own idea to a user but its parameters only mean anything
  // against the export's bit depth, so they live on the export module.
  dither: 'export',
};

function paramModuleFor(registryId: string): ModuleId | undefined {
  const direct = REGISTRY_TO_PARAM[registryId];
  if (direct) return direct;
  const mod = getModule(registryId);
  return mod?.paramModuleId;
}

export default function StudioPage() {
  const setPage = useAppStore((s) => s.setPage);
  const selectedFile = useAudioStore((s) => s.selectedFile);

  // Parameter state lives here for now: the provider in
  // `useModuleParameterState` is mounted by the product layout, which this
  // page does not sit inside.  Keeping it local means the Studio works
  // standalone; wiring it to the provider is a drop-in replacement because
  // the shape is identical.
  const [state, setState] = useState<AllModulesParameterState>(
    () => defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS),
  );
  const [selected, setSelected] = useState<string>('eq');
  const [masterBypass, setMasterBypass] = useState(false);
  // Monitoring is session state, not module state — it must never end up in
  // a preset or an export.  See `MonitorSettings`.
  const [monitor, setMonitor] = useState<MonitorSettings>(DEFAULT_MONITOR);

  const paramModule = paramModuleFor(selected);

  const setParam = useCallback((moduleId: ModuleId, parameterId: string, value: ParameterValue) => {
    setState((prev) => ({
      ...prev,
      [moduleId]: {
        ...prev[moduleId],
        parameters: { ...prev[moduleId].parameters, [parameterId]: value },
      },
    }));
  }, []);

  const setBypass = useCallback((moduleId: ModuleId, bypass: boolean) => {
    setState((prev) => ({ ...prev, [moduleId]: { ...prev[moduleId], bypass } }));
  }, []);

  const resetAll = useCallback(() => {
    setState(defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS));
    setMasterBypass(false);
    setMonitor(DEFAULT_MONITOR);
  }, []);

  const resetModule = useCallback((moduleId: ModuleId) => {
    setState((prev) => ({
      ...prev,
      [moduleId]: defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS)[moduleId],
    }));
  }, []);

  // The config the engine would receive right now.  Recomputed on every
  // edit — it is a pure function over state and cheap enough that
  // memoising on `state` is all the debouncing this view needs.
  const config = useMemo(
    () => buildChainConfig({ state, masterBypass, monitor }),
    [state, masterBypass, monitor],
  );

  /**
   * Which registry rows count as engaged.  `activeModuleIds` speaks in
   * parameter-module terms; the rack also shows alias rows, so map those
   * back onto whatever drives them.
   */
  const engagedIds = useMemo(() => {
    const active = new Set<string>(activeModuleIds(config));
    for (const [registryId, param] of Object.entries(REGISTRY_TO_PARAM)) {
      if (active.has(param)) active.add(registryId);
    }
    return [...active];
  }, [config]);

  const bypassById = useMemo(() => {
    const out: Partial<Record<ModuleId, boolean>> = {};
    for (const id of MODULE_IDS) out[id] = state[id].bypass;
    return out;
  }, [state]);

  /**
   * Readouts.  Without a running engine there is no metering to show, so
   * each row reports the setting that decides whether it is doing anything
   * — an honest "what is dialled in", never a fabricated meter.
   */
  const readouts = useMemo(() => {
    const out: Record<string, ModuleReadout> = {};
    const n = (id: ModuleId, p: string) => {
      const v = state[id].parameters[p];
      return typeof v === 'number' ? v : 0;
    };
    const put = (id: string, value: string, active: boolean) => { out[id] = { value, active }; };

    put('denoise', `${n('denoise', 'reductionDb').toFixed(0)} dB`, n('denoise', 'reductionDb') > 0);
    put('dehum', `${n('dehum', 'depthDb').toFixed(0)} dB`, n('dehum', 'depthDb') > 0);
    put('deess', `${n('deess', 'rangeDb').toFixed(0)} dB`, n('deess', 'rangeDb') > 0);
    put('low-end-focus', `${n('low-end-focus', 'contrastPct').toFixed(0)}%`, n('low-end-focus', 'contrastPct') > 0);
    put('tape', `${n('tape', 'mixPct').toFixed(0)}%`, n('tape', 'mixPct') > 0);
    put('vintage-comp', `${n('vintage-comp', 'ratio').toFixed(1)}:1`, n('vintage-comp', 'ratio') > 1);
    put('dynamics', `${n('dynamics', 'ratio').toFixed(1)}:1`, n('dynamics', 'ratio') > 1);
    put('limiter', `${n('limiter', 'ceilingDbtp').toFixed(1)} dBTP`, true);
    put('maximizer', `+${n('limiter', 'driveDb').toFixed(1)} dB`, n('limiter', 'driveDb') > 0);
    put('imager', `${n('imager', 'widthPct').toFixed(0)}%`, n('imager', 'widthPct') !== 100);

    // Dither reports the depth it targets.  At or above the master's native
    // depth there is no reduction to dither, and saying so is more useful
    // than showing a mode that is not running.
    const depthStr = state.export.parameters['bitDepth'];
    const depth = typeof depthStr === 'string' ? Number(depthStr) : MASTER_NATIVE_BIT_DEPTH;
    const ditherMode = String(state.export.parameters['dither'] ?? 'tpdf');
    const reduces = depth < MASTER_NATIVE_BIT_DEPTH;
    put(
      'dither',
      reduces ? `${depth}-bit · ${ditherMode}` : `${depth}-bit · 감축 없음`,
      reduces && !state.export.bypass,
    );

    for (const id of SPECTRAL_MODULE_IDS) {
      const amount = n(id, 'amountPct');
      put(id, `${amount.toFixed(0)}%`, engagedIds.includes(id));
    }
    put('reference-match', out['match-eq']?.value ?? '', engagedIds.includes('reference-match'));
    put('harshness-control', out['spectral-shaper']?.value ?? '', engagedIds.includes('harshness-control'));

    const exciterSum = [0, 1, 2, 3].reduce((a, i) => a + n('exciter', `band${i}Pct`), 0);
    put('exciter', `${(exciterSum / 4).toFixed(0)}%`, exciterSum > 0);

    const impactPeak = [0, 1, 2, 3]
      .map((i) => n('impact', `band${i}Pct`))
      .reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
    put('impact', impactPeak === 0 ? '0%' : `${impactPeak > 0 ? '+' : ''}${impactPeak.toFixed(0)}%`, impactPeak !== 0);

    return out;
  }, [state, engagedIds]);

  const handleSelect = useCallback((id: string) => setSelected(id), []);
  const handleToggleBypass = useCallback(
    (id: ModuleId, bypass: boolean) => setBypass(id, bypass),
    [setBypass],
  );

  const registryEntry = getModule(selected);
  const def = paramModule ? ALL_MODULE_PARAMETER_DEFS[paramModule] : undefined;

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: surface.background,
      overflow: 'hidden',
    }}>
      <TopBar />

      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space['3'],
        paddingInline: space['5'],
        paddingBlock: space['3'],
        borderBottom: `1px solid ${surface.border}`,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}>
            Studio
          </span>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.sm,
            color: text.secondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {selectedFile
              ? selectedFile.split('/').pop()?.split('\\').pop()
              : '음원을 선택하면 미리듣기에 반영됩니다'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
          <HeaderButton
            label={masterBypass ? 'Chain off' : 'Chain on'}
            active={!masterBypass}
            onClick={() => setMasterBypass((v) => !v)}
          />
          {monitorAltersOutput(monitor) && (
            <span style={{
              fontFamily: typography.family.sans,
              fontSize: typography.size.xs,
              color: meter.warn.foreground,
              whiteSpace: 'nowrap',
            }}>
              비교 모드
            </span>
          )}
          <HeaderButton label="Reset all" onClick={resetAll} />
          <HeaderButton label="Back" onClick={() => setPage('home')} />
        </div>
      </header>

      <div style={{ paddingInline: space['4'], paddingTop: space['3'] }}>
        <LouiMonitorBar
          value={monitor}
          onChange={setMonitor}
          appliesTo="render"
        />
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 320px) 1fr',
        gap: space['4'],
        padding: space['4'],
      }}>
        <LouiModuleRack
          selectedId={selected}
          engagedIds={engagedIds}
          bypassById={bypassById}
          readouts={readouts}
          onSelect={handleSelect}
          onToggleBypass={handleToggleBypass}
        />

        <div style={{ minHeight: 0, overflowY: 'auto', paddingRight: space['1'] }}>
          {def && paramModule && registryEntry ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: space['3'],
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.lg,
                    fontWeight: typography.weight.medium,
                    color: text.primary,
                  }}>
                    {registryEntry.displayName}
                  </span>
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.xs,
                    color: text.tertiary,
                    lineHeight: 1.5,
                    maxWidth: '60ch',
                  }}>
                    {registryEntry.description}
                  </span>
                </div>
                <HeaderButton label="Reset" onClick={() => resetModule(paramModule)} />
              </div>

              <ModuleParameterPanel
                moduleId={paramModule}
                def={def}
                values={state[paramModule].parameters}
                bypass={state[paramModule].bypass}
                onChange={(id, value) => setParam(paramModule, id, value)}
                {...(paramModule === 'denoise' || SPECTRAL_MODULE_IDS.has(paramModule)
                  ? { note: '이 모듈은 STFT 기반이라 켜면 지연이 추가됩니다 (2048 샘플 ≈ 43 ms @ 48 kHz). 실시간 모니터링 시 참고하세요.' }
                  : {})}
              />
            </div>
          ) : (
            <EmptyPanel />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────

function HeaderButton(props: { label: string; active?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        cursor: 'pointer',
        paddingInline: space['3'],
        paddingBlock: space['1'],
        borderRadius: radius.chip,
        border: `1px solid ${props.active ? 'rgba(167,139,250,0.5)' : surface.border}`,
        background: props.active
          ? 'rgba(167,139,250,0.16)'
          : hover ? surface.overlay : surface.well,
        color: props.active ? meter.accent.foreground : text.secondary,
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.medium,
        transition: 'background 120ms ease-out',
        whiteSpace: 'nowrap',
      }}
    >
      {props.label}
    </button>
  );
}

function EmptyPanel() {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `1px dashed ${surface.border}`,
      borderRadius: radius.panel,
    }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        color: text.muted,
      }}>
        이 모듈은 아직 조절할 파라미터가 없습니다
      </span>
    </div>
  );
}
