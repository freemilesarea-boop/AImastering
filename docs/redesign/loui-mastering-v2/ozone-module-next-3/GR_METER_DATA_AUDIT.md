# OZONE-MODULE-NEXT-3 — Gain Reduction Data Audit

> Where the limiter GR value comes from and how far it flows, so the meter
> shows REAL data (and honestly "unavailable" otherwise).

---

## 1. GR data path (realtime)

```
Rust Limiter (GainReduction) ──► LouiMasteringChain.limiterGrDb()  (WASM)
   └─ mastering-chain.worklet.js posts { type:'metrics', limiterGrDb, … } (every 64 blocks)
        └─ RealtimeMetrics.push() → snapshot.limiterGrDb  (realtime-metrics.ts)
             └─ createRealtimeMasteringGraph onMetrics → useRealtimeMasteringGraph.metrics
                  └─ ProductPageProductionInner: realtime.metrics.limiterGrDb + realtime.active/enabled
```

| Stage | Field |
|---|---|
| Worklet metric post | `limiterGrDb: number` (RealtimeMetricSample) |
| Aggregated snapshot | `RealtimeMetricsSnapshot.limiterGrDb` (latest value) |
| Hook | `useRealtimeMasteringGraph().metrics.limiterGrDb` + `.active` + `.enabled` |
| Debug panel | already showed `limiter GR` as text (now a meter) |

## 2. Availability

GR exists ONLY while the realtime preview is running:
`available = realtime.enabled && realtime.active`.

- **Realtime flag OFF (default):** the hook is inert → metrics empty →
  GR `unavailable`.  Meters show "—" / "실시간 프리뷰에서 GR 표시".
- No render-stage GR metric exists today → `source` is `realtime` or
  `unavailable` only (the model leaves room for `render-metrics` later).

**No fake GR is ever shown.**

## 3. Mount points (new)

| Surface | Meter |
|---|---|
| Limiter / Maximizer slide-over panel | full vertical `LouiGainReductionMeter` (via `RealtimeGrProvider` context) |
| Realtime debug overlay | compact horizontal meter (replaces the GR text row) |

The right meter rail / module-chain compact GR is left for a follow-up to
keep this change additive and FPS-safe; the data path + component support
it (compact mode).

## 4. Performance

- Updates are data-driven (the metrics stream, a few Hz) — no RAF.
- Peak hold decays per metrics frame (`decayPeak`, ~0.4 dB/frame).
- Context value is memoised; CSS transitions handle smoothing.
