// Storybook stories for ProductPageErrorBoundary (M3-P-NEXT-6).
//
// Demonstrates the crash → classic-fallback behaviour without a real
// ProductPage: a toggle component throws on demand; the boundary
// renders the (mock) classic ResultPage in its place.

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProductPageErrorBoundary } from './ProductPageErrorBoundary';
import { surface, text, typography, space } from '../theme/loui-theme';

/** A child that throws when `crash` is true (simulates a ProductPage bug). */
function MaybeCrash({ crash }: { crash: boolean }) {
  if (crash) throw new Error('simulated ProductPage render error');
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: surface.background,
      color: text.secondary,
      fontFamily: typography.family.sans,
    }}>
      <span>ProductPage (healthy)</span>
    </div>
  );
}

/** Stand-in for the classic ResultPage fallback. */
function ClassicFallback() {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space['2'],
      background: '#0a0a0a',
      color: '#e4e4e7',
      fontFamily: typography.family.sans,
    }}>
      <span style={{ fontWeight: 600 }}>Classic ResultPage (fallback)</span>
      <span style={{ fontSize: 12, color: '#a1a1aa' }}>Before / After · Preview · Save buttons</span>
    </div>
  );
}

interface HostArgs { crash: boolean }

function Host({ crash }: HostArgs) {
  return (
    <div style={{ width: 900, height: 480 }}>
      <ProductPageErrorBoundary fallback={<ClassicFallback />}>
        <MaybeCrash crash={crash} />
      </ProductPageErrorBoundary>
    </div>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Product / Error Boundary',
  component: Host,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'ProductPageErrorBoundary catches a render crash in the product ' +
          'layout and renders the classic ResultPage in its place, with a ' +
          'banner explaining the fallback.  The user keeps full save / ' +
          'export functionality.',
      },
    },
  },
  argTypes: { crash: { control: 'boolean' } },
  args: { crash: false },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const Healthy: Story = { args: { crash: false } };
export const CrashedFallback: Story = { args: { crash: true } };
