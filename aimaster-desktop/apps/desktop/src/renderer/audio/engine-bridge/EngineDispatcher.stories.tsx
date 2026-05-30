// Storybook stories for the engine dispatcher (M3-P-NEXT-5B).
//
// Demonstrates the provider → dispatcher → result-log flow:
//   • Supported parameter write  (wired → staged)
//   • Unsupported parameter       (pending/unavailable → unsupported)
//   • Clamped then dispatched     (out-of-range → clamp → staged corrected)
//   • Rejected, no dispatch       (NaN / wrong type → no dispatcher call)
//   • Engine failure warning      (mock failWhen → failed)
//   • Dry-run mode                (computes engine value, applies nothing)

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ModuleParameterStateProvider,
  useModuleParameters,
  useEngineDispatchLog,
  useEngineCommandLog,
  describeCommand,
  ALL_MODULE_PARAMETER_DEFS,
} from '../parameters/index';
import {
  MockEngineDispatcher,
  failModule,
  describeDispatchResult,
  type EngineDispatcher,
} from './index';
import { surface, text, typography, meter, space, radius } from '../../theme/loui-theme';

const PAGE: React.CSSProperties = {
  background: surface.background,
  color: text.secondary,
  fontFamily: typography.family.sans,
  padding: space['4'],
  minHeight: 520,
  display: 'flex',
  flexDirection: 'column',
  gap: space['3'],
};

// ── Dual log view: commands + dispatch results side by side ─────────────

function DualLog() {
  const { log } = useEngineCommandLog();
  const { dispatchLog, dispatcherName } = useEngineDispatchLog();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space['3'] }}>
      <LogPanel title={`Command Log (${log.length})`}>
        {log.slice(-16).reverse().map((cmd, i) => (
          <LogLine key={log.length - i}
                   colour={cmd.kind === 'SET_MODULE_PARAM' && cmd.validation.status !== 'ok'
                     ? meter.warn.foreground : text.tertiary}>
            {describeCommand(cmd)}
          </LogLine>
        ))}
      </LogPanel>
      <LogPanel title={`Dispatch Log · ${dispatcherName} (${dispatchLog.length})`}>
        {dispatchLog.slice(-16).reverse().map((r, i) => (
          <LogLine key={dispatchLog.length - i} colour={dispatchColour(r.status)}>
            {describeDispatchResult(r)}
          </LogLine>
        ))}
      </LogPanel>
    </div>
  );
}

function dispatchColour(status: string): string {
  switch (status) {
    case 'staged':  return meter.safe.foreground;
    case 'applied': return meter.safe.foreground;
    case 'unsupported': return text.muted;
    case 'dry-run': return meter.cool.foreground;
    case 'failed':  return meter.danger.foreground;
    default:        return text.tertiary;
  }
}

function LogPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
    }}>
      <div style={{
        paddingInline: space['3'], paddingBlock: space['2'],
        background: surface.well,
        borderBottom: `1px solid ${surface.border}`,
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
      }}>
        {title}
      </div>
      <div style={{
        maxHeight: 240, overflowY: 'auto', padding: space['2'],
        display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        {children}
      </div>
    </div>
  );
}

function LogLine({ colour, children }: { colour: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: typography.family.mono,
      fontSize: typography.size.xs,
      color: colour,
      whiteSpace: 'pre-wrap',
      lineHeight: 1.5,
    }}>
      {children}
    </span>
  );
}

function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      height: 30, paddingInline: space['3'],
      borderRadius: radius.chip,
      border: `1px solid ${surface.border}`,
      background: surface.well,
      color: text.secondary,
      fontFamily: typography.family.sans,
      fontSize: typography.size.sm,
      cursor: 'pointer',
    }}>
      {children}
    </button>
  );
}

// ── Scenario driver ──────────────────────────────────────────────────────

type Scenario =
  | 'supported'
  | 'unsupported'
  | 'clamped'
  | 'rejected'
  | 'failure'
  | 'dry-run';

