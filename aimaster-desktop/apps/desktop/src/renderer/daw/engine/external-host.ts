// Hosting someone else's plugin: the contract, and what still blocks it.
//
// ── Why this is not simply "load the VST" ──────────────────────────────────
//
// A VST3 or an Audio Unit is a native binary.  Running one means executing
// third-party machine code, and every part of this app that could do that is
// deliberately unable to:
//
//   • The renderer runs with `sandbox: true` and no Node integration, so it
//     cannot load a native addon at all.  That is not an oversight — it is
//     what keeps a bug in the UI from being a bug with filesystem access.
//   • An AudioWorklet is further isolated still: it has no module loading, no
//     IPC, and no filesystem.  It is the only place with the audio clock.
//   • `SharedArrayBuffer` — how the disk streamer hands samples between the
//     reader thread and the audio thread — is shared between THREADS of one
//     process.  It cannot be mapped into another process, so the ring trick
//     that solved streaming does not reach a plugin host process.
//
// The main process can load native code.  So audio can reach a plugin, but
// only by leaving the realtime graph — which is exactly the case the engine
// already has a shape for.
//
// ── The shape that fits ────────────────────────────────────────────────────
//
// The engine already distinguishes devices that cannot run in the realtime
// graph: `PluginDescriptor.offline` marks them, they stay visible in the chain
// badged OFFLINE, and the render path applies them instead of the live one
// silently doing nothing.  A third-party plugin is that, exactly:
//
//   live monitoring   the plugin is bypassed; freeze the track to hear it
//   bounce / freeze   main runs the audio through the plugin and returns it
//
// The transport for that already exists too — the PCM store writes float32 to
// disk and the renderer reads it back over `aimaster-local://`.  A host pass is
// the same trip with a plugin in the middle.
//
// ── What is actually missing ───────────────────────────────────────────────
//
// One thing: a native module that can open a VST3 or AU bundle and process a
// block.  Everything above it — the scan, the model, the offline apply, the
// file transport — is ordinary code.  `HOST_REQUIREMENTS` below is the list a
// build of that module has to satisfy, kept here rather than in a document so
// it stays next to the code that will use it.

import type { PluginFormat } from '../../stores/externalPluginStore.js';

/** What a native host module must provide for a format to become usable. */
export interface HostRequirement {
  id: string;
  what: string;
  why: string;
  /** Whether this app currently satisfies it. */
  met: boolean;
}

export const HOST_REQUIREMENTS: readonly HostRequirement[] = [
  {
    id: 'native-module',
    what: 'VST3/AU 번들을 열고 블록을 처리하는 네이티브 모듈',
    why: '플러그인은 네이티브 바이너리라 JS 로는 열 수 없습니다. N-API 애드온이 메인 프로세스에 있어야 합니다',
    met: false,
  },
  {
    id: 'process-isolation',
    what: '플러그인을 앱과 분리된 자식 프로세스에서 실행',
    why: '서드파티 코드가 죽으면 앱이 같이 죽습니다. 세션 하나가 크래시하는 플러그인 하나 때문에 날아가면 안 됩니다',
    met: false,
  },
  {
    id: 'macos-entitlement',
    what: 'com.apple.security.cs.disable-library-validation 엔타이틀먼트',
    why: 'notarize 된 앱은 기본적으로 서명이 다른 dylib 을 못 올립니다. 이게 없으면 macOS 에서 어떤 플러그인도 로드되지 않습니다',
    met: false,
  },
  {
    id: 'vst3-licence',
    what: 'Steinberg VST3 SDK 라이선스',
    why: 'VST3 SDK 는 GPLv3 이거나 Steinberg 독점 라이선스입니다. 상용 클로즈드 소스 앱은 후자를 등록해야 합니다. AU 는 Apple AudioToolbox 라 해당 없습니다',
    met: false,
  },
];

export interface Hostability {
  hostable: boolean;
  /** Realtime, offline-only, or not at all. */
  mode: 'realtime' | 'offline' | 'none';
  reason: string;
}

/**
 * Can this app run this plugin, and how?
 *
 * Answered per format because the answers differ: an Audio Unit needs only
 * Apple's own framework, while VST3 needs a licence agreement before a line of
 * it can ship.  Written as a function of the requirement list so that turning
 * one `met: true` moves every plugin of that format at once, rather than
 * leaving a second place that also has to be remembered.
 */
export function hostability(format: PluginFormat): Hostability {
  const missing = HOST_REQUIREMENTS.filter((requirement) => {
    if (!requirement.met) {
      // The VST3 licence does not apply to Audio Units.
      if (requirement.id === 'vst3-licence') return format !== 'au';
      return true;
    }
    return false;
  });

  if (missing.length === 0) {
    // Even fully built, a third-party plugin is an offline device here: the
    // realtime graph is Web Audio and cannot call out to native code.
    return {
      mode: 'offline',
      hostable: true,
      reason: '바운스 · 프리즈에서 적용됩니다',
    };
  }

  return {
    mode: 'none',
    hostable: false,
    reason: `${missing[0]!.what} 필요`,
  };
}

/** Every format's current status, for the manager's summary. */
export function hostabilitySummary(): Array<{ format: PluginFormat; status: Hostability }> {
  return (['vst3', 'au', 'clap', 'vst2'] as const).map((format) => ({
    format, status: hostability(format),
  }));
}
