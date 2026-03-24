/**
 * esbuild bundler for Electron main process.
 *
 * Bundles src/main/index.ts + all @aimaster/* workspace packages into
 * dist/main/index.js as a single CommonJS file.
 * `electron` stays external — it's provided by the runtime.
 */
const esbuild = require('esbuild');
const path    = require('path');

const isDev = process.argv.includes('--dev');

esbuild.build({
  entryPoints: ['src/main/index.ts'],
  bundle:      true,
  platform:    'node',
  format:      'cjs',
  target:      'node20',
  outfile:     'dist/main/index.js',
  sourcemap:   isDev ? 'inline' : false,
  minify:      !isDev,
  external: [
    'electron',
    // Native modules that can't be bundled
    'node-machine-id',
  ],
  alias: {
    '@aimaster/audio-engine': path.resolve(__dirname, '../../packages/audio-engine/src/index.ts'),
    '@aimaster/license-core': path.resolve(__dirname, '../../packages/license-core/src/index.ts'),
    '@aimaster/shared-types':  path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
