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
