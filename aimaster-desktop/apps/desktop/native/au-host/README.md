# `@loui/au-host` — the Audio Unit adapter

> ## ⚠️ BUILT AND RUN — BUT NOT AGAINST APPLE'S FRAMEWORK
>
> `src/au_host.mm` is compiled and executed on every test run, against a fake
> CoreAudio in [`test/`](test) that keeps the parts of the contract that bite.
> Run `pnpm --filter @aimaster/desktop test:au-native`.
>
> What that does **not** answer is whether the API is the API — a struct field
> with the wrong name, an argument in the wrong order, a constant that does not
> exist. Only a Mac can say. [`.github/workflows/au-host-macos.yml`](../../../../.github/workflows/au-host-macos.yml)
> builds this same source against the real AudioToolbox on `macos-latest` and
> runs [`test/au-host-mac-smoke.mjs`](test/au-host-mac-smoke.mjs) against the
> Audio Units Apple ships. **Until that job has gone green on a change, treat
> the change as unproven on macOS.**
>
> Nothing above this depends on either: the app treats a missing or broken
> addon as "this build cannot host Audio Units" and refuses the format with
> that reason.

## What compiling it found

Neither of these was visible by reading, and both killed the whole host
process on the first run:

- **A channel count of `-1`** became four billion on the cast to `UInt32`,
  `std::vector::resize` threw `std::bad_alloc`, and exceptions are off in this
  build — so `terminate()`. An *argument* must never be able to do that; the
  entire isolation story is that a bad plugin fails alone.
- **A buffer that was not a `Float32Array`** left `As<Float32Array>()` with an
  N-API exception pending. The next throw — the correct one, with the correct
  message — then became `FATAL ERROR: napi_throw` and took the process with
  it. The type check has to come *first* or it is not a check.

Two more were not in the C++ at all, and both meant that a successful build
still could not be loaded by the app:

- **`node-gyp rebuild` built for the wrong runtime.** See *Building on a Mac*
  below.

- **`require('@loui/au-host')` could never resolve.** Nothing linked the
  package, `native/au-host` is outside the pnpm workspace globs, and it was
  not a dependency of anything — so on a Mac, after a successful build,
  `hasAuHost()` was still false and the plugin manager still showed the
  `native-module` blocker. `auCandidates()` in
  `src/main/plugins/au-native.ts` now looks where the build actually puts the
  file, and `electron-builder.yml` ships it in `extraResources` — outside
  `app.asar`, because `dlopen` needs a real path on disk.

A build whose output nothing can load is not a build. That is why the blocker
row now prints every path that was tried and what each one said, instead of
just "not met".

## Why an Audio Unit and not a VST3

AU hosting uses Apple's own `AudioToolbox`, which ships with the OS. There is
no third-party SDK and no licence to negotiate. VST3 needs an agreement with
Steinberg before a commercial closed-source app can ship a line of it — which
is why `vst3-licence` is still the one unmet requirement in
`external-host.ts` and why AU went first.

## Building on a Mac

```bash
pnpm --filter @aimaster/desktop build:au        # for the app
pnpm --filter @aimaster/desktop build:au:node   # for the smoke test below
```

Two builds, because they are for two different runtimes. Electron 28 is
`NODE_MODULE_VERSION` 119 and Node 22 is 127, so a plain `node-gyp rebuild`
produces an addon that loads in `node` and fails in the app — and the failure
arrives looking exactly like "the addon is missing". `scripts/build-au.mjs`
passes Electron's headers by default and takes `--for-node` for the one thing
that runs outside Electron.

That is all. `auCandidates()` already looks in `build/Release`, so nothing has
to be linked into `node_modules` for a dev checkout to pick it up — and
`electron-builder.yml` copies the same file into the packaged app's
`Resources/au-host/`. `loadAuHost()` tries each place in turn and keeps what
went wrong at every one of them; `plugins:capabilities` passes that list to
the renderer, so the `native-module` blocker says where it looked instead of
just "not met".

## Checking it against a real plugin

The point is not "it compiled". The point is that a bounce with a plugin in it
sounds like the plugin. Steps 1–4 below are what `test/au-host-mac-smoke.mjs`
does, so the CI job checks them on every change; the list is kept here because
the reasoning is the part worth reading. In order:

1. **It opens.** `plugins:capabilities` should report `auHost: true`, and the
   plugin manager's blocker list should lose the `native-module` row by
   itself — nothing is hand-edited to make that happen.
2. **It changes the audio.** Put Apple's own `AUPeakLimiter` on a track, bounce,
   and confirm the peak moved. Apple's units are the right first target: they
   are installed on every Mac and they are not going to be the buggy one.
3. **Parameters land.** Set a threshold, bounce, measure. `planParameters`
   matches by NAME rather than by the AU's private parameter ids, so a preset
   survives a plugin update — and reports the names it could not match instead
   of dropping them.
4. **A bad plugin fails alone.** Put a known-hostile or beta plugin third in a
   chain of five. That stage should come back `applied: false` with a reason
   and the other four should still be applied. If the whole bounce dies, the
   isolation is not doing its job.

## What the module must expose

```ts
open(uid: string, sampleRate: number, channels: number): number
parameters(handle: number): Array<{ id: number; name: string; min: number; max: number }>
setParameter(handle: number, id: number, value: number): void
process(handle: number, samples: Float32Array, frames: number): number
close(handle: number): void
```

`uid` is `type-subtype-manufacturer` — the triple `AudioComponentFindNext`
matches on, and exactly the string the scanner already read out of the bundle's
`Info.plist`. That is why the app never opens a plugin binary to find out what
is inside it.

`process` works **in place** on interleaved float32 and returns the number of
frames it wrote. Returning anything other than `frames` is treated as a
failure by the caller, on purpose: a plugin that decided to write a different
amount is a plugin whose output nobody can line up.
