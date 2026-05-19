# M3-P-NEXT-1 — Storybook Setup

> Configuration details, npm scripts, and Vite aliasing.

---

## 1. Storybook version

`storybook@10`, `@storybook/react-vite@10`, `@storybook/addon-docs@10`.

Storybook 10 is ESM-only — this matters for `.storybook/main.ts`:

```ts
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

(`__dirname` is undefined in ESM modules; the snippet above re-derives it
for cross-version compatibility.)

---

## 2. `.storybook/main.ts`

```ts
const config: StorybookConfig = {
  stories: [
    '../src/renderer/**/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  async viteFinal(viteConfig) {
    return mergeConfig(viteConfig, {
      resolve: {
        alias: {
          '@aimaster/shared-types/streaming': path.resolve(__dirname, '..', '..', '..',
            'packages', 'shared-types', 'src', 'streaming', 'index.ts'),
          '@aimaster/shared-types': path.resolve(__dirname, '..', '..', '..',
            'packages', 'shared-types', 'src', 'index.ts'),
        },
      },
      server: { fs: { allow: [path.resolve(__dirname, '..', '..', '..')] } },
    });
  },
  typescript: { reactDocgen: false },
};
```

### Aliases

The workspace package `@aimaster/shared-types` exposes subpath exports
that Storybook's Vite doesn't honour without explicit aliasing.  We map
both the main entry and the `/streaming` subpath manually.  The same
applies to any future subpath imports (e.g. `/profile`, `/engine`).

### `fs.allow`

Vite's dev server refuses to serve files outside its `root` by default.
Storybook's root is `apps/desktop/.storybook`, but the workspace
packages live two levels up.  We broaden `fs.allow` to the repo root.

### `reactDocgen: false`

Storybook 10's `react-docgen-typescript` integration is slow and
sometimes mis-reads complex prop types (the V2 panel `session?: ...`
union confused it).  We disable it; prop documentation comes from
JSDoc above the prop interfaces instead.

---

## 3. `.storybook/preview.tsx`

```tsx
import '../src/renderer/styles/index.css';   // Tailwind utilities

const preview: Preview = {
  parameters: {
    layout: 'centered',
    backgrounds: { default: 'loui-dark', values: [...] },
    docs: { story: { inline: true } },
  },
  decorators: [
    (Story) => (
      <div style={{
        background: '#09090b',
        minWidth: 360, maxWidth: 720, padding: '1.25rem',
        fontFamily: 'ui-sans-serif, system-ui, ...',
        color: '#e4e4e7',
      }}>
        <Story />
      </div>
    ),
  ],
};
```

The decorator constrains story canvases to typical panel widths
(360–720 px) on the dark background.  Matches the production
`AnalyzerPanelStack` framing.

---

## 4. npm scripts

`apps/desktop/package.json`:

```jsonc
{
  "scripts": {
    "storybook":        "storybook dev -p 6006 --no-open",
    "build-storybook":  "storybook build -o storybook-static"
  }
}
```

The `--no-open` flag prevents a browser from launching in headless / CI
environments (the URL prints regardless).

---

## 5. `.gitignore`

`apps/desktop/.gitignore`:

```
storybook-static/
```

Storybook static output is a build artefact, regenerated on every
`build-storybook` run.  Don't commit it.

---

## 6. Stories convention

| Filename | Purpose |
|---|---|
| `MyComponent.tsx` | Production component |
| `MyComponent.stories.tsx` | Storybook stories (next to component) |

Each story file:
1. Declares a default-exported `Meta<typeof Component>`.
2. Exports named `Story` objects.
3. Uses `mockFactory(presetId)` for the analyzer-driven panels.

Stories should be **side-effect-free** at import time so Storybook's
indexer can analyse them statically.  The `MOCK_PRESETS` constant is
defined eagerly at module load — it's pure data, no audio device touched.

---

## 7. CI integration plan

Not implemented in this commit, but the structure supports it:

```yaml
# Future .github/workflows/storybook.yml
- run: pnpm --filter @aimaster/desktop build-storybook
- uses: actions/upload-artifact@v4
  with:
    name: storybook
    path: aimaster-desktop/apps/desktop/storybook-static
```

For PR previews, deploy `storybook-static/` to a static host (Netlify
preview / Vercel / s3+cloudfront) on every PR.

---

## 8. Verification

| Check | Result |
|---|---|
| `pnpm storybook` launches on :6006 | ✅ (the `dev` server runs cleanly; manual visual confirmation) |
| `pnpm build-storybook` exits 0 | ✅ |
| `storybook-static/index.json` lists all 4 panels + theme | ✅ |
| `pnpm typecheck` after install | ✅ clean |
| Production `pnpm build:renderer` still produces same bundle | ✅ 352 KB JS |
| `cargo test -p loui-dsp` | ✅ 31/31 (untouched) |
