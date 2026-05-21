# REALTIME-DSP-FIX — on-device QA procedure

> Run after `build:renderer` so the rebuilt WASM (worklet/web/node) is in
> the bundle. The realtime chain is opt-in; enable it first.

## 0. Enable realtime + open diagnostics

1. Open a track → enter the workspace (ProductPage) and press play.
2. In the module-suite header click **Enable Realtime Preview** (persists to
   `localStorage` and reloads). After reload the status chip should read
   **"Realtime on · module edits are heard live"**.
   - If it reads *unavailable*, the toggle tooltip / debug panel shows why
     (AudioWorklet / WASM / asset readiness). Fix that before continuing.
3. The bottom-right **Realtime Preview** debug panel should show:
   `status active`, `worklet processing`, `config pushes` rising as you
   drag, a recent `last config`, `safety bypass 0`, and a live config
   block (img width / eq presence / eq air / dyn thresh / dyn ratio).

## 1. EQ is audible

- Open EQ. Set **Presence** to **+6 dB**, then **−6 dB** — a clear 3 kHz
  swing should be audible; the debug panel `eq presence` tracks the value.
- Set **Air** to **+6 / −6 dB** — clear high-frequency change.
- Drag the **Output Gain** — immediate volume change.
- `config pushes` increments on every drag; `safety bypass` stays **0**.

## 2. Dynamics is audible

- Open Dynamics. Drop **Threshold** to **−30 dB** and raise **Ratio** to
  **10:1** — obvious compression / pumping; the Limiter GR meter and the
  debug `dyn thresh` / `dyn ratio` reflect it.
- Toggle **Mix** 0 % ↔ 100 % — dry vs fully-compressed difference.

## 3. Imager — width sweep, NO noise (the critical case)

- Open Imager. Sweep **Width**: **0 % → 100 % → 200 %**.
  - 0 % = mono (centre-collapsed), 100 % = neutral, 200 % = very wide.
  - **There must be NO loud noise and NO signal loss at any point.**
  - `safety bypass` must stay **0** for normal sweeps. If it ever rises,
    the chain caught a bad block and fell back to dry — investigate, but
    the user still hears clean audio (no noise).
- Sweep **Low Mono** 20 → 400 Hz — bass narrows; no noise, no dropout.

## 4. Mono + stereo source files

- Repeat §3 with a **mono** file and a **stereo** file. Mono must stay
  centred and clean (the worklet duplicates the channel before the M/S
  maths — no foreign-buffer noise).

## 5. Output gain sweep + endurance

- Sweep **Output Gain** −12 → +12 dB; verify the limiter holds the ceiling.
- Play continuously for **3 minutes** with occasional tweaks; `safety
  bypass` stays 0, `xruns` stays low, `cpu` reasonable.

## 6. A/B + revision + export (no regressions)

- Toggle **A/B** — original vs preview switch is clean.
- **Create Revision** (새 버전 만들기) — a new version renders and plays.
- **Export** (and Export As-is) — file saves; the staged-only / "not in
  render" labelling is honest about which params the Python path applies.

## 7. Disable + re-confirm default

- Click **Disable Realtime Preview** → reload → chip returns to
  **"Realtime off — changes are staged…"**. Confirm the app behaves exactly
  as before realtime (re-render preview path unchanged).

---

## Automated coverage (run before device QA)

- `pnpm typecheck`
- `pnpm build:renderer` · `pnpm build:main` · `pnpm build-storybook`
- `cargo test -p loui-dsp --lib` (incl. imager mono/NaN/clamp + chain
  output-safety tests)
- `pnpm test:realtime-graph` · `pnpm test:realtime-config`
- `pnpm test` + module/revision/preset/gr-meter/eq-drag/export-support
  selftests (regression).
