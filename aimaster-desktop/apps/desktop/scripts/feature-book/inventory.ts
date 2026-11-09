/** Dump the machine-readable feature surface for the feature book. */
import { writeFileSync } from 'node:fs';
import { SHORTCUTS, BINDINGS, GROUP_TITLES } from '../../src/renderer/shortcuts/definitions.js';
import { LESSONS } from '../../src/renderer/shortcuts/lesson-plan.js';
import { KEYMAP_PRESETS } from '../../src/renderer/shortcuts/keymap-presets.js';
import { PLUGINS } from '../../src/renderer/daw/engine/plugins.js';
import { INSTRUMENTS } from '../../src/renderer/daw/engine/instruments.js';
import { COURSE_TEMPLATES } from '../../src/renderer/daw/model/course-templates.js';

const out = {
  groups: GROUP_TITLES,
  commands: SHORTCUTS.map((d) => ({
    id: d.id, group: d.group, label: d.label, chords: d.chords,
    note: d.note ?? '', available: d.available !== false,
  })),
  bindingCount: BINDINGS.length,
  lessons: LESSONS.map((l) => ({ stage: l.stage, title: l.title, commands: l.commands })),
  presets: KEYMAP_PRESETS.map((p) => ({ id: p.id, label: p.label, bindings: Object.keys(p.bindings).length })),
  plugins: PLUGINS.map((p) => ({
    id: p.id, name: p.name,
    params: p.params.map((q) => ({ id: q.id, name: q.name, min: q.min, max: q.max, default: q.default, unit: q.unit })),
  })),
  instruments: INSTRUMENTS.map((i) => ({ id: i.id, name: i.name, params: i.params?.length ?? 0 })),
  courseTemplates: COURSE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, note: t.note, tempoBpm: t.tempoBpm,
    tracks: t.tracks.length, buses: t.buses, groups: t.groups.length, markers: t.markers.length,
  })),
};
writeFileSync(process.argv[2]!, `${JSON.stringify(out, null, 2)}\n`);
console.log(`commands ${out.commands.length} · bindings ${out.bindingCount}`
  + ` · plugins ${out.plugins.length} · instruments ${out.instruments.length}`
  + ` · lessons ${out.lessons.length} · presets ${out.presets.length}`
  + ` · templates ${out.courseTemplates.length}`);
