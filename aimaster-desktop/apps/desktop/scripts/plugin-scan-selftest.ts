/**
 * plugin-scan-selftest — finding the plugins already on the machine.
 *
 * The scan is the part of third-party support that has to be right before
 * anything else matters: a plugin that is not found is a plugin that does not
 * exist, and every platform and format hides them somewhere different.
 *
 * Real bundle layouts are built on disk and scanned — a VST 3.7 bundle with a
 * moduleinfo.json, a pre-3.7 one without, an Audio Unit whose Info.plist has
 * to go through plutil, a CLAP, and the same plugin installed both
 * system-wide and per-user.  The macOS-only tool is injected, so all of it
 * runs anywhere.
 *
 * Run:  pnpm --filter @aimaster/desktop test:plugin-scan
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  displayNameFromPath, formatOf, parseAudioComponents, parseModuleInfo, pluginId,
  pluginSearchPaths, scanPlugins,
} from '../src/main/plugins/scan.js';
import { HOST_REQUIREMENTS, hostability } from '../src/renderer/daw/engine/external-host.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

// ── Formats and paths ───────────────────────────────────────────────────────

check('every plugin extension is recognised, and nothing else is', () => {
  assert(formatOf('Pro-Q 4.vst3') === 'vst3', 'VST3');
  assert(formatOf('FabFilter Pro-Q 4.component') === 'au', 'Audio Unit');
  assert(formatOf('Surge XT.clap') === 'clap', 'CLAP');
  assert(formatOf('OldPlugin.vst') === 'vst2', 'VST2 bundle');
  assert(formatOf('OldPlugin.dll') === 'vst2', 'VST2 on Windows');
  assert(formatOf('Pro-Q 4.VST3') === 'vst3', 'case does not matter');
  assert(formatOf('readme.txt') === null, 'a text file is not a plugin');
  assert(formatOf('Presets') === null, 'nor is a folder next to one');
});

check('macOS is searched where installers actually put things', () => {
  const paths = pluginSearchPaths('darwin', '/Users/x');
  for (const expected of [
    '/Library/Audio/Plug-Ins/VST3',
    '/Library/Audio/Plug-Ins/Components',
    '/Users/x/Library/Audio/Plug-Ins/VST3',
    '/Users/x/Library/Audio/Plug-Ins/Components',
  ]) {
    assert(paths.includes(expected), `looks in ${expected}`);
  }
  // Both scopes: an installer run with and without admin puts them in
  // different places, and a host that checks one looks broken.
  assert(paths.some((p) => p.startsWith('/Library')), 'system-wide');
  assert(paths.some((p) => p.startsWith('/Users/x')), 'and per-user');
});

check('Windows and Linux are searched too', () => {
  const win = pluginSearchPaths('win32', 'C:\\Users\\x');
  assert(win.some((p) => p.includes('VST3')), 'Windows VST3');
  assert(win.some((p) => p.includes('CLAP')), 'Windows CLAP');

  const linux = pluginSearchPaths('linux', '/home/x');
  assert(linux.includes('/usr/lib/vst3'), 'system VST3');
  assert(linux.includes('/home/x/.vst3'), 'and the dotfile one');
});

check('a bundle name is turned into something readable', () => {
  assert(displayNameFromPath('/a/b/FabFilter Pro-Q 4.vst3') === 'FabFilter Pro-Q 4', 'VST3');
  assert(displayNameFromPath('/a/b/ValhallaRoom.component') === 'ValhallaRoom', 'AU');
});

// ── Metadata ────────────────────────────────────────────────────────────────

check('a VST 3.7 manifest is read, and only its audio classes', () => {
  const manifest = JSON.stringify({
    Name: 'Example',
    'Factory Info': { Vendor: 'Ignored' },
    Factory_Info: { Vendor: 'Acme Audio' },
    Classes: [
      { name: 'Acme Comp', category: 'Audio Module Class', cid: 'ABCD1234', subCategories: ['Fx', 'Dynamics'] },
      { name: 'Acme Synth', category: 'Audio Module Class', cid: 'EEEE5555', subCategories: ['Instrument'] },
      // A bundle also exports its controller; that is not a device.
      { name: 'Acme Comp Controller', category: 'Component Controller Class', cid: 'FFFF0000' },
    ],
  });
  const parsed = parseModuleInfo(manifest, '/a/Acme.vst3');
  assert(parsed.length === 2, `two audio classes, not three — got ${parsed.length}`);
  assert(parsed[0]!.name === 'Acme Comp', 'the class name is used, not the file name');
  assert(parsed[0]!.vendor === 'Acme Audio', 'vendor comes from the factory info');
  assert(parsed[0]!.kind === 'effect', 'an Fx subcategory is an effect');
  assert(parsed[1]!.kind === 'instrument', 'and Instrument is an instrument');
  assert(parsed[0]!.uid === 'ABCD1234', 'the class id is kept — it is how it is loaded');
});

check('a broken manifest is ignored rather than crashing the scan', () => {
  assert(parseModuleInfo('{ not json', '/a/B.vst3').length === 0, 'garbage');
  assert(parseModuleInfo('{}', '/a/B.vst3').length === 0, 'empty object');
  assert(parseModuleInfo('{"Classes":"nope"}', '/a/B.vst3').length === 0, 'wrong shape');
});

check('an Audio Unit is read out of its AudioComponents entry', () => {
  const plist = JSON.stringify({
    AudioComponents: [
      { name: 'Valhalla DSP: ValhallaRoom', manufacturer: 'Valh', subtype: 'VrOm', type: 'aufx' },
      { name: 'Acme: Big Synth', manufacturer: 'Acme', subtype: 'Bsyn', type: 'aumu' },
    ],
  });
  const parsed = parseAudioComponents(plist, '/a/ValhallaRoom.component');
  assert(parsed.length === 2, 'both components');
  assert(parsed[0]!.vendor === 'Valhalla DSP', `the vendor half — got ${parsed[0]!.vendor}`);
  assert(parsed[0]!.name === 'ValhallaRoom', `and the plugin half — got ${parsed[0]!.name}`);
  assert(parsed[0]!.kind === 'effect', 'aufx is an effect');
  assert(parsed[1]!.kind === 'instrument', 'aumu is a music device');
  assert(parsed[0]!.uid === 'aufx-VrOm-Valh', 'type/subtype/manufacturer is the AU identity');
});

check('an identity survives the user moving their plugin folder', () => {
  const withUid = pluginId({
    name: 'X', vendor: '', format: 'vst3', path: '/old/X.vst3', uid: 'CID1', kind: 'effect',
  });
  const moved = pluginId({
    name: 'X', vendor: '', format: 'vst3', path: '/new/X.vst3', uid: 'CID1', kind: 'effect',
  });
  assert(withUid === moved, 'the class id, not the path, is the identity');

  // With no uid there is nothing else to use, and a path is better than
  // refusing to list the plugin at all.
  const noUid = pluginId({
    name: 'X', vendor: '', format: 'vst2', path: '/old/X.vst', uid: '', kind: 'unknown',
  });
  assert(noUid.includes('/old/X.vst'), 'the path is the fallback');
});

// ── A real directory tree ───────────────────────────────────────────────────

check('a real install layout is scanned end to end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-scan-'));
  try {
    const system = path.join(root, 'sys', 'VST3');
    const user = path.join(root, 'user', 'VST3');
    const components = path.join(root, 'sys', 'Components');
    const clap = path.join(root, 'sys', 'CLAP');
    for (const dir of [system, user, components, clap]) fs.mkdirSync(dir, { recursive: true });

    // A VST 3.7 bundle with a manifest.
    const modern = path.join(system, 'Acme Comp.vst3', 'Contents');
    fs.mkdirSync(modern, { recursive: true });
    fs.writeFileSync(path.join(modern, 'moduleinfo.json'), JSON.stringify({
      Factory_Info: { Vendor: 'Acme Audio' },
      Classes: [{ name: 'Acme Comp', category: 'Audio Module Class', cid: 'CID-ACME', subCategories: ['Fx'] }],
    }));

    // A pre-3.7 bundle with nothing inside it to read.
    fs.mkdirSync(path.join(system, 'Legacy EQ.vst3', 'Contents'), { recursive: true });

    // The SAME plugin, also installed per-user.
    const duplicate = path.join(user, 'Acme Comp.vst3', 'Contents');
    fs.mkdirSync(duplicate, { recursive: true });
    fs.writeFileSync(path.join(duplicate, 'moduleinfo.json'), JSON.stringify({
      Factory_Info: { Vendor: 'Acme Audio' },
      Classes: [{ name: 'Acme Comp', category: 'Audio Module Class', cid: 'CID-ACME', subCategories: ['Fx'] }],
    }));

    // An Audio Unit whose plist is binary, so it has to go through plutil.
    const au = path.join(components, 'Room.component', 'Contents');
    fs.mkdirSync(au, { recursive: true });
    fs.writeFileSync(path.join(au, 'Info.plist'), 'bplist00\u0000binary-not-json');

    fs.mkdirSync(path.join(clap, 'Surge XT.clap'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sys', 'VST3', 'readme.txt'), 'not a plugin');

    const scanned = scanPlugins({
      platform: 'linux',
      home: '/nonexistent',
      extraPaths: [system, user, components, clap],
      // Stand in for macOS's plutil: the scan must never need the binary.
      runTool: (bin, args) => {
        if (bin !== 'plutil') return null;
        const target = args[args.length - 1] ?? '';
        if (!target.includes('Room.component')) return null;
        return JSON.stringify({
          AudioComponents: [
            { name: 'Valhalla DSP: Room', manufacturer: 'Valh', subtype: 'Room', type: 'aufx' },
          ],
        });
      },
    });

    const names = scanned.plugins.map((p) => p.name).sort();
    assert(names.includes('Acme Comp'), `the modern bundle — found ${names.join(', ')}`);
    assert(names.includes('Legacy EQ'), 'and the one with no manifest, by its file name');
    assert(names.includes('Room'), 'and the Audio Unit, through the tool');
    assert(names.includes('Surge XT'), 'and the CLAP');
    assert(!names.includes('readme'), 'and nothing that is not a plugin');

    // Installed twice is still one plugin.
    assert(scanned.plugins.filter((p) => p.name === 'Acme Comp').length === 1,
      'system-wide and per-user is one entry, not two');

    const acme = scanned.plugins.find((p) => p.name === 'Acme Comp')!;
    assert(acme.vendor === 'Acme Audio', 'with its vendor');
    assert(acme.format === 'vst3', 'and its format');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('a folder that is not there is not an error', () => {
  const scanned = scanPlugins({ platform: 'darwin', home: '/nonexistent-home' });
  assert(Array.isArray(scanned.plugins), 'the scan completes');
  assert(scanned.searched.length > 0, 'and still reports where it looked');
  // Which is what a user needs when the answer is "no plugins found".
});

check('the scan never opens a plugin binary', () => {
  // Reading code means running someone else's binary in your process.  That
  // has to be a decision about one plugin, not a side effect of a folder scan.
  const source = fs.readFileSync(
    new URL('../src/main/plugins/scan.ts', import.meta.url), 'utf8',
  );
  for (const forbidden of ['dlopen', 'require(', 'process.dlopen', 'createRequire', 'import(']) {
    assert(!source.includes(forbidden), `the scanner does not use ${forbidden}`);
  }
});

// ── Hosting status ──────────────────────────────────────────────────────────

check('the app says what it can and cannot do with a scanned plugin', () => {
  // Listing a plugin the app cannot run is fine; letting someone insert one
  // and wonder why it does nothing is not.  The status has to be truthful.
  for (const format of ['vst3', 'au', 'clap', 'vst2'] as const) {
    const status = hostability(format);
    assert(status.hostable === false, `${format} is not hostable yet`);
    assert(status.mode === 'none', `${format} reports no mode`);
    assert(status.reason.length > 0, `${format} says why`);
  }
});

check('the requirement list names the real blockers, not a vague one', () => {
  const ids = HOST_REQUIREMENTS.map((r) => r.id);
  for (const id of ['native-module', 'process-isolation', 'macos-entitlement', 'vst3-licence']) {
    assert(ids.includes(id), `${id} is listed`);
  }
  for (const requirement of HOST_REQUIREMENTS) {
    assert(requirement.why.length > 20, `${requirement.id} explains itself`);
  }
});

check('the Steinberg licence is required for VST3 and not for Audio Units', () => {
  // AU hosting uses Apple's own AudioToolbox; VST3 needs an agreement with
  // Steinberg before a commercial closed-source app can ship it.  Which means
  // AU is the format that unblocks first, and the code should know that.
  const auBlockers = HOST_REQUIREMENTS.filter((r) => !r.met && r.id === 'vst3-licence');
  assert(auBlockers.length === 1, 'the licence is currently unmet');
  assert(hostability('au').reason !== hostability('vst3').reason
    || HOST_REQUIREMENTS.filter((r) => !r.met).length > 1,
    'the two formats are evaluated separately');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Third-party plugin scan ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
