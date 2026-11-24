// license-core-selftest — the first test that RUNS the licensing package.
//
// `packages/license-core/src/index.ts` is 655 lines of billing: HMAC-signed
// licence and trial records, machine binding, trial counting, expiry, and the
// validator that talks to the activation server.  One suite referenced it
// before this one — `license-free-selftest` — and it opens with
//
//     const core = readFileSync('../../packages/license-core/src/index.ts');
//
// then greps.  Reading a file is not running it.  Nothing had ever constructed
// a `LicenseService`, signed a record, verified one, let one expire, or asked
// `RemoteValidator` what it does with a 500.
//
// Two things that grep cannot see came out of writing this:
//
//   · A licence record is NOT bound to the machine it is read on.  The trial
//     record is: `_readTrialUsed` compares `record.machineId` with
//     `getMachineId()` and treats a mismatch as maxed-out.  `_readLicense`
//     makes no such comparison, and the HMAC covers the record's OWN
//     machineId — so a `license` record copied to a second machine verifies
//     and is accepted there, offline, until it expires.  The binding runs the
//     wrong way round: the paid record travels, the free one is locked to a
//     device.  Both behaviours are pinned below, side by side, because which
//     one is wanted is a business decision and not mine to make; the server's
//     `device_limit` rejection says it is already thinking about devices.
//
//   · `assertLicenseSecretReady()` had no callers and said in its own docblock
//     that the host calls it at startup and quits.  The host logs an error and
//     carries on, deliberately — corrected in both files.
//
// The paid arithmetic needed one change to be testable at all: `LICENSE_ENFORCED`
// is a compile-time constant and this build has it false, so every line of the
// trial gate was unreachable from any importer.  It now lives in `trialGate`,
// which takes the two facts as arguments.
//
// Run: pnpm --filter @aimaster/desktop test:license-core

export {};

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import {
  LicenseService,
  LocalValidator,
  RemoteValidator,
  LICENSE_ENFORCED,
  DEV_FALLBACK_HMAC_SECRET,
  isLicenseSecretProductionReady,
  assertLicenseSecretReady,
  isNetworkValidatorError,
  validateKeyFormat,
  getMachineId,
  trialGate,
  type LicenseStore,
  type LicenseValidator,
  type ValidatorResponse,
  type StoredLicense,
  type LicenseTier,
  type LicenseInfo,
} from '@aimaster/license-core';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

// ── The same signature the package computes, computed independently ──────────
// Not imported: `signLicense` is private, and a test that borrowed it could
// not tell a correct signature from a matching bug.  The first check below
// proves this replica and the package agree, which also pins the signed
// FORMAT — changing the field order invalidates every record already on a
// customer's disk, so it should take a deliberate act and a failing test.

const SECRET = process.env['LICENSE_HMAC_SECRET'] || DEV_FALLBACK_HMAC_SECRET;
const hmac = (...parts: (string | number)[]): string =>
  crypto.createHmac('sha256', SECRET).update(parts.join('|')).digest('hex');
const signLicence = (
  key: string, tier: LicenseTier, activatedAt: string, machineId: string, expiresAt = '',
): string => hmac(key, tier, activatedAt, machineId, expiresAt);
const signTrial = (used: number, machineId: string): string => hmac('trial', used, machineId);

const THIS_MACHINE  = getMachineId();
const OTHER_MACHINE = 'ffffffffffffffffffffffffffffffff';
const GOOD_KEY      = 'AIMASTER-ABCD-1234-WXYZ';
const PAST          = '2020-03-01T00:00:00.000Z';
const FUTURE        = '2099-03-01T00:00:00.000Z';
const ACTIVATED     = '2026-01-01T00:00:00.000Z';

interface LicenceOpts {
  key?: string; tier?: LicenseTier; activatedAt?: string; machineId?: string; expiresAt?: string;
}
/** A record exactly as the service would have written it. */
function licence(o: LicenceOpts = {}): StoredLicense {
  const key         = o.key ?? GOOD_KEY;
  const tier        = o.tier ?? 'pro';
  const activatedAt = o.activatedAt ?? ACTIVATED;
  const machineId   = o.machineId ?? THIS_MACHINE;
  return {
    key, tier, activatedAt, machineId,
    ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
    hmac: signLicence(key, tier, activatedAt, machineId, o.expiresAt ?? ''),
  };
}

interface TrialRecord { used: number; machineId: string; hmac: string }
function trial(used: number, machineId = THIS_MACHINE, forged?: string): TrialRecord {
  return { used, machineId, hmac: forged ?? signTrial(used, machineId) };
}

