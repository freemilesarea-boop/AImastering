// Storybook stories for the central parameter state model.
//
// Demonstrates:
//   • Default state (all 5 modules at factory defaults)
//   • Modified EQ (a few bands twisted)
//   • Bypassed Imager (bypass flag + visual dim)
//   • Loud Limiter (target LUFS pushed up)
//   • Export 24-bit WAV
//   • Live command log view
//   • Invalid value clamping (out-of-range numeric input)

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ModuleParameterStateProvider,
  useEngineCommandLog,
  useModuleParameters,
  describeCommand,
  ALL_MODULE_PARAMETER_DEFS,
  type ModuleId,
} from './index';
import { surface, text, typography, meter, space, radius } from '../../theme/loui-theme';
import {
  EqParameterPanel,
  DynamicsParameterPanel,
  ImagerParameterPanel,
  LimiterParameterPanel,
  ExportParameterPanel,
} from '../../components/product/panels/index';

interface HostArgs {
  /** Which module's panel to render. */
  module: ModuleId;
  /** Auto-apply a scripted preset to demonstrate non-default state. */
  preset: 'default' | 'modified-eq' | 'bypass-imager' | 'loud-limiter' | 'export-wav-24';
}

const SECTION_BG: React.CSSProperties = {
  background: surface.background,
  color: text.secondary,
  fontFamily: typography.family.sans,
  padding: space['4'],
  minHeight: 480,
};

// ── Inner — picks the panel + drives the preset ─────────────────────────

