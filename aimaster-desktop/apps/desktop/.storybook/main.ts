// Storybook main config — Loui Mastering UI workbench.
//
// Hosted inside `apps/desktop` so stories can import the renderer's
// components directly with their normal relative paths.  The build
// output is `apps/desktop/storybook-static/` (gitignored) and is
// independent of the production renderer bundle — no chance of leaking
// Storybook code into the shipped app.
//
// Run:
//   pnpm --filter @aimaster/desktop storybook
//   pnpm --filter @aimaster/desktop build-storybook

import { mergeConfig } from 'vite';
import type { StorybookConfig } from '@storybook/react-vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Storybook 10 is ESM — `__dirname` is not available.  Re-derive it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  // Story files live next to the components they document.  We pick up
  // both *.stories.tsx and the design-system .mdx index page.
  stories: [
    '../src/renderer/**/*.stories.@(ts|tsx|mdx)',
  ],

  addons: [
    '@storybook/addon-docs', // pulls in autodocs + MDX renderer
  ],

  framework: {
    name: '@storybook/react-vite',
    options: {},
  },

  // Mock-only by default.  Stories use the mock analyzer session — no
  // real WASM, no AudioWorklet, no real audio device.  An opt-in story
  // (`*.WithRealWasm.stories.tsx`) can override per story.
  async viteFinal(viteConfig) {
    return mergeConfig(viteConfig, {
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '..', 'src', 'renderer'),
          // The shared-types workspace package — resolved manually here
          // because Storybook's Vite doesn't honour the parent monorepo's
          // pnpm workspace resolution out of the box for the docs build.
          '@aimaster/shared-types/streaming': path.resolve(
            __dirname, '..', '..', '..',
            'packages', 'shared-types', 'src', 'streaming', 'index.ts',
          ),
          '@aimaster/shared-types': path.resolve(
            __dirname, '..', '..', '..',
            'packages', 'shared-types', 'src', 'index.ts',
          ),
        },
      },
      server: {
        fs: {
          // Allow loading workspace siblings so the alias above resolves.
          allow: [path.resolve(__dirname, '..', '..', '..')],
        },
      },
    });
  },

  // Skip the docs autotoolkit's heavy-handed react-docgen-typescript;
  // we annotate prop types via JSDoc instead.  Faster, fewer surprises.
  typescript: {
    reactDocgen: false,
  },
};

export default config;
