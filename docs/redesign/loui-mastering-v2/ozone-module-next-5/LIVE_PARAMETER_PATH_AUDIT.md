# OZONE-MODULE-NEXT-5 — Live Parameter Path Audit

> What already flows live, and what was missing (drag editing + status).

---

## 1. The live path (ALREADY wired)

```
module panel slider/knob → useModuleParameters().setParam(id, value)
  → ModuleParameterStateProvider state (clamp + quantise + command log + dispatch)
    → useRealtimeMasteringGraph rAF effect (paramState dep)
      → stateToChainConfig(state)  (22-arg flat config)
        → graph.updateConfig(config)  → worklet port { type:'config' }
          → Rust MasteringChain.setConfig(...)   [live audio change]
```

So when the realtime flag is ON, **any parameter-state change is already
heard live** — sliders/knobs in the EQ / Dynamics / Imager / Limiter panels
were live before this milestone.  No fake audio anywhere.

| Module | Rust chain receives | Live? |
|---|---|---|
| EQ | lowCut / lowShelf / presence / air / outputGain / bypass | ✅ |
| Dynamics | threshold / ratio / attack / release / mix / bypass | ✅ |
| Imager | width / lowMono / bypass | ✅ |
| Limiter / Maximizer | ceiling / lookahead / ISP / (loudness target) / bypass | ✅ |

Flag OFF → the rAF effect is inert; edits apply on the next Update Preview
/ Re-master (re-render path), no instant audio.

## 2. What was missing

1. **Drag editing** — the EQ curve overlay was read-only; no point dragging.
2. **Realtime status UX** — no clear "you are hearing this live" vs "edits
   apply on Update Preview" indicator.
3. **Honest separation** — live-preview vs export support not surfaced
   together.

## 3. This milestone

- `DraggableEQCurveEditor` replaces the read-only overlay in the central
  visualizer; drags write via `eq.setParam` → the SAME live path above.
- `LouiRealtimeStatus` chip shows live/loading/unavailable/off honestly.
- Export support badges unchanged (still honest: EQ tone = preview-only for
  export until the Rust offline backend is promoted).
