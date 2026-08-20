// An installed plugin, described the way the engine describes its own devices.
//
// The chain builder, the insert rack and the plugin window all ask a device
// what it is called and what it can do.  An external plugin has to answer the
// same questions, so it gets a descriptor like any other — one that is
// `offline`, because the realtime graph is Web Audio and cannot call native
// code, and whose live processing is a wire straight through.
//
// Built from the insert rather than looked up in a registry.  A registry would
// need populating at load, at import, at undo, and at every other moment a
// session gains an insert, and the first one anybody forgot would be a device
// that silently vanished from a channel.  The insert already carries
// everything, so nothing can fall out of sync.

import { withBypass, type PluginDescriptor } from './plugin-kit.js';
import { findPlugin } from './plugins.js';
import type { ExternalPluginRef, Insert } from '../model/types.js';

/** The device this app defines to prove the host pipeline end to end. */
export const REFERENCE_PLUGIN: ExternalPluginRef = {
  format: 'reference',
  path: '',
  uid: 'reference-gain',
  name: 'Reference Gain (호스트 테스트)',
  vendor: 'LOUI',
};

export const REFERENCE_PLUGIN_ID = 'reference:reference-gain';

/**
 * Parameters an external device exposes.
 *
 * The reference device has its own, because it is ours.  A real plugin's
 * parameters live inside its binary, so until an adapter can read them there
 * is nothing honest to show — and inventing knobs that go nowhere would be
 * worse than an empty panel.
 */
export function externalParams(ref: ExternalPluginRef): PluginDescriptor['params'] {
  if (ref.uid === REFERENCE_PLUGIN.uid) {
    return [
      { id: 'gainDb', name: 'Gain', min: -24, max: 24, default: 0, unit: 'dB' },
      { id: 'invert', name: 'Invert', min: 0, max: 1, default: 0, unit: '' },
    ];
  }
  return [];
}

/** A descriptor for an installed plugin, for every part of the app that asks. */
export function externalDescriptor(pluginId: string, ref: ExternalPluginRef): PluginDescriptor {
  return {
    id: pluginId,
    name: ref.name,
    category: 'external',
    // The whole point: it cannot run live, so the chain shows it as OFFLINE
    // and the render path applies it.
    offline: true,
    hasSidechain: false,
    params: externalParams(ref),
    latencyFor: () => 0,
    // Live, it is a wire.  The audio has to reach the fader unchanged so the
    // rest of the channel still works while the device waits for a bounce.
    create: (ctx) => withBypass(ctx, (input, output) => {
      input.connect(output);
      return { setParam: () => { /* applied by the host, not here */ } };
    }),
  };
}

/**
 * What device this insert is — ours or someone else's.
 *
 * Every call site that used `findPlugin(insert.pluginId)` should use this
 * instead: an external insert has no entry in the registry, and returning
 * undefined for one makes the slot disappear from the channel.
 */
export function descriptorFor(insert: Insert): PluginDescriptor | undefined {
  if (insert.external) return externalDescriptor(insert.pluginId, insert.external);
  return findPlugin(insert.pluginId);
}
