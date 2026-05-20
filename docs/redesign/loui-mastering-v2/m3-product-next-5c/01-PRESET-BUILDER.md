# M3-P-NEXT-5C — EnginePreset Builder

> `buildPreviewOverride` — staged patch → render override.  Pure +
> deterministic.

---

## 1. Signature

```ts
function buildPreviewOverride(patch: readonly StagedPatchEntry[]): PreviewBuildResult
function mergeOptions(base: MasteringOptions, override: Partial<MasteringOptions>): MasteringOptions
```

Both are pure functions — no IPC, no side effects.  Same input → same
output, every time (deterministic; the builder sorts fragments before
processing).

---

## 2. Result shape

```ts
interface PreviewBuildResult {
  optionsOverride: Partial<MasteringOptions>;   // renderable subset
  enginePatch: StagedPatchEntry[];              // canonical full patch (sorted)
  unsupportedForRender: Array<{                 // staged but not renderable yet
    moduleId: string;
    parameterId: string;
    enginePath: string;
    reason: string;
  }>;
  hasRenderableChange: boolean;                 // override non-empty
}
```

- `optionsOverride` — what the existing Python preview render honours
- `enginePatch` — the canonical EngineSchema fragment list (reused by
  the future export path — `05-OVERRIDE-REUSE.md`)
- `unsupportedForRender` — wired fragments staged but with no
  `MasteringOptions` mapping yet (the other 10 wired params in 5C)

---

## 3. Renderable mapping

```ts
const RENDERABLE_MAP: Record<string, keyof MasteringOptions> = {
  'loudness-norm:targetLufs': 'targetLufs',
  // 5D candidates (MasteringOptions already supports these):
  //   'limiter:ceilingDb'         → 'targetTp'
  //   'stereo-imager:width'       → 'stereoWidth'
  //   'gain-staging:targetPeakDb' → 'outputGainDb'
};
```

A fragment whose `${moduleType}:${path}` key is in `RENDERABLE_MAP`
(and whose value is a number) becomes an `optionsOverride` entry.
Everything else lands in `unsupportedForRender`.

Adding a row here is the entire change needed to make another parameter
renderable — that is M3-P-NEXT-5D.

---

## 4. Determinism

```ts
const sorted = [...patch].sort((a, b) =>
  `${a.moduleType}:${a.path}`.localeCompare(`${b.moduleType}:${b.path}`));
```

Fragments are sorted by their engine key before processing, so the
output (`optionsOverride`, `enginePatch`, `unsupportedForRender`) is
independent of insertion order.  Two patches with the same fragments in
different orders produce byte-identical results — important for caching
+ render deduplication later.

---

## 5. Worked example

Staged patch (after the user changes targetLufs and width):

```ts
[
  { moduleType: 'stereo-imager', path: 'width',      value: 1.3, sourceModuleId: 'imager',  sourceParameterId: 'widthPct' },
  { moduleType: 'loudness-norm', path: 'targetLufs', value: -10, sourceModuleId: 'limiter', sourceParameterId: 'targetLufs' },
]
```

`buildPreviewOverride(patch)` →

```ts
{
  optionsOverride: { targetLufs: -10 },          // only the renderable one
  enginePatch: [ /* both, sorted by key */ ],
  unsupportedForRender: [
    { moduleId: 'imager', parameterId: 'widthPct',
      enginePath: 'stereo-imager:width',
      reason: 'no MasteringOptions mapping (staged for future render)' },
  ],
  hasRenderableChange: true,
}
```

So in 5C, changing width stages it (and shows under
`unsupportedForRender`) but does NOT drive a render; changing targetLufs
does.

---

## 6. mergeOptions

```ts
mergeOptions(base, override) → { ...base, ...override }
```

Trivial shallow merge — the override wins.  Used by
`ProductionPreviewControl` to build the full `MasteringOptions` sent in
the render request (the Python pipeline needs the complete options, not
just the delta).

---

## 7. Why MasteringOptions, not EnginePreset, for the render

The current Python pipeline consumes `MasteringOptions` (the
`audio:master` path).  There is no live `EnginePreset → render` path in
production yet (that's M2-full).  So the renderable override targets
`MasteringOptions` — the shape the pipeline already understands.

The `enginePatch` (canonical EngineSchema fragments) is retained for:
- **Forward compatibility** — when M2-full's preset-driven render lands,
  the patch feeds it directly.
- **Export reuse** — the same fragments drive the final export override
  (`05-OVERRIDE-REUSE.md`).

So the builder produces BOTH representations: the pragmatic one
(`optionsOverride`) for today's render, and the canonical one
(`enginePatch`) for tomorrow's.

---

## 8. Testing

The builder is pure → trivially unit-testable (vitest, M3-P-NEXT-5D):

```ts
test('only targetLufs is renderable in 5C', () => {
  const r = buildPreviewOverride([
    frag('loudness-norm', 'targetLufs', -10),
    frag('stereo-imager', 'width', 1.3),
  ]);
  expect(r.optionsOverride).toEqual({ targetLufs: -10 });
  expect(r.unsupportedForRender).toHaveLength(1);
  expect(r.hasRenderableChange).toBe(true);
});
```

Until that suite lands, the `Product / Preview Render` stories provide
visual coverage of the build → render → swap loop.