function ScenarioButtons({ scenario }: { scenario: Scenario }) {
  const eq = useModuleParameters('eq');
  const dyn = useModuleParameters('dynamics');
  const lim = useModuleParameters('limiter');
  const img = useModuleParameters('imager');

  const fire = () => {
    switch (scenario) {
      case 'supported':
        // outputGainDb is wired → staged
        dyn.setParam('thresholdDb', -18);
        lim.setParam('ceilingDbtp', -1.5);
        img.setParam('widthPct', 130);   // 130% → engine 1.3
        lim.setParam('isp', false);      // → oversample 1
        break;
      case 'unsupported':
        // lowShelfDb is pending → unsupported
        eq.setParam('lowShelfDb', 2.5);
        lim.setParam('character', 'aggressive'); // pending
        eq.setBypass(true);              // bypass binding pending → unsupported
        break;
      case 'clamped':
        // out-of-range wired value → clamp → staged corrected
        lim.setParam('ceilingDbtp', 5);  // clamps to 0
        dyn.setParam('thresholdDb', -99); // clamps to -30
        break;
      case 'rejected':
        // NaN / wrong-type → rejected, dispatcher NOT called
        lim.setParam('ceilingDbtp', Number.NaN as unknown as number);
        lim.setParam('character', 'nuclear' as unknown as string);
        break;
      case 'failure':
        // mock dispatcher fails dynamics writes
        dyn.setParam('ratio', 4);
        break;
      case 'dry-run':
        dyn.setParam('attackMs', 25);
        lim.setParam('lookaheadMs', 5);
        break;
    }
  };

  return (
    <div style={{ display: 'flex', gap: space['2'], flexWrap: 'wrap' }}>
      <Button onClick={fire}>Fire "{scenario}" scenario</Button>
      <Button onClick={() => { eq.reset(); dyn.reset(); lim.reset(); img.reset(); }}>
        Reset all
      </Button>
    </div>
  );
}

function Host({ scenario, dryRun, failDynamics }: {
  scenario: Scenario;
  dryRun?: boolean;
  failDynamics?: boolean;
}) {
  const dispatcher: EngineDispatcher = React.useMemo(() => new MockEngineDispatcher(
    ALL_MODULE_PARAMETER_DEFS,
    {
      dryRun: dryRun ?? false,
      ...(failDynamics ? { failWhen: failModule('dynamics'), failNote: 'mock engine: dynamics stage offline' } : {}),
    },
  ), [dryRun, failDynamics]);

  return (
    <ModuleParameterStateProvider dispatcher={dispatcher}>
      <div style={PAGE}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          color: text.muted,
          lineHeight: 1.5,
        }}>
          Fire the scenario and watch both logs.  The command log shows
          validation (ok / clamped / rejected); the dispatch log shows the
          engine-side disposition (staged / unsupported / dry-run / failed).
          Rejected commands never reach the dispatcher.
        </span>
        <ScenarioButtons scenario={scenario} />
        <DualLog />
      </div>
    </ModuleParameterStateProvider>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Product / Engine Dispatcher',
  component: Host,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'M3-P-NEXT-5B engine dispatcher — the seam between UI parameter ' +
          'commands and a real DSP engine.  Only `wired` parameters are ' +
          'translated into EngineSchema patch fragments (status `staged`); ' +
          'pending / unavailable parameters report `unsupported`.  No live ' +
          'DSP write happens — the staged patch awaits the M3-P-NEXT-5C ' +
          'render consumer.',
      },
    },
  },
  argTypes: {
    scenario: {
      control: { type: 'select' },
      options: ['supported', 'unsupported', 'clamped', 'rejected', 'failure', 'dry-run'],
    },
    dryRun: { control: 'boolean' },
    failDynamics: { control: 'boolean' },
  },
  args: { scenario: 'supported', dryRun: false, failDynamics: false },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const SupportedParameterWrite: Story = { args: { scenario: 'supported' } };
export const UnsupportedParameter:    Story = { args: { scenario: 'unsupported' } };
export const ClampedThenDispatched:   Story = { args: { scenario: 'clamped' } };
export const RejectedNoDispatch:      Story = { args: { scenario: 'rejected' } };
export const EngineFailureWarning:    Story = { args: { scenario: 'failure', failDynamics: true } };
export const DryRunMode:              Story = { args: { scenario: 'dry-run', dryRun: true } };
