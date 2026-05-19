// Storybook story — design system tokens reference.
//
// Renders the loui-theme palette + spacing + meter colours so designers
// and developers can confirm the visual identity at a glance.  Not a
// component story — purely documentation.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { louiTheme, meter, surface, text, space, radius, typography } from '../theme/loui-theme';

function ThemeBoard() {
  return (
    <div style={{ width: 720, color: text.primary, fontFamily: typography.family.sans }}>
      <h1 style={{ fontSize: typography.size.lg, fontWeight: typography.weight.medium, marginBottom: space[4] }}>
        Loui Mastering — Theme v1
      </h1>
      <p style={{ fontSize: typography.size.sm, color: text.tertiary, marginBottom: space[5] }}>
        Design tokens for the V2 analyzer stack.  Restraint policy: muted
        saturation, no neon, no drop shadows.  Inspired by Apple Pro Apps
        / Ozone / Ableton.
      </p>

      {/* Surface scale ─────────────────────────────────────────────── */}
      <Section title="Surface">
        <div style={{ display: 'flex', gap: space[2] }}>
          {Object.entries(surface).map(([k, v]) => (
            <Swatch key={k} label={k} value={v} />
          ))}
        </div>
      </Section>

      {/* Text scale ────────────────────────────────────────────────── */}
      <Section title="Text">
        {Object.entries(text).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: space[3], alignItems: 'baseline' }}>
            <span style={{ width: 100, color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
              {k}
            </span>
            <span style={{ color: v, fontSize: typography.size.md }}>The quick brown fox</span>
            <span style={{ color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>{v}</span>
          </div>
        ))}
      </Section>

      {/* Meter colour scale ────────────────────────────────────────── */}
      <Section title="Meter — colour scale">
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          {(Object.keys(meter) as Array<keyof typeof meter>).map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: space[3] }}>
              <span style={{ width: 100, color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
                {k}
              </span>
              <div
                style={{
                  width: 200,
                  height: 12,
                  borderRadius: radius.bar,
                  background: meter[k].background,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '60%',
                    background: meter[k].foreground,
                  }}
                />
              </div>
              <span style={{ color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
                {meter[k].foreground}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Spacing ───────────────────────────────────────────────────── */}
      <Section title="Spacing">
        {(Object.keys(space) as Array<keyof typeof space>).map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: space[3], marginBottom: space[1] }}>
            <span style={{ width: 50, color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
              {k}
            </span>
            <div
              style={{
                width: space[k],
                height: 16,
                background: meter.accent.foreground,
                borderRadius: radius.bar,
              }}
            />
            <span style={{ color: text.muted, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
              {space[k]}
            </span>
          </div>
        ))}
      </Section>

      {/* Radius scale ──────────────────────────────────────────────── */}
      <Section title="Radius">
        <div style={{ display: 'flex', gap: space[3], alignItems: 'flex-end' }}>
          {(Object.keys(radius) as Array<keyof typeof radius>).map((k) => (
            <div key={k} style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 60,
                  height: 60,
                  background: surface.panel,
                  border: `1px solid ${surface.border}`,
                  borderRadius: radius[k],
                }}
              />
              <div style={{ marginTop: space[1], color: text.muted, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
                {k}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: space[5] }}>
      <h2
        style={{
          fontSize: typography.size.sm,
          fontWeight: typography.weight.semi,
          color: text.secondary,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: space[2],
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          width: 80,
          height: 80,
          background: value,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.chip,
        }}
      />
      <div style={{ marginTop: space[1], color: text.tertiary, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
        {label}
      </div>
      <div style={{ color: text.muted, fontSize: typography.size.xs, fontFamily: typography.family.mono }}>
        {value}
      </div>
    </div>
  );
}

const meta: Meta<typeof ThemeBoard> = {
  title: 'Design System / Theme v1',
  component: ThemeBoard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Loui Mastering design token surface.  Use this story to verify ' +
          'palette consistency, spacing rhythm, radius scale, and the ' +
          'meter-status colour ramp.  Tokens live in `theme/loui-theme.ts` ' +
          'and are imported by future panel refactors (M3-P-NEXT-3).',
      },
    },
  },
};
export default meta;
export const Tokens: StoryObj<typeof ThemeBoard> = {};

// Expose the raw token object on the story for sanity-checking via the
// Storybook controls panel.
export const RawJson: StoryObj<typeof ThemeBoard> = {
  render: () => (
    <pre
      style={{
        fontFamily: typography.family.mono,
        fontSize: typography.size.xs,
        color: text.tertiary,
        background: surface.well,
        padding: space[3],
        borderRadius: radius.panel,
        maxWidth: 720,
        overflow: 'auto',
      }}
    >
      {JSON.stringify(louiTheme, null, 2)}
    </pre>
  ),
};