function HostInner({ module, preset }: HostArgs) {
  const api = useModuleParameters(module);

  // Apply the scripted preset on mount / when preset arg changes.
  React.useEffect(() => {
    if (preset === 'default') {
      api.reset('preset');
      return;
    }
    if (preset === 'modified-eq' && module === 'eq') {
      api.setParam('lowShelfDb', 3.4, 'preset');
      api.setParam('presenceDb', -2.0, 'preset');
      api.setParam('airDb',       4.0, 'preset');
      api.setParam('outputGainDb', -1.2, 'preset');
      api.setParam('adaptive',   false, 'preset');
    }
    if (preset === 'bypass-imager' && module === 'imager') {
      api.setBypass(true, 'preset');
      api.setParam('widthPct', 40, 'preset');
    }
    if (preset === 'loud-limiter' && module === 'limiter') {
      api.setParam('targetLufs',  -8.5, 'preset');
      api.setParam('ceilingDbtp', -0.3, 'preset');
      api.setParam('character',   'aggressive', 'preset');
    }
    if (preset === 'export-wav-24' && module === 'export') {
      api.setParam('format', 'wav', 'preset');
      api.setParam('sampleRate', '48000', 'preset');
      api.setParam('bitDepth', '24', 'preset');
      api.setParam('dither', 'tpdf', 'preset');
    }
    // The preset effect intentionally runs once per arg change — `api` is
    // omitted from deps to avoid a re-apply loop on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, module]);

  const stateRecord = api.state.parameters;

  const common = {
    state: stateRecord,
    bypass: api.bypass,
    isModified: api.isModified,
    onParamChange: api.setParam,
    onBypassChange: api.setBypass,
    onReset: api.reset,
  };

  let panel: React.ReactNode = null;
  switch (module) {
    case 'eq':       panel = <EqParameterPanel       {...common} />; break;
    case 'dynamics': panel = <DynamicsParameterPanel {...common} />; break;
    case 'imager':   panel = <ImagerParameterPanel   {...common} />; break;
    case 'limiter':  panel = <LimiterParameterPanel  {...common} />; break;
    case 'export':   panel = <ExportParameterPanel   {...common} targetLufs={-14} targetTp={-1} />; break;
  }

  return (
    <div style={SECTION_BG}>
      <PanelHeader moduleId={module} bypass={api.bypass} isModified={api.isModified}
                   onBypassToggle={() => api.setBypass(!api.bypass)}
                   onReset={() => api.reset()} />
      <div style={{ width: 480, marginInline: 'auto', display: 'flex', flexDirection: 'column', gap: space['3'] }}>
        {panel}
      </div>
      <CommandLogView />
    </div>
  );
}

function PanelHeader({
  moduleId, bypass, isModified, onBypassToggle, onReset,
}: { moduleId: ModuleId; bypass: boolean; isModified: boolean; onBypassToggle: () => void; onReset: () => void }) {
  return (
    <div style={{
      width: 480,
      marginInline: 'auto',
      marginBottom: space['3'],
      paddingBlock: space['2'],
      paddingInline: space['3'],
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.md,
          fontWeight: typography.weight.semi,
          color: text.primary,
        }}>
          {ALL_MODULE_PARAMETER_DEFS[moduleId].moduleId.toUpperCase()}
        </span>
        {isModified && (
          <span style={{
            paddingInline: 8,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: radius.chip,
            border: '1px solid rgba(167,139,250,0.45)',
            background: 'rgba(167,139,250,0.16)',
            color: meter.accent.foreground,
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            fontWeight: typography.weight.medium,
            textTransform: 'uppercase',
          }}>
            Modified
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: space['2'] }}>
        <button onClick={onBypassToggle}
                style={{
                  height: 22, paddingInline: 10,
                  borderRadius: radius.chip,
                  border: `1px solid ${bypass ? meter.warn.foreground : surface.border}`,
                  background: bypass ? meter.warn.background : 'transparent',
                  color: bypass ? meter.warn.foreground : text.tertiary,
                  fontFamily: typography.family.sans, fontSize: typography.size.xs,
                  cursor: 'pointer',
                }}>
          {bypass ? 'Bypassed' : 'On'}
        </button>
        <button onClick={onReset}
                style={{
                  height: 22, paddingInline: 8,
                  borderRadius: radius.chip,
                  border: `1px solid ${surface.border}`,
                  background: 'transparent',
                  color: text.tertiary,
                  fontFamily: typography.family.sans, fontSize: typography.size.xs,
                  cursor: 'pointer',
                }}>
          Reset
        </button>
      </div>
    </div>
  );
}

function CommandLogView() {
  const { log, clear } = useEngineCommandLog();
  // Show the most recent 24 entries.
  const recent = log.slice(-24).slice().reverse();
  return (
    <div style={{
      width: 480,
      marginInline: 'auto',
      marginTop: space['4'],
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        paddingInline: space['3'], paddingBlock: space['2'],
        background: surface.well,
        borderBottom: `1px solid ${surface.border}`,
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>
          Engine Command Log ({log.length})
        </span>
        <button onClick={clear}
                style={{
                  height: 20, paddingInline: 8,
                  borderRadius: radius.chip,
                  border: `1px solid ${surface.border}`,
                  background: 'transparent',
                  color: text.tertiary,
                  fontFamily: typography.family.sans, fontSize: typography.size.xs,
                  cursor: 'pointer',
                }}>
          Clear
        </button>
      </div>
      <div style={{
        maxHeight: 200,
        overflowY: 'auto',
        padding: space['2'],
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}>
        {recent.length === 0 && (
          <span style={{
            fontFamily: typography.family.mono,
            fontSize: typography.size.xs,
            color: text.muted,
          }}>
            (no commands yet — drag a slider or toggle bypass)
          </span>
        )}
        {recent.map((cmd, i) => (
          <span key={log.length - i} style={{
            fontFamily: typography.family.mono,
            fontSize: typography.size.xs,
            color: cmd.kind === 'SET_MODULE_PARAM' && cmd.validation.status !== 'ok'
              ? meter.warn.foreground
              : text.tertiary,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
          }}>
            {describeCommand(cmd)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Story host wrapping the provider ────────────────────────────────────

function StoryHost(args: HostArgs) {
  return (
    <ModuleParameterStateProvider>
      <HostInner {...args} />
    </ModuleParameterStateProvider>
  );
}

const meta: Meta<typeof StoryHost> = {
  title: 'Product / Parameter State',
  component: StoryHost,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Central parameter state — drives every panel via ' +
          '`useModuleParameters(moduleId)`.  Each panel change becomes a ' +
          'SET_MODULE_PARAM command appended to the rolling log.  ' +
          'Validation clamps out-of-range numeric input and rejects ' +
          'type-mismatched values.',
      },
    },
  },
  argTypes: {
    module: {
      control: { type: 'select' },
      options: ['eq', 'dynamics', 'imager', 'limiter', 'export'],
    },
    preset: {
      control: { type: 'select' },
      options: ['default', 'modified-eq', 'bypass-imager', 'loud-limiter', 'export-wav-24'],
    },
  },
  args: { module: 'eq', preset: 'default' },
};
export default meta;
type Story = StoryObj<typeof StoryHost>;

export const DefaultParameters: Story = { args: { module: 'eq',       preset: 'default' } };
export const ModifiedEq:        Story = { args: { module: 'eq',       preset: 'modified-eq' } };
export const BypassedImager:    Story = { args: { module: 'imager',   preset: 'bypass-imager' } };
export const LoudLimiter:       Story = { args: { module: 'limiter',  preset: 'loud-limiter' } };
export const Export24BitWav:    Story = { args: { module: 'export',   preset: 'export-wav-24' } };

// ── Command log view ────────────────────────────────────────────────────

function CommandLogStory() {
  return (
    <ModuleParameterStateProvider>
      <div style={SECTION_BG}>
        <CommandLogScript />
      </div>
    </ModuleParameterStateProvider>
  );
}

function CommandLogScript() {
  const eq = useModuleParameters('eq');
  const lim = useModuleParameters('limiter');
  const img = useModuleParameters('imager');
  // Script: a sequence of representative commands so the log view has
  // something to render the moment the story mounts.
  React.useEffect(() => {
    eq.setParam('lowShelfDb', 2.5, 'preset');
    eq.setParam('presenceDb', -1.4, 'user');
    lim.setParam('targetLufs', -10.5, 'reference');
    lim.setParam('character', 'aggressive', 'user');
    img.setBypass(true, 'user');
    img.setParam('widthPct', 30, 'user');
    eq.setParam('airDb', 12 /* deliberately out-of-range to demo clamping */, 'user');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
      <span style={{
        textAlign: 'center',
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        color: text.muted,
      }}>
        A scripted sequence of commands — observe the validation tag on
        the last entry (Air shelf at +12 dB → clamped to +6 dB).
      </span>
      <CommandLogView />
    </div>
  );
}

export const CommandLog: Story = {
  ...({ render: () => <CommandLogStory /> } as unknown as Story),
};

// ── Invalid value clamping demo ─────────────────────────────────────────

function ClampingStory() {
  return (
    <ModuleParameterStateProvider>
      <div style={SECTION_BG}>
        <ClampingScript />
      </div>
    </ModuleParameterStateProvider>
  );
}

function ClampingScript() {
  const eq = useModuleParameters('eq');
  const lim = useModuleParameters('limiter');
  React.useEffect(() => {
    // 1. Push values past their max → clamped
    eq.setParam('lowShelfDb',  20, 'user');   // clamped to +6
    eq.setParam('lowCutHz',     5, 'user');   // clamped to 20 Hz
    lim.setParam('targetLufs', -1, 'user');   // clamped to -6 LUFS
    // 2. Send non-finite numeric → rejected
    lim.setParam('ceilingDbtp', Number.NaN as unknown as number, 'user');
    // 3. Send wrong type to an enum → rejected
    lim.setParam('character', 42 as unknown as string, 'user');
    // 4. Send invalid enum value → rejected
    lim.setParam('character', 'nuclear' as unknown as string, 'user');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
      <span style={{
        textAlign: 'center',
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        color: text.muted,
        maxWidth: 480,
        marginInline: 'auto',
        lineHeight: 1.4,
      }}>
        Sending out-of-range or wrong-type values demonstrates the
        validation contract.  Clamped commands appear with the corrected
        value; rejected commands are logged but state stays at the prior
        value.  Watch the highlighted rows in the log below.
      </span>
      <CommandLogView />
    </div>
  );
}

export const InvalidValueClamping: Story = {
  ...({ render: () => <ClampingStory /> } as unknown as Story),
};
