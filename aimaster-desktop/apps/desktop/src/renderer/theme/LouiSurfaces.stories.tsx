// Charcoal/lavender surface tokens — visual QA reference (DESIGN-POLISH-2).
// A non-interactive doc story showing the elevation ladder, text
// hierarchy, borders, and accent so the theme can be eyeballed at a glance.

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { surface, text, meter } from './loui-theme';
import { loui } from './loui-home';

function Swatch({ name, value, fg }: { name: string; value: string; fg?: string }) {
  return (
    <div style={{
      borderRadius: 12, padding: 14, background: value,
      border: `1px solid ${surface.border}`, minWidth: 150,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: fg ?? text.primary }}>{name}</div>
      <div style={{ fontSize: 11, fontFamily: 'ui-monospace', color: text.muted, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Showcase() {
  return (
    <div style={{ background: surface.background, padding: 28, minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ color: text.primary, fontSize: 16, fontWeight: 700 }}>Charcoal surface ladder</div>
        <div style={{ color: text.tertiary, fontSize: 12, marginTop: 4 }}>
          background → panel → well → overlay (no pure black)
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <Swatch name="background" value={surface.background} />
          <Swatch name="panel" value={surface.panel} />
          <Swatch name="well" value={surface.well} />
          <Swatch name="overlay" value={surface.overlay} />
        </div>
      </div>

      <div>
        <div style={{ color: text.primary, fontSize: 14, fontWeight: 600 }}>Elevation in context</div>
        <div style={{ marginTop: 10, padding: 18, borderRadius: 16, background: surface.panel, border: `1px solid ${surface.border}` }}>
          <div style={{ color: text.secondary, fontSize: 12 }}>Main panel</div>
          <div style={{ marginTop: 10, padding: 14, borderRadius: 12, background: surface.well, border: `1px solid ${surface.border}` }}>
            <div style={{ color: text.secondary, fontSize: 12 }}>Elevated well</div>
            <div style={{ marginTop: 10, padding: 12, borderRadius: 10, background: surface.overlay, border: `1px solid ${surface.borderElevated}` }}>
              <div style={{ color: text.secondary, fontSize: 12 }}>Overlay / hover</div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div style={{ color: text.primary, fontSize: 14, fontWeight: 600 }}>Text hierarchy</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <span style={{ color: text.primary, fontSize: 14 }}>primary · −14.0 LUFS</span>
          <span style={{ color: text.secondary, fontSize: 13 }}>secondary · Streaming-ready master</span>
          <span style={{ color: text.tertiary, fontSize: 12 }}>tertiary · supporting label</span>
          <span style={{ color: text.muted, fontSize: 12 }}>muted · hint copy goes here</span>
        </div>
      </div>

      <div>
        <div style={{ color: text.primary, fontSize: 14, fontWeight: 600 }}>Lavender accent (subtle glow)</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={{
            border: 'none', padding: '10px 18px', borderRadius: 12, fontWeight: 600, color: '#0E0E14',
            background: `linear-gradient(135deg, ${loui.activeViolet}, ${loui.primaryLavender})`,
            boxShadow: `0 6px 20px -8px ${loui.glowLavender}`,
          }}>마스터링 시작</button>
          <div style={{
            padding: 12, borderRadius: 12, minWidth: 130,
            background: `linear-gradient(160deg, rgba(167,139,250,0.14), ${surface.panel})`,
            border: `1px solid rgba(167,139,250,0.5)`,
            boxShadow: `0 0 16px -4px ${loui.glowLavender}`,
            color: text.primary, fontSize: 12, fontWeight: 600,
          }}>Active card</div>
          <Swatch name="accent" value={meter.accent.foreground} fg="#0E0E14" />
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof Showcase> = {
  title: 'Theme / Charcoal + Lavender',
  component: Showcase,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof Showcase>;

export const Surfaces: Story = {};
