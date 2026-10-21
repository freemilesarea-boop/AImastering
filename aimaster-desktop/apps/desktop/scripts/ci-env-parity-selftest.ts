// ci-env-parity-selftest — do the three platform builds get the same config?
//
// They did not.  Measured on build.yml: `LICENSE_API_URL`, `LICENSE_API_KEY`,
// `LICENSE_HMAC_SECRET` and `PADDLE_CHECKOUT_URL` were injected in build-win
// only, so one tagged release shipped Windows on `RemoteValidator` with a real
// HMAC secret and Linux + macOS on `LocalValidator` with the DEV secret — with
// the packaged-only `assertLicenseSecretReady()` gate off on those two.
// Nothing user-visible while `LICENSE_ENFORCED` is off; three different
// licence behaviours the moment it is turned on.
//
// And `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` were injected NOWHERE, so
// `getSupabase()` returned null in every installer and the account /
// entitlement / device surface was inert — while all five edge functions it
// calls are deployed and ACTIVE.  A build-time variable the code reads and the
// workflow never sets fails silently and only in a release, which is the one
// place nobody runs a test.
//
// So this test reads both sides: the workflow, and the code that consumes
// build-time configuration.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const yaml = req('js-yaml') as { load(src: string): unknown };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..', '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'build.yml');

type Step = { name?: string; env?: Record<string, string>; run?: string; 'working-directory'?: string };
type Job = { steps?: Step[] };
const wf = yaml.load(fs.readFileSync(WORKFLOW, 'utf8')) as { jobs?: Record<string, Job> };
const jobs = wf.jobs ?? {};
const PLATFORM_JOBS = ['build-linux', 'build-mac', 'build-win'];

console.log('\n── the three platform builds ───────────────────────────────');

check(
  'build.yml parsed, with a job per platform',
  PLATFORM_JOBS.every((j) => Array.isArray(jobs[j]?.steps)),
  `jobs: ${Object.keys(jobs).join(', ')}`,
);

/** The env of the step that runs `pnpm build` in a job. */
function buildEnv(job: string): Record<string, string> | null {
  for (const step of jobs[job]?.steps ?? []) {
    if (typeof step.run === 'string' && /\bpnpm (-s )?build\b/.test(step.run)) return step.env ?? {};
  }
  return null;
}

const envs = new Map<string, Record<string, string>>();
for (const job of PLATFORM_JOBS) {
  const env = buildEnv(job);
  check(`${job} has a step that runs \`pnpm build\``, env !== null);
  if (env) envs.set(job, env);
}

const keySets = [...envs.entries()].map(([job, env]) => [job, Object.keys(env).sort()] as const);
const reference = keySets[0]?.[1] ?? [];
for (const [job, keys] of keySets.slice(1)) {
  const missing = reference.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !reference.includes(k));
  check(
    `${job} is given exactly what ${keySets[0]![0]} is given`,
    missing.length === 0 && extra.length === 0,
    [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
      .filter(Boolean).join('; '),
  );
}

console.log('\n── against what the code reads at build time ───────────────');

// esbuild bakes `process.env.X` through its `define`; vite bakes
// `import.meta.env.VITE_X`.  Both are build-time only: an unset one becomes ''
// in the bundle, with no error anywhere.
const esbuildCfg = fs.readFileSync(path.join(DESKTOP, 'esbuild.main.cjs'), 'utf8');
const defined = [...esbuildCfg.matchAll(/'process\.env\.([A-Z0-9_]+)'/g)].map((m) => m[1]!);

const rendererFiles: string[] = [];
(function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) rendererFiles.push(full);
  }
})(path.join(DESKTOP, 'src'));
/** Drop comments, so a name written ABOUT a variable is not read as a use of
 *  it.  Measured the hard way: the comment that records why SettingsPage no
 *  longer reads `import.meta.env.VITE_APP_VERSION` made this test go on
 *  demanding that something supply it. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const viteVars = new Set<string>();
for (const file of rendererFiles) {
  const text = withoutComments(fs.readFileSync(file, 'utf8'));
  for (const m of text.matchAll(/import\.meta\.env\??\.(VITE_[A-Z0-9_]+)/g)) viteVars.add(m[1]!);
}

check(
  'the build config and the renderer were both read',
  defined.length > 0 && viteVars.size > 0,
  `esbuild define: ${defined.join(', ')} | vite: ${[...viteVars].sort().join(', ')}`,
);

const linuxEnv = envs.get('build-linux') ?? {};
for (const name of [...new Set(defined)].sort()) {
  check(
    `\`process.env.${name}\` is baked, so the workflow sets it`,
    Object.prototype.hasOwnProperty.call(linuxEnv, name),
    `esbuild.main.cjs defines it; build.yml does not pass it, so it bakes as ''`,
  );
}
// A build-time variable may legitimately come from somewhere other than the
// workflow — but then it has to come from somewhere, named here, with the
// reason.  `VITE_APP_VERSION` is what this bucket is for: SettingsPage read it
// with a `?? '1.0.0'` fallback and a comment saying vite injected it.  Vite
// did not; it defines `__APP_VERSION__` from package.json, which the mastering
// report and the render provenance already used.  So the version row showed
// 1.0.0 in every build, releases included, while the same build's report said
// 3.7.0.  The page now reads the constant and this list stays empty.
const SUPPLIED_ELSEWHERE = new Map<string, string>();

const viteConfig = fs.readFileSync(path.join(DESKTOP, 'vite.config.ts'), 'utf8');
for (const name of [...viteVars].sort()) {
  const fromWorkflow = Object.prototype.hasOwnProperty.call(linuxEnv, name);
  const fromVite = new RegExp(`'import\\.meta\\.env\\.${name}'`).test(viteConfig);
  const excused = SUPPLIED_ELSEWHERE.get(name);
  check(
    `\`import.meta.env.${name}\` is read, so something supplies it`,
    fromWorkflow || fromVite || excused !== undefined,
    'the renderer reads it; neither build.yml nor vite.config.ts supplies it, so it '
    + "is '' in every installer — pass it in the workflow, define it in vite.config.ts, "
    + 'or add it to SUPPLIED_ELSEWHERE with the reason',
  );
}

console.log('\n── and the suites run ──────────────────────────────────────');

// `typecheck` and `lint` ran here for a long time and the 225 selftests did
// not run at all.  A test suite nobody runs has the standing of not existing,
// so this asks the workflow whether it still runs.
const linuxSteps = jobs['build-linux']?.steps ?? [];
const runsSuite = linuxSteps.some((s) => typeof s.run === 'string' && /\bpnpm (-s )?test\b/.test(s.run));
check(
  'build-linux runs the suite, not only typecheck and lint',
  runsSuite,
  linuxSteps.filter((s) => s.run).map((s) => String(s.name ?? '?')).join(' · '),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
