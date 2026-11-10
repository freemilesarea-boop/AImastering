/** Dump the machine-readable feature surface for the feature book. */
import { writeFileSync } from 'node:fs';
import { SHORTCUTS, BINDINGS, GROUP_TITLES } from '../../src/renderer/shortcuts/definitions.js';
import { PLUGINS } from '../../src/renderer/daw/engine/plugins.js';
import { INSTRUMENTS } from '../../src/renderer/daw/engine/instruments.js';

const out = {
  groups: GROUP_TITLES,
  commands: SHORTCUTS.map((d) => ({
    id: d.id, group: d.group, label: d.label, chords: d.chords,
    note: d.note ?? '', available: d.available !== false,
  })),
  bindingCount: BINDINGS.length,
  plugins: PLUGINS.map((p) => ({
    id: p.id, name: p.name,
    params: p.params.map((q) => ({ id: q.id, name: q.name, min: q.min, max: q.max, default: q.default, unit: q.unit })),
  })),
  instruments: INSTRUMENTS.map((i) => ({ id: i.id, name: i.name, params: i.params?.length ?? 0 })),
};
writeFileSync(process.argv[2]!, `${JSON.stringify(out, null, 2)}\n`);
console.log(`commands ${out.commands.length} · bindings ${out.bindingCount}`
  + ` · plugins ${out.plugins.length} · instruments ${out.instruments.length}`);
