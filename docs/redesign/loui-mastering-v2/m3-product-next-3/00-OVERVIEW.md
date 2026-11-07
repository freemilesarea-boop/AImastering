# M3-P-NEXT-3 — Loui Mastering Product Layout

> Turn the analyzer panels from "developer instruments stacked in a card"
> into a commercial-grade product layout that reads as Loui Mastering.

> **이후 변경 (코드 기준).** 이 마일스톤이 만든 `ProductPage` 는 `ResultPage`
> 가 최종 결과 화면이 되면서 은퇴했고, 그 크롬 다섯 개 ― `LouiTopBar`,
> `LouiModuleStrip`, `LouiPreviewControl`, `LouiABCompare`,
> `LouiRevisionStack` ― 는 삭제되었다. 자리를 물려받은 `StudioPage` 는
> `components/TopBar.tsx`, `LouiMonitorBar`, `LouiStudioPresetBar`,
> `LouiPreviewTransport` 로 같은 일을 하고, 리비전은 `audioStore` 와
> `shortcuts/commands.ts` 에 있다. 이 폴더의 문서들은 **그때의 계획과
> 레이아웃 기록**이며, 지금 코드의 설명이 아니다 — 컴포넌트 이름으로
> 코드를 찾으면 없다.
>
> **두 번째 정리 (코드 기준).** 위 "8. What's next" 의 두 항목은 둘 다
> 성립하지 않는다. (2) 는 ProductPage 가 은퇴했으니 무효다. (1) 은 절반만
> 일어났다 — 슬라이드오버(`LouiModuleSlideOver`)는 살아 있지만
> `LouiPresetSlideOver` 만 쓰고, 그 주석이 children 으로 적어 둔 다섯 개
> 전용 파라미터 패널은 어디서도 import 되지 않는다. 앱은 범용 패널을
> 렌더한다. 그 패널들과 그들이 쓰는 컨트롤은
> `apps/desktop/scripts/fixtures/story-only-files.txt` 에
> `awaiting-product-decision` 으로 적혀 있고, 스윕이 그 목록을 지킨다.
>
> 같은 마일스톤의 엔진 쪽 — dispatcher seam(`PresetPatchDispatcher`,
> `preview-render-client`, 그 mock 과 배럴), 스테이징된 override
> 빌더(`engine-preset-builder`), 그리고 EQ 오버레이와 그 드래그/커브
> 모델 — 은 삭제되었다. 앱은 명령을 엔진으로 **밀지** 않고, 상태에서
> 체인 config 를 만들어 워클릿과 렌더가 **읽게** 한다. EQ 는
> `LouiEqGraph` 가 주파수·게인·Q 를 끌고 free 밴드를 더하고 지우며,
> `eq-graph-selftest` 가 그린 커브를 실제 WASM 체인과 비교한다.

---

## 1. What changed

Until now the V2 analyzer panels lived in ResultPage as a vertical stack
of cards (`AnalyzerPanelStack`).  Functional, but visually identical to
the legacy V1 layout — same one-column scroll-of-cards shape.

M3-P-NEXT-3 introduces a **dedicated product layout page** —
`ProductPage` — that ships behind a feature flag and replaces ResultPage
for the `result` slot when enabled.  The layout takes its cue from
Ozone / Apple Pro Apps / Ableton's mastering surfaces.

| Region | Component | Purpose |
|---|---|---|
| Top Bar     | `LouiTopBar`        | Brand wordmark · engine chip · Import / Preset / Export / Settings |
| Preset row  | `LouiPresetHeader`  | Streaming-target chips (UI shell) |
| Transport   | inline in `ProductPage` | Play / pause + scrub (production path only) |
| Canvas      | `LouiAnalyzerCanvas`| Centre-stage spectrum visualiser with header + axis legend |
| Right rail  | `LouiMeterColumn`   | LoudnessMeterPanelV2 + StereoScopePanel in themed shells |
| Module rack | `LouiModuleStrip`   | EQ / Dynamics / Imager / Limiter / Export — UI shells |
| Status bar  | `LouiStatusBar`     | Sample rate · channels · target LUFS / TP · engine status |

---

## 2. What did NOT change

