// Find the plugins already installed on this machine.
//
// Every host starts here, and it is the part that has to work before anything
// else about third-party support means anything: you cannot load what you
// cannot find, and an engineer's plugins are wherever their installers put
// them, which is a different place on each platform and for each format.
//
// Scanning is deliberately shallow — bundle layout and metadata only, no
// loading of any code.  Loading a plugin means running someone else's binary
// inside your process, and that has to be a decision the user makes about one
// plugin, not a side effect of opening a folder.
//
// The path and parsing logic is pure so it can be tested against every
// platform's layout from any platform.

import fs from 'node:fs';
import path from 'node:path';

export type PluginFormat = 'vst3' | 'au' | 'vst2' | 'clap';

export interface ScannedPlugin {
  /** Stable across runs and machines-with-the-same-install. */
  id: string;
  name: string;
  vendor: string;
  format: PluginFormat;
  /** Absolute path of the bundle or library. */
  path: string;
  /** What the plugin calls itself: VST3 class id, or AU type/subtype/manu. */
  uid: string;
  /** 'effect' or 'instrument', where the metadata says. */
  kind: 'effect' | 'instrument' | 'unknown';
}

export interface ScanResult {
  plugins: ScannedPlugin[];
  /** Directories that were looked in, so a user can see why nothing appeared. */
  searched: string[];
  /** Bundles that were found but could not be read. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Extension → format.  A bundle's suffix is how every host identifies it. */
export function formatOf(entry: string): PluginFormat | null {
  const lower = entry.toLowerCase();
  if (lower.endsWith('.vst3')) return 'vst3';
  if (lower.endsWith('.component')) return 'au';
  if (lower.endsWith('.clap')) return 'clap';
  if (lower.endsWith('.vst') || lower.endsWith('.dll')) return 'vst2';
  return null;
}

/**
 * Where each platform's installers put plugins.
 *
 * Both the system-wide and the per-user location for every format, because
 * plugins land in either depending on how the installer was run, and a host
 * that only looks in one of them looks broken.
 */
export function pluginSearchPaths(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'darwin') {
    const roots = ['/Library/Audio/Plug-Ins', path.join(home, 'Library/Audio/Plug-Ins')];
    return roots.flatMap((root) => [
      path.join(root, 'VST3'),
      path.join(root, 'Components'),      // Audio Units
      path.join(root, 'CLAP'),
      path.join(root, 'VST'),
    ]);
  }

  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const common = process.env['CommonProgramFiles'] ?? path.join(programFiles, 'Common Files');
    return [
      path.join(common, 'VST3'),
      path.join(common, 'CLAP'),
      path.join(programFiles, 'VSTPlugins'),
      path.join(programFiles, 'Steinberg', 'VSTPlugins'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Common', 'VST3'),
    ];
  }

  return [
    '/usr/lib/vst3',
    '/usr/local/lib/vst3',
    path.join(home, '.vst3'),
    '/usr/lib/clap',
    '/usr/local/lib/clap',
    path.join(home, '.clap'),
  ];
}

/** Bundle file name → something a person would recognise. */
export function displayNameFromPath(bundlePath: string): string {
  const base = path.basename(bundlePath);
  return base.replace(/\.(vst3|component|clap|vst|dll)$/i, '');
}

// ── Metadata ────────────────────────────────────────────────────────────────

interface ModuleInfoClass {
  name?: string;
  category?: string;
  cid?: string;
  vendor?: string;
  subCategories?: string[];
}

interface ModuleInfo {
  Name?: string;
  Version?: string;
  Factory_Info?: { Vendor?: string };
  Classes?: ModuleInfoClass[];
}

/**
 * VST 3.7 ships a `moduleinfo.json` inside the bundle listing every class it
 * exports.  When it is there it is the best source there is — the plugin's own
 * statement of what it contains, with no code run.
 */
export function parseModuleInfo(
  raw: string, bundlePath: string,
): Omit<ScannedPlugin, 'id'>[] {
  let parsed: ModuleInfo;
  try { parsed = JSON.parse(raw) as ModuleInfo; }
  catch { return []; }

  const vendor = parsed.Factory_Info?.Vendor ?? '';
  const classes = Array.isArray(parsed.Classes) ? parsed.Classes : [];

  return classes
    // Only audio processors: a bundle also exports its editor and controller
    // classes, and those are not things to put in a channel.
    .filter((entry) => (entry.category ?? '').includes('Audio Module Class'))
    .map((entry) => ({
      name: entry.name?.trim() || displayNameFromPath(bundlePath),
      vendor: entry.vendor?.trim() || vendor,
      format: 'vst3' as const,
      path: bundlePath,
      uid: entry.cid ?? '',
      kind: (entry.subCategories ?? []).some((c) => /Instrument|Synth/i.test(c))
        ? ('instrument' as const)
        : ('effect' as const),
    }));
}

interface AudioComponentEntry {
  name?: string;
  manufacturer?: string;
  subtype?: string;
  type?: string;
  description?: string;
}

/**
 * An Audio Unit declares itself in its Info.plist under `AudioComponents`.
 *
 * The `name` there is conventionally "Vendor: Plugin", which is where both
 * halves come from.
 */
