// Storybook preview — global decorators + parameters.
//
// Sets the dark theme that matches the production renderer, imports the
// renderer's compiled CSS so Tailwind classes resolve, and centres
// stories in a sane viewport.

import React from 'react';
import type { Preview } from '@storybook/react-vite';

// Import the renderer's global stylesheet so Tailwind utilities work
// inside stories.  Path is relative to this file in apps/desktop/.storybook/.
import '../src/renderer/styles/index.css';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    backgrounds: {
      // Match the production app's near-black background.
      default: 'loui-dark',
      values: [
        { name: 'loui-dark',   value: '#09090b' },
        { name: 'loui-darker', value: '#0a0a0a' },
        { name: 'loui-mid',    value: '#18181b' },
      ],
    },
    docs: {
      // Storybook's autodocs page renders the component on the dark
      // background by default; we override the inline-render block too.
      story: { inline: true },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },

  decorators: [
    // Constrain story canvas width + colour to mirror real panel framing.
    (Story) => (
      <div
        style={{
          background: '#09090b',
          minWidth: 360,
          maxWidth: 720,
          padding: '1.25rem',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI"',
          color: '#e4e4e7',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default preview;