Mandatory zero-regression contract (matches the brief's "절대 하지 말 것" list):

| Untouched | Verification |
|---|---|
| DSP chain (`loui-dsp` Rust core) | `cargo test -p loui-dsp --lib` → 31/31 |
| EQ / compressor / limiter pipelines | No code modified |
| Python mastering pipeline / export | No code modified |
| ResultPage default rendering | App.tsx flag check + V1 path unchanged |
| V2 analyzer panels (`LoudnessMeterPanelV2`, `SpectrumAnalyzerPanel`, `StereoScopePanel`) | Reused as-is via Loui shells |
| WASM analyzer flag (`VITE_LOUI_WASM_ANALYZER`) | Independent; remains controlling V1↔V2 panel switch |
| Storage schema, preset system, engine API | No code modified |
| Renderer bundle (V1 path) | Build size +22 KB (new product components only); existing path bit-identical |

---

## 3. Feature flag

```
build  VITE_LOUI_PRODUCT_LAYOUT=true   # ProductPage takes the `result` slot
runtime window.__LOUI_PRODUCT_LAYOUT__ = true
```

Default is `false`.  When the flag is off `App.tsx` renders ResultPage
exactly as before.  See `02-FEATURE-FLAG.md` for the rollout/rollback
sequence.

The product-layout flag is **orthogonal** to the WASM analyzer flag.
Both can be combined, both can be off, both can be on — the four
combinations are documented in `02-FEATURE-FLAG.md`.

---

## 4. Deliverables

| # | Path | Purpose |
|---|---|---|
| 1 | `apps/desktop/src/renderer/audio/product-layout-flag.ts` | `isProductLayoutEnabled()` resolver |
| 2 | `apps/desktop/src/renderer/components/product/*` | 6 layout components + barrel |
| 3 | `apps/desktop/src/renderer/pages/ProductPage.tsx` | Page that assembles the layout |
| 4 | `apps/desktop/src/renderer/pages/ProductPage.stories.tsx` | 9 stories incl. 3 viewport variants |
| 5 | `apps/desktop/src/renderer/components/product/LouiModuleStrip.stories.tsx` | 5 stories of the module rack |
| 6 | Docs (this directory) | 7 markdown files |

---

## 5. Design rules applied

The new layout consumes `loui-theme.ts` tokens directly via inline
styles.  No Tailwind classes in product components — they would couple
the visual identity to a class-name layer that's not present in non-Tailwind
contexts (e.g., when we later ship the layout as a public design-system
package).

Concretely:
- `surface.background`, `surface.panel`, `surface.border` for chrome
- `text.primary`, `text.secondary`, `text.tertiary`, `text.muted` for hierarchy
- `meter.safe`, `meter.warn`, `meter.danger`, `meter.accent` for status cues
- `space.2 / 3 / 4` for inset rhythm
- `radius.chip`, `radius.panel` for two roundness tiers
- `typography.size.{xs,sm,md,lg}` + `typography.family.{sans,mono}` with `tabular-nums` on live numbers

See `04-THEME-APPLICATION.md` for the verbatim mapping.

---

## 6. Verification

| Check | Result |
|---|---|
| `pnpm --filter @aimaster/desktop typecheck` | clean |
| `pnpm --filter @aimaster/desktop build:renderer` | succeeds, 373 KB JS / 99 KB WASM |
| `pnpm --filter @aimaster/desktop build-storybook` | succeeds, **7 indexed components / 47 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| Flag off → ResultPage renders | manual: `window.__LOUI_PRODUCT_LAYOUT__ === undefined` |
| Flag on → ProductPage renders | manual: `window.__LOUI_PRODUCT_LAYOUT__ = true` |

---

## 7. Storybook coverage

Run `pnpm --filter @aimaster/desktop storybook` and navigate to:

- **Product / ProductPage** — full-page stories: SpotifyLoud, WarmAcoustic,
  AIHarsh, ClippingRisk, BrokenPhase, MonoSafe, Idle, NarrowLaptop,
  Desktop1280 (3 viewport variants for the same SpotifyLoud preset)
- **Product / Module Strip** — Default, AllActive, AllBypassed, AllLocked,
  ComingSoonHeavy

---

## 8. What's next (M3-P-NEXT-4 and beyond)

`06-NEXT-STEPS.md` enumerates the immediate follow-ups.  The two near-term
ones:

1. **Hook Module Strip cards to real parameter panels** — clicking a card
   opens a slide-over with EQ curve / comp graph / limiter parameters.
2. **Promote ProductPage to default** — flip `VITE_LOUI_PRODUCT_LAYOUT` to
   `true` in the default build config once external opt-in reports
   stability.  ResultPage stays as the fallback flag-off path until
   M3-P-NEXT-5 removes it.
