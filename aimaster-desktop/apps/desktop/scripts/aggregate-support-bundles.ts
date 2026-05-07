/**
 * aggregate-support-bundles.ts — fold N support bundles from internal
 * testers into a single Markdown summary + CSV row dump.
 *
 * Usage:
 *   pnpm --filter @aimaster/desktop test:aggregate-bundles -- <dir>
 *   # or directly:
 *   tsx apps/desktop/scripts/aggregate-support-bundles.ts <dir>
 *
 * <dir> is a directory containing *.json files exported by testers via
 * Help → "지원 진단 내보내기" (the IPC `support:bundle-export` flow).
 *
 * Outputs to stdout:
 *   • A short YAML/Markdown header (tester count, build versions, OS mix)
 *   • A failure-category rollup (preview / worklet / ffmpeg / engine /
 *     export / pipeline / license / unknown)
 *   • The top 10 most frequent failure messages (path-redacted, so safe
 *     to paste into a tracker)
 *   • A per-tester row with worst-category + total failure count
 *
 * Pure logic + filesystem — no DSP, no audio engine.  Designed to be
 * runnable on a maintainer laptop with just `tsx` available.
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────
// Mirror the runtime shape from `main/utils/supportBundle.ts`.  We don't
// import the real types directly — we want this script to be tolerant of
// older bundles produced by earlier builds.

type AnyRecord = Record<string, unknown>;

interface Bundle extends AnyRecord {
  schemaVersion?: string;
  generatedAt?:   string;
  app?:           { name?: string; version?: string; isPackaged?: boolean };
  runtime?:       AnyRecord;
  failureCounts?: AnyRecord;
  recentFailures?: Array<{ category?: string; at?: string; message?: string }>;
  recentPipelineWarnings?: Array<{ code?: string; level?: string; userMessage?: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readBundle(file: string): Bundle | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Bundle;
  } catch (e) {
    process.stderr.write(`[skip] ${file}: ${(e as Error).message}\n`);
    return null;
  }
}

function tally<K extends string>(rows: K[]): Record<K, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r] = (out[r] ?? 0) + 1;
  return out as Record<K, number>;
}

function topN<K extends string>(t: Record<K, number>, n: number): Array<[K, number]> {
  return (Object.entries(t) as Array<[K, number]>).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ── Loader ──────────────────────────────────────────────────────────────────

function loadDir(dir: string): { file: string; bundle: Bundle }[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${dir}\n`);
    process.exit(2);
  }
  const out: { file: string; bundle: Bundle }[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const file   = path.join(dir, name);
    const bundle = readBundle(file);
    if (!bundle) continue;
    if (bundle.schemaVersion !== 'support-bundle/1') {
      process.stderr.write(`[warn] ${name}: unknown schemaVersion=${bundle.schemaVersion ?? '?'}\n`);
    }
    out.push({ file: name, bundle });
  }
  return out;
}

// ── Rollups ────────────────────────────────────────────────────────────────

interface AggregateInput {
  bundles: { file: string; bundle: Bundle }[];
}

interface CategoryRollup {
  category:    string;
  total:       number;
  affected:    number;   // bundles where this category > 0
  topMessages: Array<[string, number]>;
}

export function rollupByCategory(input: AggregateInput): CategoryRollup[] {
  const cats = ['preview','worklet','ffmpeg','engine','export','pipeline','license','unknown'] as const;
  const result: CategoryRollup[] = [];
  for (const cat of cats) {
    let total = 0;
    let affected = 0;
    const messages: string[] = [];
    for (const { bundle } of input.bundles) {
      const fails = (bundle.recentFailures ?? []).filter((f) => f?.category === cat);
      if (fails.length > 0) affected += 1;
      total += fails.length;
      for (const f of fails) messages.push(typeof f.message === 'string' ? f.message : '?');
    }
    result.push({
      category:    cat,
      total,
      affected,
      topMessages: topN(tally(messages), 5),
    });
  }
  return result;
}

export interface PerTesterRow {
  file:           string;
  appVersion:     string;
  platform:       string;
  arch:           string;
  totalFailures:  number;
  worstCategory:  string;
  pipelineCount:  number;
}

export function perTesterRows(input: AggregateInput): PerTesterRow[] {
  return input.bundles.map(({ file, bundle }) => {
    const fails = bundle.recentFailures ?? [];
    const byCat = tally(fails.map((f) => (typeof f.category === 'string' ? f.category : 'unknown')));
    const sorted = (Object.entries(byCat) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);
    const runtime = (bundle.runtime ?? {}) as AnyRecord;
    return {
      file,
      appVersion:    bundle.app?.version ?? '?',
      platform:      typeof runtime['platform'] === 'string' ? runtime['platform'] as string : '?',
      arch:          typeof runtime['arch']     === 'string' ? runtime['arch']     as string : '?',
      totalFailures: fails.length,
      worstCategory: sorted[0]?.[0] ?? '—',
      pipelineCount: (bundle.recentPipelineWarnings ?? []).length,
    };
  });
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderMarkdown(input: AggregateInput): string {
  const lines: string[] = [];
  const n = input.bundles.length;
  lines.push(`# v3.6 RC support-bundle aggregate`);
  lines.push('');
  lines.push(`Bundles ingested: **${n}**`);

  // Build header — version + OS mix
  const versions = tally(input.bundles.map((b) => b.bundle.app?.version ?? '?'));
  const platforms = tally(input.bundles.map((b) => {
    const r = (b.bundle.runtime ?? {}) as AnyRecord;
    return (typeof r['platform'] === 'string' ? r['platform'] as string : '?')
      + '/' + (typeof r['arch'] === 'string' ? r['arch'] as string : '?');
  }));
  lines.push(`Versions: ${Object.entries(versions).map(([v, c]) => `${v}×${c}`).join(', ') || '—'}`);
  lines.push(`Platforms: ${Object.entries(platforms).map(([p, c]) => `${p}×${c}`).join(', ') || '—'}`);
  lines.push('');

  // Category rollup
  lines.push('## Failure rollup');
  lines.push('');
  lines.push('| Category  | Total | Affected bundles | Top message |');
  lines.push('|-----------|------:|-----------------:|-------------|');
  const rollup = rollupByCategory(input);
  for (const r of rollup) {
    const top = r.topMessages[0]?.[0] ?? '—';
    const truncated = top.length > 70 ? top.slice(0, 67) + '…' : top;
    lines.push(`| ${pad(r.category, 9)} | ${r.total} | ${r.affected}/${n} | ${truncated.replace(/\|/g, '/')} |`);
  }
  lines.push('');

  // Top 10 raw messages across all categories
  const allMessages: string[] = [];
  for (const { bundle } of input.bundles) {
    for (const f of bundle.recentFailures ?? []) {
      if (typeof f.message === 'string') allMessages.push(`[${f.category ?? '?'}] ${f.message}`);
    }
  }
  const top10 = topN(tally(allMessages), 10);
  if (top10.length > 0) {
    lines.push('## Top 10 most-seen failure messages (path-redacted)');
    lines.push('');
    for (const [msg, count] of top10) {
      lines.push(`- (×${count}) ${msg.replace(/\n/g, ' ').slice(0, 200)}`);
    }
    lines.push('');
  }

  // Per-tester table
  lines.push('## Per-tester summary');
  lines.push('');
  lines.push('| Bundle file | App ver | OS / arch  | Failures | Worst cat | Pipeline warns |');
  lines.push('|-------------|---------|------------|---------:|-----------|---------------:|');
  for (const r of perTesterRows(input)) {
    lines.push(`| ${r.file} | ${r.appVersion} | ${r.platform}/${r.arch} | ${r.totalFailures} | ${r.worstCategory} | ${r.pipelineCount} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  // Skip a leading `--` that pnpm forwards from `pnpm run -- <arg>`.
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const arg  = argv[0];
  if (!arg || arg === '--help' || arg === '-h') {
    process.stderr.write(
      'usage: tsx apps/desktop/scripts/aggregate-support-bundles.ts <dir>\n' +
      '       <dir> contains *.json bundles exported via Help → 지원 진단.\n',
    );
    process.exit(arg ? 0 : 2);
  }
  const bundles = loadDir(path.resolve(arg));
  if (bundles.length === 0) {
    process.stderr.write('no bundles found\n');
    process.exit(2);
  }
  process.stdout.write(renderMarkdown({ bundles }) + '\n');
}

// Only run main() when executed as the entry script — not when imported
// from a unit test.  process.argv[1] holds the entry path (resolved).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main();
}
