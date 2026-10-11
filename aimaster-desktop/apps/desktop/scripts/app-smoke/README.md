# app-smoke — drive one user flow through the real app

Every selftest in `scripts/` runs headless in node. That is most of the
value and it has a blind spot this directory exists to cover: a flow can be
green at every step and broken between them.

The reported bug was exactly that. Mix in the Studio, press 설정 저장, run the
mastering, get the original back. Each piece had a passing test — the config
was built, sent, and applicable; the loader resolved; the loudness stage
moved — and the flow was broken because the loader's path arithmetic was
right from `src/main/offline` (where tsx runs) and wrong from
`dist-electron/main` (where the app runs). No headless test could see it.

So: boot the real Electron app on a virtual display, attach over CDP, and
drive one flow from end to end, reporting what was observed at each step.

## Running it

    pnpm smoke:flow

Or by hand, which is what to do when a step fails and you want the app left
running to poke at:

    bash scripts/app-smoke/boot.sh /tmp/smoke 9333
    node scripts/app-smoke/flow.mjs 9333 /tmp/smoke

## Why it is not in `pnpm test`

It needs Xvfb, a vite dev server, an Electron binary and ffmpeg, and it
takes about a minute. The test chain has to stay something you run on every
change. Run this before a release, and after any change to the main
process, the IPC surface, or the render path — the three places a headless
test cannot follow.

## Two steps that exist for a reason worth stating

**"the saved move is still there after a reload."** Every other step proves
the save only within one page. `song-settings` writes into `localStorage`,
which the headless tests stub, so whether a real renderer hands the same
bytes back afterwards is a question only the real app can answer — and
"saved, came back, gone" is the reported bug's own wording. It reuses the
entry the save step wrote instead of making a second one, and it runs last,
because a reload throws away the store the steps before it built. Breaking
it is instructive: swap `store()` for an in-memory map and the save step
still passes while this one fails, which is the whole gap in one line.

**"every control can hold the value the app opens it with."**
`parameter-grid-selftest` checks the same invariant headlessly — but it
checks the definitions against the rule *as written down in that file*, so a
misreading of the rule would make both the code and its test wrong
together. This step asks the browser instead: it sets each of the 332
numeric controls to its own default and reads back what the control holds.
That is how the bus compressor's Attack was caught holding 10.1 where the
state said 10.

## What it does NOT do

It does not click pixels. A native file dialog cannot be driven headlessly,
so the flow calls the same store actions and IPC channels the buttons call
— `addFilesToQueue`, `audio:analyze`, `saveSongSettings`, `renderSong` —
and asserts the observable result of each. That makes it a flow test, not a
UI test: it would not catch a button wired to nothing. What it does catch is
everything between the store and the file on disk, which is where this
flow has actually broken.

The zustand stores are module singletons, so importing one in the page gets
the instance the app is rendering from. Step 2 checks that assumption
rather than trusting it.

---

## The packaged flow — `pnpm smoke:packaged`

`boot.sh` + `flow.mjs` drive a **dev** build: vite, the renderer's module
graph, source paths. Three defects got past all of it, because each lived
in a layer only packaging creates:

| what shipped | what the user got |
| --- | --- |
| `resources/bin/engine` absent | first `audio:analyze` → `spawn … ENOENT` |
| `resources/bin/engine` present, built with CI's own command | `ModuleNotFoundError: No module named 'backports'` on startup |
| the loader counting `../../../../../` to `pkg-node` | right from `src/main/offline`, one level too high from `dist-electron/main` — so every packaged build silently took the Python path |

So `boot-packaged.sh` + `flow-packaged.mjs` drive `out/linux-unpacked`
instead. It needs `pnpm dist` first.

**It copies the app out of the source tree before launching it, and that is
the point.** `wasmNodeCandidates()` walks *up* from the main bundle's
directory before it tries `process.resourcesPath`. `out/linux-unpacked`
sits inside the workspace, so a package launched in place resolves
`packages/dsp-wasm/pkg-node` — the dev copy — and the shipped
`resources/dsp-wasm-node` is never touched. The first run of this probe did
exactly that, and only a Rust panic's stack trace gave it away. The boot
script now walks the ancestors of the copy and refuses to start if any of
them holds a workspace, so the run cannot quietly become meaningless again.
`wasm-resolve-selftest` pins the ordering this depends on.

The render step is judged by the **output audio**, not by the handler's
`chainConfigHonored` flag. The flag records which branch ran, so it cannot
tell you the chain did anything: with the EQ bypassed the flag still reads
`honored=true` while the measurement reads `60 Hz +0.01 dB`. With the two
+6 dB shelves asked for, the file comes back `60 Hz +5.27 dB, 14 kHz
+4.41 dB` relative to 1 kHz — the 32 Hz low cut and the limiter taking the
rest.

What it cannot cover: macOS and Windows packages, which cannot be
cross-built here. On those hosts the prebuild gate falls back to checking
that the engine binary is *present* (`engineStatus` reports
`unverifiable`, and `pnpm dist` says so) because a `win32` binary cannot be
executed to ask whether it starts.