interface Mem { store: LicenseStore; mem: Map<string, unknown>; writes: () => number }
function memory(seed: Record<string, unknown> = {}): Mem {
  const mem = new Map<string, unknown>(Object.entries(seed));
  let writes = 0;
  const store: LicenseStore = {
    get<T>(k: string): T | undefined { return mem.get(k) as T | undefined; },
    set(k: string, v: unknown): void { writes++; mem.set(k, v); },
    delete(k: string): void { writes++; mem.delete(k); },
  };
  return { store, mem, writes: () => writes };
}

/** A store whose file on disk is unreadable — electron-store throws. */
const corruptStore: LicenseStore = {
  get<T>(k: string): T | undefined { throw new Error(`EBADF: license store unreadable (${k})`); },
  set(): void { throw new Error('EBADF: license store unwritable'); },
  delete(): void { throw new Error('EBADF: license store unwritable'); },
};

/** Run `fn` with stderr collected, so the devLog line can be asserted on. */
function captureStderr<T>(fn: () => T): { value: T; err: string } {
  const stream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const original = stream.write;
  let buf = '';
  stream.write = (chunk: unknown): boolean => { buf += String(chunk); return true; };
  try { return { value: fn(), err: buf }; } finally { stream.write = original; }
}

/**
 * Source with comments removed, so a check reads code and not prose.
 *
 * Needed immediately: the walk below looks for callers of
 * `assertLicenseSecretReady()`, and the first run found one — the paragraph in
 * `main/index.ts` that this commit added to explain that nothing calls it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => { const i = line.indexOf('//'); return i >= 0 ? line.slice(0, i) : line; })
    .join('\n');
}

class StubValidator implements LicenseValidator {
  readonly calls: { key: string; machineId: string }[] = [];
  constructor(private readonly answer: ValidatorResponse | Error) {}
  async validate(key: string, machineId: string): Promise<ValidatorResponse> {
    this.calls.push({ key, machineId });
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

// ── The child half: a build with a real secret injected ──────────────────────
// `HMAC_SECRET` is read once, at import, so the production case cannot be
// reached by setting an environment variable here.  This file re-runs itself
// with the variable set and reads back what the package then believed.

const PROD_SECRET = 'b7f3a1c9d2e45608a1b2c3d4e5f60718';

interface ChildFacts {
  ready: boolean;
  assertThrew: boolean;
  secretsDiffer: boolean;
  devSignedRecordTier: string;
  freshRecordTier: string;
}

function childFacts(): ChildFacts {
  // `licence()` here signs with whatever secret THIS process was given, which
  // in the child is the production one — the first draft used it for both
  // halves and proved nothing, which is what the check caught.  The old
  // record has to be signed with the dev fallback explicitly.
  const body = `${GOOD_KEY}|pro|${ACTIVATED}|${THIS_MACHINE}|`;
  const devHmac = crypto.createHmac('sha256', DEV_FALLBACK_HMAC_SECRET).update(body).digest('hex');
  const old: StoredLicense = {
    key: GOOD_KEY, tier: 'pro', activatedAt: ACTIVATED, machineId: THIS_MACHINE, hmac: devHmac,
  };
  const fresh = licence();
  let assertThrew = false;
  try { assertLicenseSecretReady(); } catch { assertThrew = true; }
  return {
    ready:               isLicenseSecretProductionReady(),
    assertThrew,
    secretsDiffer:       devHmac !== fresh.hmac,
    devSignedRecordTier: captureStderr(() =>
      new LicenseService(memory({ license: old }).store).getLicenseState()).value.tier,
    freshRecordTier:     new LicenseService(memory({ license: fresh }).store).getLicenseState().tier,
  };
}

if (process.env['LICENSE_CORE_CHILD'] === '1') {
  process.stdout.write(`CHILD_FACTS ${JSON.stringify(childFacts())}\n`);
} else {
  void main().catch((err: unknown) => {
    console.error(`[FAIL] the suite did not finish — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  console.log('\n=== license-core: the billing package, running ===\n');

  // ── Signing ───────────────────────────────────────────────────────────────
  {
    const m = memory();
    const info = await new LicenseService(m.store, new LocalValidator()).activateLicense(GOOD_KEY);
    const stored = m.mem.get('license') as StoredLicense;
    const mine = signLicence(stored.key, stored.tier, stored.activatedAt, stored.machineId, '');
    check(
      'this file signs a record the same way the package does',
      stored.hmac === mine && info.tier === 'pro',
      `package ${stored.hmac.slice(0, 16)}… / here ${mine.slice(0, 16)}…`,
    );
    check(
      'and the record it wrote is bound to this machine and reads back as pro',
      stored.machineId === THIS_MACHINE
        && new LicenseService(m.store).getLicenseState().tier === 'pro',
      `machineId=${stored.machineId}`,
    );
  }

  // ── A record that was edited on disk ──────────────────────────────────────
  {
    const free = licence({ tier: 'free' });
    const promoted = { ...free, tier: 'pro' as LicenseTier };   // hmac left behind
    const m = memory({ license: promoted });
    const { value: info, err } = captureStderr(() => new LicenseService(m.store).getLicenseState());
    check(
      'free edited to pro on disk does not become pro',
      info.tier === 'free',
      `tier=${info.tier}, log says: ${err.trim().slice(0, 72) || '(nothing)'}`,
    );
    check(
      'and the rejection is logged, not swallowed',
      /HMAC verification failed/.test(err),
      err.trim() ? err.trim().split('\n')[0] ?? '' : 'stderr was empty',
    );
  }
  {
    const real = licence({ expiresAt: PAST });
    const extended = { ...real, expiresAt: FUTURE };
    const m = memory({ license: extended });
    const info = captureStderr(() => new LicenseService(m.store).getLicenseState()).value;
    check(
      'an expiry date moved forward on disk does not extend the licence',
      info.tier === 'free',
      `expiresAt=${extended.expiresAt} → tier=${info.tier}`,
    );
  }
  {
    // A rejected record is left where it is: nothing deletes it, and the
    // validator is never asked about it, because `_readLicense` returns null
    // before `revalidate` has a key to send.
    const m = memory({ license: { ...licence({ tier: 'free' }), tier: 'pro' as LicenseTier } });
    const v = new StubValidator({ valid: true, tier: 'pro' });
    const info = captureStderr(() => new LicenseService(m.store, v).getLicenseState()).value;
    const after = await new LicenseService(m.store, v).revalidate();
    check(
      'a record that fails its HMAC is never sent to the server, and is left on disk',
      info.tier === 'free' && v.calls.length === 0 && m.mem.has('license') && after.tier === 'free',
      `validator calls=${v.calls.length}, record still stored=${m.mem.has('license')}`,
    );
  }

  // ── Machine binding: the asymmetry ───────────────────────────────────────
  {
    const m = memory({ license: licence({ machineId: OTHER_MACHINE }) });
    const info = new LicenseService(m.store).getLicenseState();
    check(
      'PINNED: a licence record copied from another machine is accepted here',
      info.tier === 'pro',
      `record machineId=${OTHER_MACHINE}, this machine=${THIS_MACHINE} → tier=${info.tier}`,
    );
  }
  {
    const m = memory({ trial: trial(1, OTHER_MACHINE) });
    const { value: info, err } = captureStderr(() => new LicenseService(m.store).getLicenseState());
    check(
      'while a trial record from another machine is refused and counted as used up',
      info.trialUsed === info.trialMax && /machineId mismatch/.test(err),
      `used 1 on ${OTHER_MACHINE} → trialUsed=${info.trialUsed}/${info.trialMax}`,
    );
  }
  {
    // The two together, in one service, so the direction is on the record.
    const m = memory({
      license: licence({ machineId: OTHER_MACHINE }),
      trial:   trial(0, OTHER_MACHINE),
    });
    const info = captureStderr(() => new LicenseService(m.store).getLicenseState()).value;
    check(
      'so copying a store to a second machine carries the licence but burns the trial',
      info.tier === 'pro' && info.trialUsed === info.trialMax,
      `tier=${info.tier}, trialUsed=${info.trialUsed} — the paid record travels, the free one does not`,
    );
  }

  // ── Expiry ───────────────────────────────────────────────────────────────
  {
    const lifetime = new LicenseService(memory({ license: licence() }).store).getLicenseState();
    const monthly  = new LicenseService(memory({ license: licence({ expiresAt: FUTURE }) }).store)
      .getLicenseState();
    check(
      'a licence with no expiry is a lifetime licence',
      lifetime.tier === 'pro' && lifetime.expiresAt === undefined,
      `tier=${lifetime.tier}, expiresAt=${String(lifetime.expiresAt)}`,
    );
    check(
      'and one whose period has not ended is still pro',
      monthly.tier === 'pro' && monthly.expiresAt === FUTURE,
      `expiresAt=${String(monthly.expiresAt)} → tier=${monthly.tier}`,
    );
  }
  {
    const info = new LicenseService(memory({ license: licence({ expiresAt: PAST }) }).store)
      .getLicenseState();
    check(
      'a lapsed subscription falls back to free',
      info.tier === 'free',
      `expiresAt=${PAST} → tier=${info.tier}`,
    );
    check(
      'but still reports the key and the date, so the UI can offer a renewal',
      info.key === GOOD_KEY && info.expiresAt === PAST,
      `key=${String(info.key)}, expiresAt=${String(info.expiresAt)}`,
    );
    check(
      'and on THIS build a lapsed licence still saves masters, because nothing is enforced',
      info.canSaveMasterWav === !LICENSE_ENFORCED
        && info.canExportReport === !LICENSE_ENFORCED,
      `LICENSE_ENFORCED=${LICENSE_ENFORCED} → canSaveMasterWav=${info.canSaveMasterWav}`,
    );
  }
  {
    // Documented on purpose: a date the app cannot read must not lock a paying
    // customer out of the software they bought.
    const info = new LicenseService(memory({ license: licence({ expiresAt: 'next tuesday' }) }).store)
      .getLicenseState();
    check(
      'PINNED: an expiry date the app cannot parse is treated as not expired',
      info.tier === 'pro',
      `expiresAt="next tuesday" → tier=${info.tier} (locking out beats nothing, so it does not)`,
    );
  }
  {
    const info = new LicenseService(memory({ license: licence({ tier: 'free', expiresAt: FUTURE }) }).store)
      .getLicenseState();
    check(
      'a correctly signed free-tier record is not paid, however long it runs',
      info.tier === 'free' && info.canSaveMasterWav === !LICENSE_ENFORCED,
      `tier=free, expiresAt=${FUTURE} → tier=${info.tier}`,
    );
  }

  // ── A store that cannot be read ──────────────────────────────────────────
  {
    // Catching here is the point of the check: when this stopped swallowing
    // the read error the first draft died of an unhandled rejection, exit 1
    // with no line saying which promise, which is the kind of failure that
    // gets read as "the runner is flaky".
    let info: LicenseInfo | null = null;
    let err = '';
    let thrown: unknown;
    try {
      const got = captureStderr(() => new LicenseService(corruptStore).getLicenseState());
      info = got.value; err = got.err;
    } catch (e) { thrown = e; }
    check(
      'an unreadable store answers free rather than throwing at the IPC caller',
      info !== null && info.tier === 'free' && info.trialUsed === info.trialMax,
      thrown !== undefined
        ? `license:status would have rejected: ${String(thrown)}`
        : `tier=${String(info?.tier)}, trialUsed=${String(info?.trialUsed)}/${String(info?.trialMax)}`,
    );
    check(
      'and both failures are logged with the reason',
      /Failed to read license record/.test(err) && /Failed to read trial record/.test(err)
        && /EBADF/.test(err),
      err.trim() ? err.trim().split('\n').length + ' lines on stderr, naming EBADF'
                 : 'nothing reached stderr',
    );
  }

  // ── Trial counting ───────────────────────────────────────────────────────
  {
    const cases: [string, unknown, number][] = [
      ['no record at all',                     undefined,                            0],
      ['a signed count of 1',                  trial(1),                             1],
      ['a signed count of 3',                  trial(3),                             3],
      ['a count edited from 3 to 0',           { ...trial(3), used: 0 },             3],
      ['a count above the maximum',            trial(9),                             3],
      ['a negative count',                     trial(-5),                            3],
      ['an hmac of the wrong length',          trial(0, THIS_MACHINE, 'deadbeef'),   3],
      ['an hmac of the right length, wrong',   trial(0, THIS_MACHINE, 'a'.repeat(64)), 3],
    ];
    for (const [what, record, expect] of cases) {
      const seed = record === undefined ? {} : { trial: record };
      const info = captureStderr(() => new LicenseService(memory(seed).store).getLicenseState()).value;
      check(
        `trial record: ${what} reads as ${expect}`,
        info.trialUsed === expect,
        `trialUsed=${info.trialUsed}, expected ${expect}`,
      );
    }
  }

  // ── Activation ───────────────────────────────────────────────────────────
  {
    const m = memory();
    let message = '';
    try { await new LicenseService(m.store, new LocalValidator()).activateLicense('NOPE-1'); }
    catch (err) { message = (err as Error).message; }
    check(
      'a key in the wrong format is refused in Korean, and nothing is written',
      message.includes('라이선스 키 형식') && m.writes() === 0 && m.mem.size === 0,
      `message="${message}", store writes=${m.writes()}`,
    );
  }
  {
    const m = memory();
    const info = await new LicenseService(m.store, new LocalValidator())
      .activateLicense('  aimaster-abcd-1234-wxyz  ');
    const stored = m.mem.get('license') as StoredLicense;
    check(
      'a lower-case key with spaces around it activates, stored in the canonical form',
      info.key === GOOD_KEY && stored.key === GOOD_KEY
        && stored.hmac === signLicence(GOOD_KEY, 'pro', stored.activatedAt, THIS_MACHINE, ''),
      `stored key=${stored.key}`,
    );
    check(
      'and what the field accepts is what the validator accepts',
      validateKeyFormat('  aimaster-abcd-1234-wxyz  ') && !validateKeyFormat('AIMASTER-ABCD-1234-WXY'),
      'same regex, both directions',
    );
  }
  {
    // The server can say "this key is real, and it is not a pro key".  The
    // activation then succeeds with nothing bought — pinned because the dialog
    // closes on success and says nothing about tier.
    const m = memory();
    const info = await new LicenseService(m.store, new StubValidator({ valid: true, tier: 'free' }))
      .activateLicense(GOOD_KEY);
    check(
      'PINNED: a valid NON-pro key activates and stores a free record',
      info.tier === 'free' && (m.mem.get('license') as StoredLicense).tier === 'free',
      `validator said valid+free → activation returned tier=${info.tier} with no reason shown`,
    );
  }
  {
    const m = memory();
    const net = new Error('LICENSE_NETWORK: 라이선스 서버에 연결할 수 없습니다.');
    let message = '';
    try { await new LicenseService(m.store, new StubValidator(net)).activateLicense(GOOD_KEY); }
    catch (err) { message = (err as Error).message; }
    check(
      'an activation that could not reach the server writes nothing',
      isNetworkValidatorError(new Error(message)) && m.mem.size === 0,
      `threw "${message.slice(0, 40)}…", store size=${m.mem.size}`,
    );
  }
  {
    const m = memory();
    const info = await new LicenseService(m.store, new StubValidator({ valid: true, tier: 'pro', expiresAt: FUTURE }))
      .activateLicense(GOOD_KEY);
    const stored = m.mem.get('license') as StoredLicense;
    check(
      'an expiry from the server is stored and covered by the signature',
      info.expiresAt === FUTURE && stored.expiresAt === FUTURE
        && stored.hmac === signLicence(GOOD_KEY, 'pro', stored.activatedAt, THIS_MACHINE, FUTURE),
      `expiresAt=${String(stored.expiresAt)}, signature covers it`,
    );
  }

  // ── Re-validation ────────────────────────────────────────────────────────
  {
    const m = memory({ license: licence({ expiresAt: FUTURE }) });
    const v = new StubValidator({ valid: false, tier: 'free', reason: 'refunded' });
    const info = await new LicenseService(m.store, v).revalidate();
    check(
      'a refund the server knows about revokes the licence on this machine',
      info.tier === 'free' && !m.mem.has('license') && v.calls[0]?.key === GOOD_KEY,
      `record deleted=${!m.mem.has('license')}, asked about ${String(v.calls[0]?.key)}`,
    );
  }
  {
    const before = licence({ expiresAt: FUTURE });
    const m = memory({ license: before });
    const v = new StubValidator(new Error('LICENSE_NETWORK: 라이선스 서버에 연결할 수 없습니다.'));
    let info: LicenseInfo | null = null;
    let thrown: unknown;
    try { info = await new LicenseService(m.store, v).revalidate(); } catch (e) { thrown = e; }
    const after = m.mem.get('license') as StoredLicense | undefined;
    check(
      'an aeroplane does not revoke anything: the record is kept byte for byte',
      info?.tier === 'pro' && JSON.stringify(after) === JSON.stringify(before) && m.writes() === 0,
      thrown !== undefined
        ? `revalidate threw the network error at startup: ${String(thrown)}`
        : `writes=${m.writes()}, tier=${String(info?.tier)}, record kept=${m.mem.has('license')}`,
    );
  }
  {
    const m = memory({ license: licence() });
    const v = new StubValidator(new TypeError('resp.json is not a function'));
    let message = '';
    try { await new LicenseService(m.store, v).revalidate(); }
    catch (err) { message = (err as Error).message; }
    check(
      'a failure that is NOT a network failure is passed to the caller, licence intact',
      message === 'resp.json is not a function' && m.mem.has('license'),
      `rethrew "${message}", record kept=${m.mem.has('license')}`,
    );
  }
  {
    const m = memory({ license: licence({ expiresAt: PAST }) });
    const renewed = '2027-03-01T00:00:00.000Z';
    const v = new StubValidator({ valid: true, tier: 'pro', expiresAt: renewed });
    const info = await new LicenseService(m.store, v).revalidate();
    const after = m.mem.get('license') as StoredLicense;
    check(
      'a renewal picked up at startup brings a lapsed licence back',
      info.tier === 'pro' && info.expiresAt === renewed,
      `${PAST} → ${String(info.expiresAt)}, tier=${info.tier}`,
    );
    check(
      'the refreshed record is re-signed, keeps its activation date, and moves lastValidated',
      after.hmac === signLicence(GOOD_KEY, 'pro', ACTIVATED, THIS_MACHINE, renewed)
        && after.activatedAt === ACTIVATED
        && typeof after.lastValidated === 'string' && after.lastValidated !== ACTIVATED,
      `activatedAt kept ${after.activatedAt}, lastValidated=${String(after.lastValidated)}`,
    );
  }
  {
    const m = memory();
    const v = new StubValidator({ valid: false, tier: 'free', reason: 'not_found' });
    const info = await new LicenseService(m.store, v).revalidate();
    check(
      'with no licence stored, startup re-validation asks the server nothing',
      v.calls.length === 0 && info.tier === 'free' && m.writes() === 0,
      `validator calls=${v.calls.length}`,
    );
  }
  {
    const m = memory({ license: licence(), trial: trial(2) });
    const info = new LicenseService(m.store).deactivate();
    check(
      'deactivating removes the licence and leaves the trial count alone',
      info.tier === 'free' && !m.mem.has('license') && (m.mem.get('trial') as TrialRecord).used === 2,
      `tier=${info.tier}, trial.used=${(m.mem.get('trial') as TrialRecord).used}`,
    );
  }

  // ── What this build does ─────────────────────────────────────────────────
  {
    const m = memory({ trial: trial(3) });
    const svc = new LicenseService(m.store);
    const gate = svc.canProcess();
    check(
      'with the switch off, a user who has used every trial run is still allowed',
      gate.allowed && gate.isPaid && gate.remaining === Infinity && gate.reason === undefined,
      `LICENSE_ENFORCED=${LICENSE_ENFORCED} → ${JSON.stringify({ ...gate, remaining: 'Infinity' })}`,
    );
    check(
      'and the gate is a fresh object each time, not one shared answer',
      svc.canProcess() !== gate,
      'a caller that edits the answer cannot edit the next caller’s',
    );
    check(
      'getRemainingTrials agrees with it',
      svc.getRemainingTrials() === Infinity,
      `remaining=${svc.getRemainingTrials()}`,
    );
  }
  {
    // The important half of shipping unenforced: if the counter ticked anyway,
    // every existing user would be at the limit the day the switch flips.
    const m = memory();
    const svc = new LicenseService(m.store);
    for (let i = 0; i < 5; i++) svc.decrementTrialUsage();
    check(
      'nothing is counted while nothing is limited — no trial record is created',
      m.writes() === 0 && !m.mem.has('trial')
        && new LicenseService(m.store).getLicenseState().trialUsed === 0,
      `5 runs → store writes=${m.writes()}, trial record=${String(m.mem.get('trial'))}`,
    );
  }

  // ── The arithmetic the switch turns on ───────────────────────────────────
  {
    const paid = trialGate(true, 3);
    check(
      'enforced: a paid licence is allowed with the trial count exhausted',
      paid.allowed && paid.isPaid && paid.remaining === Infinity,
      `trialGate(true, 3) → allowed=${paid.allowed}, remaining=Infinity`,
    );
    const steps = [0, 1, 2].map((used) => trialGate(false, used));
    check(
      'enforced: three free runs count down 3, 2, 1',
      steps.map((g) => g.remaining).join(',') === '3,2,1'
        && steps.every((g) => g.allowed && !g.isPaid && g.reason === undefined),
      `remaining=${steps.map((g) => g.remaining).join(',')}`,
    );
    const done = trialGate(false, 3);
    check(
      'enforced: the fourth run is refused, with a message that names the count',
      !done.allowed && !done.isPaid && done.remaining === 0
        && (done.reason ?? '').includes('3회') && (done.reason ?? '').includes('라이선스 키'),
      `reason="${done.reason ?? '(none)'}"`,
    );
    const past = trialGate(false, 9);
    check(
      'enforced: a count past the limit still reports zero left, never a negative',
      !past.allowed && past.remaining === 0,
      `trialGate(false, 9) → remaining=${past.remaining}`,
    );
  }
  {
    const core = readFileSync('../../packages/license-core/src/index.ts', 'utf8');
    const calls = (core.match(/trialGate\(/g) ?? []).length;
    check(
      'and both the gate and the number the UI shows come from that one function',
      /return trialGate\(this\._isPaid\(stored\), trialUsed\)/.test(core)
        && /return trialGate\(false, this\._readTrialUsed\(\)\)\.remaining/.test(core)
        && calls >= 3,
      `${calls} mentions: the definition, canProcess, getRemainingTrials`,
    );
  }

  // ── RemoteValidator: the thing that actually decides a licence ────────────
  // The production validator, driven against real `Response` objects.  Nothing
  // had ever run it: a build with LICENSE_API_URL injected would have been the
  // first time any of this executed, at a customer's activation.
  {
    const realFetch = globalThis.fetch;
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const answer = (make: (url: string) => Response | Promise<Response>): void => {
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        return Promise.resolve(make(String(url)));
      }) as unknown as typeof fetch;
    };
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    try {
      const remote = new RemoteValidator('https://example.supabase.co//', 'anon-key-123');

      answer(() => json({ valid: true, tier: 'pro', expiresAt: FUTURE }));
      const ok = await remote.validate(GOOD_KEY, THIS_MACHINE);
      const call = seen[0];
      check(
        'the request goes to the activation function, with the trailing slashes trimmed',
        call?.url === 'https://example.supabase.co/functions/v1/aimaster-validate',
        `url=${String(call?.url)}`,
      );
      check(
        'it carries the key, the machine id and the anon key in both header forms',
        JSON.parse(String(call?.init?.body)).key === GOOD_KEY
          && JSON.parse(String(call?.init?.body)).machineId === THIS_MACHINE
          && (call?.init?.headers as Record<string, string>)['apikey'] === 'anon-key-123'
          && (call?.init?.headers as Record<string, string>)['Authorization'] === 'Bearer anon-key-123',
        `body=${String(call?.init?.body)}`,
      );
      check(
        'a pro answer comes back as pro, with the expiry the server gave',
        ok.valid && ok.tier === 'pro' && ok.expiresAt === FUTURE,
        JSON.stringify(ok),
      );

      seen.length = 0;
      const badFormat = await remote.validate('AIMASTER-1', THIS_MACHINE);
      check(
        'a key that cannot be a key is refused without troubling the server',
        !badFormat.valid && seen.length === 0 && (badFormat.reason ?? '').includes('형식'),
        `fetches=${seen.length}, reason="${badFormat.reason ?? ''}"`,
      );

      const reasons: [string, string][] = [
        ['not_found',    '등록되지 않은'],
        ['expired',      '만료'],
        ['refunded',     '환불'],
        ['revoked',      '해제된'],
        ['device_limit', '기기 등록 한도'],
        ['bad_request',  '올바르지 않습니다'],
      ];
      for (const [reason, korean] of reasons) {
        answer(() => json({ valid: false, reason }));
        const r = await remote.validate(GOOD_KEY, THIS_MACHINE);
        check(
          `the server's "${reason}" reaches the user as Korean they can act on`,
          !r.valid && r.tier === 'free' && (r.reason ?? '').includes(korean),
          `reason="${r.reason ?? ''}"`,
        );
      }

      answer(() => json({ valid: false, reason: 'some_reason_added_next_year' }));
      const unknown = await remote.validate(GOOD_KEY, THIS_MACHINE);
      check(
        'a rejection reason this build has never heard of still says something',
        !unknown.valid && (unknown.reason ?? '').length > 0 && !(unknown.reason ?? '').includes('undefined'),
        `reason="${unknown.reason ?? ''}"`,
      );

      answer(() => json({ valid: true, tier: 'enterprise' }));
      const odd = await remote.validate(GOOD_KEY, THIS_MACHINE);
      check(
        'a tier this build does not sell is not treated as paid',
        odd.valid && odd.tier === 'free',
        `server said tier=enterprise → ${odd.tier}`,
      );

      const failures: [string, () => Response | Promise<Response>][] = [
        ['a 500 from the server',       () => json({ error: 'boom' }, 500)],
        ['a 401 from the gateway',      () => json({ message: 'no' }, 401)],
        ['a body that is not JSON',     () => new Response('<html>maintenance</html>', { status: 200 })],
        ['a connection that never got there', () => Promise.reject(new Error('ECONNREFUSED'))],
      ];
      for (const [what, make] of failures) {
        globalThis.fetch = (() => {
          const r = make();
          return r instanceof Promise ? r : Promise.resolve(r);
        }) as unknown as typeof fetch;
        let err: unknown;
        try { await remote.validate(GOOD_KEY, THIS_MACHINE); } catch (e) { err = e; }
        check(
          `${what} is a network failure, not a verdict on the licence`,
          isNetworkValidatorError(err),
          err instanceof Error ? err.message.slice(0, 64) : `threw nothing: ${String(err)}`,
        );
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ── The HMAC secret ──────────────────────────────────────────────────────
  {
    let message = '';
    try { assertLicenseSecretReady(); } catch (err) { message = (err as Error).message; }
    check(
      'with no secret injected the package knows it is not production-ready',
      !isLicenseSecretProductionReady() && message.includes('LICENSE_HMAC_SECRET'),
      `secret is the dev fallback → ready=${isLicenseSecretProductionReady()}`,
    );
    check(
      'and the refusal tells a packager what to set and when',
      />= 16 char/.test(message) && /BEFORE the main process imports/.test(message),
      message.slice(0, 72) + '…',
    );
  }
  {
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1] ?? ''], {
      env: { ...process.env, LICENSE_CORE_CHILD: '1', LICENSE_HMAC_SECRET: PROD_SECRET },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('CHILD_FACTS '));
    const facts = line ? JSON.parse(line.slice('CHILD_FACTS '.length)) as ChildFacts : null;
    check(
      'a build with a real secret injected passes the production check',
      facts !== null && facts.ready && !facts.assertThrew,
      facts ? `ready=${facts.ready}, assert threw=${facts.assertThrew}`
            : `child produced no facts (status ${String(child.status)}): ${(child.stderr ?? '').slice(-200)}`,
    );
    check(
      'rotating the secret drops every record already on disk to free, without crashing',
      facts !== null && facts.secretsDiffer
        && facts.devSignedRecordTier === 'free' && facts.freshRecordTier === 'pro',
      facts ? `signatures differ=${facts.secretsDiffer}: old record → ${facts.devSignedRecordTier}, `
              + `re-signed → ${facts.freshRecordTier}`
            : 'no child facts',
    );
  }
  {
    // The claim this file corrected.  Not the word — the fact: nothing calls
    // the thrower, and the startup path logs instead.
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (/assertLicenseSecretReady\(\)/.test(stripComments(readFileSync(full, 'utf8')))) callers.push(full);
      }
    };
    walk('src');
    const index = readFileSync('src/main/index.ts', 'utf8');
    check(
      'nothing in the app calls the thrower, and the startup path says what it does instead',
      callers.length === 0
        && /isLicenseSecretProductionReady\(\)\) \{/.test(stripComments(index))
        && /log\.error\('\[license\] PRODUCTION build/.test(index),
      callers.length === 0
        ? 'no callers; a packaged build with a weak secret is logged and started'
        : `assertLicenseSecretReady now has callers — update both docblocks: ${callers.join(', ')}`,
    );
    const core = readFileSync('../../packages/license-core/src/index.ts', 'utf8');
    const handlers = readFileSync('src/main/ipc/licenseHandlers.ts', 'utf8');
    check(
      'and the docblock no longer claims the host calls it at startup',
      /NOTHING CALLS THIS TODAY/.test(core) && /the opposite choice/.test(core),
      'the correction is in the file, where the next reader is',
    );
    check(
      'the package header carries the machine-binding asymmetry to the next reader',
      /NOT bound the same way/.test(core) && /device_limit/.test(core),
      'stated where someone reading the storage layout will meet it',
    );
    check(
      'and it sends them to the store note instead of calling the store encrypted',
      /licenseHandlers\.ts/.test(core) && /TAMPER OBFUSCATION/.test(handlers),
      'one note about what the encryptionKey is worth, in the file that sets it',
    );
    check(
      'both validators are written and wired — nothing is waiting to be swapped in',
      /new RemoteValidator\(LICENSE_API_URL, LICENSE_API_KEY\)/.test(handlers)
        && /new LocalValidator\(\)/.test(handlers)
        && /Nothing is left to "swap in"/.test(core),
      'licenseHandlers picks the remote one whenever the endpoint was injected',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}
