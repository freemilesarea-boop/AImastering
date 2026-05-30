// LouiPresetSlideOver — preset browser hosted in the standard slide-over.
//
// Composes the generic LouiModuleSlideOver (ESC / backdrop / focus-trap /
// reduced-motion) with the category-grouped LouiPresetBrowser and an
// optional change summary describing what the active preset changed
// relative to the previously-active one.

import React from 'react';
import { surface, text, typography, space, radius, meter } from '../../theme/loui-theme.js';
import { LouiModuleSlideOver } from './LouiModuleSlideOver.js';
import { LouiPresetBrowser } from './LouiPresetBrowser.js';
import { LouiCustomPresetSection } from './LouiCustomPresetSection.js';
import { getPreset, type LouiPreset } from '../../audio/presets/loui-presets.js';
import { presetChangeGroups } from '../../audio/presets/preset-summary.js';
import type { AllModulesParameterState } from '../../audio/parameters/parameter-state.js';

export interface LouiPresetSlideOverProps {
  open: boolean;
  onClose: () => void;
  /** Currently-applied preset id (highlighted in the browser). */
  activeId?: string;
  /** Last-used preset id (badge only — may differ from active). */
  lastUsedId?: string;
  /** Preset id to flag "Recommended". */
  recommendedId?: string;
  /**
   * The preset that was active BEFORE the current selection — used to
   * summarise what changed.  When equal to activeId, no summary shows.
   */
  previousId?: string;
  /** Fires with the chosen preset id (caller applies it). */
  onSelect?: (id: string) => void;
  width?: number;
  /** Override the preset list (tests / storybook). */
  presets?: readonly LouiPreset[];
  /** Current parameter state (used to save user presets).  When set, the
   *  "내 프리셋" section is shown above the built-in browser. */
  currentState?: AllModulesParameterState;
  /** Caller receives the loaded user preset's state. */
  onApplyCustomPreset?: (state: AllModulesParameterState, presetName: string) => void;
}

function ChangeSummary({ from, to }: { from: LouiPreset; to: LouiPreset }) {
  const groups = presetChangeGroups(from, to);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['2'],
      padding: space['3'], borderRadius: radius.panel,
      background: surface.panel, border: `1px solid ${surface.border}`,
    }}>
      <span style={{
        fontFamily: typography.family.sans, fontSize: typography.size.xs,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: text.muted,
      }}>
        {from.displayName} → {to.displayName}
      </span>
      {groups.length === 0 ? (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>
          No parameter changes.
        </span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.secondary }}>
            This preset changes:
          </span>
          {groups.map((g) => (
            <span key={g} style={{
              fontFamily: typography.family.sans, fontSize: typography.size.xs,
              fontWeight: typography.weight.medium, color: text.primary,
              padding: '2px 7px', borderRadius: radius.chip,
              border: `1px solid ${surface.border}`, background: surface.well,
            }}>
              {g}
            </span>
          ))}
        </div>
      )}
      {to.aiOptimized && (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.accent.foreground }}>
          AI optimized — tuned for AI-generated music artefacts.
        </span>
      )}
    </div>
  );
}

export function LouiPresetSlideOver(props: LouiPresetSlideOverProps) {
  const active = props.activeId ? getPreset(props.activeId) : undefined;
  const previous = props.previousId ? getPreset(props.previousId) : undefined;
  const showSummary = active && previous && previous.id !== active.id;
  // Refresh the user preset list every time the slide-over opens.
  const [openCount, setOpenCount] = React.useState(0);
  React.useEffect(() => {
    if (props.open) setOpenCount((n) => n + 1);
  }, [props.open]);

  return (
    <LouiModuleSlideOver
      title="Presets"
      subtitle="AI-tuned mastering character"
      open={props.open}
      onClose={props.onClose}
      width={props.width ?? 560}
    >
      {props.currentState && props.onApplyCustomPreset && (
        <LouiCustomPresetSection
          currentState={props.currentState}
          onApply={props.onApplyCustomPreset}
          refreshKey={openCount}
        />
      )}
      {showSummary && <ChangeSummary from={previous!} to={active!} />}
      <LouiPresetBrowser
        {...(props.activeId ? { activeId: props.activeId } : {})}
        {...(props.lastUsedId ? { lastUsedId: props.lastUsedId } : {})}
        {...(props.recommendedId ? { recommendedId: props.recommendedId } : {})}
        {...(props.presets ? { presets: props.presets } : {})}
        {...(props.onSelect ? { onSelect: props.onSelect } : {})}
      />
    </LouiModuleSlideOver>
  );
}
