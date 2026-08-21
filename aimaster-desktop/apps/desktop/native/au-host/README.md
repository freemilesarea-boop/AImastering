# `@loui/au-host` — the Audio Unit adapter

> ## ⚠️ NOT BUILT, NOT RUN, NOT VERIFIED
>
> Everything in this directory was written on Linux. AudioToolbox is macOS-only,
> so **not one line of it has been compiled or executed.** Nothing above it
> depends on that: the app treats a missing or broken addon as "this build
> cannot host Audio Units" and refuses the format with that reason.
>
> The TypeScript half — `src/main/plugins/au-native.ts`, which validates
> everything this module returns — *is* tested, against a fake host that
> returns wrong lengths, NaNs, infinities and throws. Run
> `pnpm --filter @aimaster/desktop test:au`.
>
> Treat the C++ as a starting point that encodes the right architecture, not as
> working code. It needs a Mac, a build, and a real plugin before anyone should
> believe it.

## Why an Audio Unit and not a VST3

AU hosting uses Apple's own `AudioToolbox`, which ships with the OS. There is
no third-party SDK and no licence to negotiate. VST3 needs an agreement with
Steinberg before a commercial closed-source app can ship a line of it — which
is why `vst3-licence` is still the one unmet requirement in
`external-host.ts` and why AU went first.

## Building on a Mac

```bash
cd native/au-host
npm install            # node-addon-api + node-gyp
npx node-gyp rebuild   # produces build/Release/au_host.node
```

Then make it resolvable as `@loui/au-host` — link it, or point the package's
`main` at the built `.node`. `loadAuHost()` requires that specifier and
treats every failure the same way: no AU hosting in this build.

## Checking it against a real plugin

The point is not "it compiled". The point is that a bounce with a plugin in it
sounds like the plugin. In order:

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
