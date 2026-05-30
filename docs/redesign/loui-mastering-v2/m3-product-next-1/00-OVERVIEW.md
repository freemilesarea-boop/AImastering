# M3-P-NEXT-1 — UI Workbench (Storybook)

> Loui Mastering's components leave the "developer panel" stage and enter
> a proper design system process.  Storybook hosts the V2 panels with a
> deterministic mock analyzer session; the production app is unchanged.

---

## 1. What this milestone delivers

| Artefact | Location |
|---|---|
| Storybook 10 + React + Vite config | `apps/desktop/.storybook/` |
| Build script + npm scripts          | `apps/desktop/package.json` (`storybook`, `build-storybook`) |
| Mock analyzer session               | `apps/desktop/src/renderer/audio/mock-analyzer-session.ts` |
| Theme tokens v1                     | `apps/desktop/src/renderer/theme/loui-theme.ts` |
| 4 component story files + 1 theme docs story | `apps/desktop/src/renderer/components/*.stories.tsx`, `theme/loui-theme.stories.tsx` |
| 7 mock timeline presets             | `MOCK_PRESETS` in mock-analyzer-session.ts |
| `.gitignore` for `storybook-static/` | `apps/desktop/.gitignore` |

Five indexed Storybook entries:
- `LoudnessMeterPanelV2` — 9 stories
- `SpectrumAnalyzerPanel` — 6 stories
- `StereoScopePanel` — 7 stories
- `AnalyzerPanelStack` (V2) — 9 stories
- `Design System / Theme v1` — 2 stories

---

## 2. Why now

After M3 product wired V2 panels into ResultPage behind a feature flag,
the next bottleneck is **iteration speed on the visuals**.  Running the
full Electron app to compare two button states is slow.  Storybook gives
us:

| Need | How Storybook solves it |
|---|---|
| Isolated visual review per panel | Each story renders one panel on a clean canvas |
| Deterministic state reproduction | Mock session timelines, not real audio |
| A/B comparison of presets        | `args` switcher in the toolbar |
| Theme audit                       | Tokens story shows the full palette in one view |
| Hand-off to a designer            | Static `storybook-static/` deployable anywhere |
| Future Playwright snapshot tests  | M3-P-NEXT-2 will pin pixel diffs against Storybook URLs |

---

## 3. What this milestone explicitly does NOT do

| Out of scope | Reason |
|---|---|
| Full page redesign                  | M3-P-NEXT-3 — needs visual-design pass first |
| Refactoring V2 panels to use tokens | Incremental; tokens are committed; usage migrates panel-by-panel |
| Mastering chain rewrite             | M2-full |
| EQ / Comp / Limiter Rust work       | M2-full |
| Preset system changes               | Out of scope |
| Forced V2 default                   | M3-P-NEXT-4 |

The production renderer bundle is unchanged: still 352 KB (gzip 105 KB),
all assets emitted, V1 path default.

---

## 4. Architecture (Storybook layer)

```
   apps/desktop
     ├─ .storybook/
     │    ├─ main.ts          ← framework + addons + Vite aliases
     │    └─ preview.tsx       ← dark theme decorator + global CSS
     │
     ├─ src/renderer/
     │    ├─ components/
     │    │    ├─ LoudnessMeterPanelV2.tsx       (production)
     │    │    ├─ LoudnessMeterPanelV2.stories.tsx
     │    │    ├─ SpectrumAnalyzerPanel.tsx
     │    │    ├─ SpectrumAnalyzerPanel.stories.tsx
     │    │    ├─ StereoScopePanel.tsx
     │    │    ├─ StereoScopePanel.stories.tsx
     │    │    └─ AnalyzerPanelStack.stories.tsx
     │    ├─ audio/
     │    │    ├─ wasm-analyzer-session.ts        (production)
     │    │    ├─ analyzer-session-synthetic.ts    (existing dev path)
     │    │    └─ mock-analyzer-session.ts        ★ NEW — deterministic
     │    └─ theme/
     │         ├─ loui-theme.ts                    ★ NEW — tokens
     │         └─ loui-theme.stories.tsx           ★ NEW — palette docs
     │
     └─ storybook-static/                          ← `pnpm build-storybook` output (gitignored)
```

The mock session is **completely independent** from the WASM / synthetic
factories.  It implements the same `AnalyzerSession` interface with a
timeline-driven keyframe interpolator — no AudioContext, no WASM init.

---

## 5. Verification done in this commit

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | ✅ 31/31 pass |
| `pnpm typecheck` (apps/desktop) | ✅ clean |
| `pnpm build:renderer` (production bundle) | ✅ 352 KB JS / 99 KB WASM (unchanged from M3 product) |
| `pnpm build-storybook` | ✅ static bundle in `storybook-static/`, 5 indexed components |
| Storybook indexes all 4 V2 panels + theme doc | ✅ |
| ResultPage default V1 path | ✅ unchanged |
| Mock session implements `AnalyzerSession` interface | ✅ typechecks |

---

## 6. Deferred verification (browser / human)

| Check | Why deferred |
|---|---|
| Visual sanity — all stories render without console errors | needs `pnpm storybook` running |
| Mock timeline animation smoothness | manual look |
| Theme palette readability at typical desktop brightness | designer pass |
| Story snapshot regression (Chromatic-style) | M3-P-NEXT-2 |
| A11y addon audit on each panel | future polish |

---

## 7. Issues for follow-up

| ID | Issue | Severity |
|---|---|---|
| **M3-W-A** | Storybook duplicates the V2 panel rendering of `AnalyzerPanelStack` via a `MockPanelStack` shim — the real `WasmAnalyzerProvider` can't run in jsdom.  When M3-P-NEXT-2 adds Playwright we should mount the real provider with the mock factory. | Low |
| **M3-W-B** | Theme tokens (`loui-theme.ts`) are committed but NOT yet consumed by V2 panels — they still use Tailwind utilities directly.  Migration is incremental.  | Low |
| **M3-W-C** | Mock session's `setPreset()` API isn't wired to a Storybook control yet — users can only switch presets via story args.  A bottom-bar toolbar with live preset toggling would speed iteration.  | Low |
| **M3-W-D** | Storybook adds ~430 transitive deps (one-time cost).  Future: pin the lock file to prevent surprise updates.  | Low |
| **M3-W-E** | `build-storybook` writes 1 MB+ iframe.js — could split via `manualChunks` if storybook-static bundle size becomes a concern.  No production impact.  | Trivial |

---

## 8. Document map

| Doc | Topic |
|---|---|
| `00-OVERVIEW.md` (this) | Milestone summary |
| `01-STORYBOOK-SETUP.md` | Config details, scripts, Vite aliases |
| `02-MOCK-ANALYZER.md`   | Timeline preset design + interpolator |
| `03-PANEL-STORIES.md`   | What each story exercises, story matrix |
| `04-THEME-V1.md`        | Token rationale + Apple Pro Apps / Ozone / Ableton influences |
| `05-DESIGN-VERIFICATION.md` | Visual review checklist for the panels |
| `06-NEXT-STEPS.md`      | Path to Product Layout (M3-P-NEXT-3) |

---

## 9. Running it

Local dev:
```sh
cd aimaster-desktop/apps/desktop
pnpm storybook            # opens http://localhost:6006
```

Static build:
```sh
cd aimaster-desktop/apps/desktop
pnpm build-storybook      # outputs storybook-static/
```

Storybook is fully reproducible — every story uses the mock session,
no audio device or WASM init required.