export function parseAudioComponents(
  raw: string, bundlePath: string,
): Omit<ScannedPlugin, 'id'>[] {
  let parsed: { AudioComponents?: AudioComponentEntry[] };
  try { parsed = JSON.parse(raw) as { AudioComponents?: AudioComponentEntry[] }; }
  catch { return []; }

  const components = Array.isArray(parsed.AudioComponents) ? parsed.AudioComponents : [];
  return components.map((entry) => {
    const full = entry.name?.trim() ?? '';
    const colon = full.indexOf(':');
    const vendor = entry.manufacturer && colon < 0
      ? entry.manufacturer
      : (colon >= 0 ? full.slice(0, colon).trim() : '');
    const name = colon >= 0 ? full.slice(colon + 1).trim() : (full || displayNameFromPath(bundlePath));

    return {
      name: name || displayNameFromPath(bundlePath),
      vendor,
      format: 'au' as const,
      path: bundlePath,
      // type/subtype/manufacturer is how AudioComponentFindNext identifies one.
      uid: [entry.type, entry.subtype, entry.manufacturer].filter(Boolean).join('-'),
      // 'aumu' is a music device — an instrument.  'aufx'/'aumf' are effects.
      kind: entry.type === 'aumu' ? ('instrument' as const) : ('effect' as const),
    };
  });
}

/**
 * A stable identity for a scanned plugin.
 *
 * The uid when the plugin gives one, because that survives the user moving
 * their plugin folder; the path only as a fallback, so a plugin with no
 * readable metadata is still usable.
 */
export function pluginId(entry: Omit<ScannedPlugin, 'id'>): string {
  return entry.uid
    ? `${entry.format}:${entry.uid}`
    : `${entry.format}:path:${entry.path}`;
}

// ── The scan ────────────────────────────────────────────────────────────────

/** Read a file, or null.  A plugin that will not open is skipped, not fatal. */
function readIfPresent(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Read a possibly-binary Info.plist.
 *
 * macOS plists are often the binary format, which is not JSON and not XML.
 * `plutil` is part of the OS and converts one without loading any plugin code,
 * which is the whole point: identify the plugin without running it.
 */
function readPlistAsJson(
  file: string, run: (bin: string, args: string[]) => string | null,
): string | null {
  const direct = readIfPresent(file);
  if (direct && direct.trimStart().startsWith('{')) return direct;
  return run('plutil', ['-convert', 'json', '-o', '-', file]);
}

export interface ScanOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Extra directories the user has added by hand. */
  extraPaths?: readonly string[];
  /** Injected so the scan is testable without a macOS toolchain. */
  runTool?: (bin: string, args: string[]) => string | null;
}

/** Walk the plugin folders and describe what is installed. */
export function scanPlugins(options: ScanOptions = {}): ScanResult {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (process.env['HOME'] ?? process.env['USERPROFILE'] ?? '');
  const runTool = options.runTool ?? (() => null);

  const searched = [...pluginSearchPaths(platform, home), ...(options.extraPaths ?? [])];
  const plugins: ScannedPlugin[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const dir of searched) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }                       // not installed, or not readable

    for (const entry of entries) {
      const format = formatOf(entry.name);
      if (!format) continue;
      const full = path.join(dir, entry.name);

      const described = describeBundle(full, format, runTool);
      if (described.length === 0) {
        skipped.push({ path: full, reason: '메타데이터를 읽을 수 없습니다' });
        continue;
      }
      for (const one of described) {
        const id = pluginId(one);
        // The same plugin installed system-wide and per-user is one plugin.
        if (seen.has(id)) continue;
        seen.add(id);
        plugins.push({ id, ...one });
      }
    }
  }

  plugins.sort((a, b) => (a.vendor + a.name).localeCompare(b.vendor + b.name));
  return { plugins, searched, skipped };
}

/** What a single bundle contains, without loading any of its code. */
function describeBundle(
  bundlePath: string, format: PluginFormat,
  runTool: (bin: string, args: string[]) => string | null,
): Omit<ScannedPlugin, 'id'>[] {
  if (format === 'vst3') {
    const moduleInfo = readIfPresent(path.join(bundlePath, 'Contents', 'moduleinfo.json'))
      ?? readIfPresent(path.join(bundlePath, 'Contents', 'Resources', 'moduleinfo.json'));
    if (moduleInfo) {
      const parsed = parseModuleInfo(moduleInfo, bundlePath);
      if (parsed.length > 0) return parsed;
    }
    // Pre-3.7 bundles carry no manifest.  The name is still real information,
    // and the format and path are enough to load it later.
    return [{
      name: displayNameFromPath(bundlePath),
      vendor: '',
      format,
      path: bundlePath,
      uid: '',
      kind: 'unknown',
    }];
  }

  if (format === 'au') {
    const plist = readPlistAsJson(path.join(bundlePath, 'Contents', 'Info.plist'), runTool);
    if (plist) {
      const parsed = parseAudioComponents(plist, bundlePath);
      if (parsed.length > 0) return parsed;
    }
    return [];
  }

  // CLAP and VST2 declare nothing on disk; both need the binary opened to say
  // anything more, which this scan does not do.
  return [{
    name: displayNameFromPath(bundlePath),
    vendor: '',
    format,
    path: bundlePath,
    uid: '',
    kind: 'unknown',
  }];
}
