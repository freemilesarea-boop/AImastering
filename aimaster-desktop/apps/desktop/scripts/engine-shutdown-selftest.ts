/**
 * engine-shutdown-selftest.ts — the engine must not outlive the app.
 *
 * The Python engine ships as a PyInstaller `--onefile` binary, and that is a
 * BOOTLOADER: it unpacks itself to a temp directory and runs the real program
 * as a child of itself.  `ChildProcess.kill()` signals the direct child only,
 * so killing the bootloader left the actual engine running.
 *
 * That is not a tidiness problem.  A running engine holds its own binary
 * open, and an installer cannot overwrite a file that is still running — on
 * Windows the next upgrade fails outright.  It is also invisible: the window
 * closes, and the process stays.
 *
 * So this drives the bridge's real spawn and shutdown path with the same
 * SHAPE — `/bin/sh` reading commands on stdin, told to fork a worker and wait
 * on it, which is what the bootloader does.  Using the real engine binary
 * would make the test need a PyInstaller build before it could run at all.
 *
 * Two things a green run here does NOT prove, said plainly rather than left
 * to be assumed:
 *
 *   · The Windows half of the fix is `taskkill /T /F`, and nothing on this
 *     platform can exercise it.  What is shared between the two is the
 *     shape — stop politely, signal the tree, sweep after the exit — so a
 *     pass here is evidence the shape is right, not that Windows works.
 *
 *   · The polite stdin-EOF step survives having its own break test: removing
 *     it changes nothing here, because the SIGTERM that follows kills the
 *     `sh` stand-in just as fast.  It is kept for a reason this file cannot
 *     reach — a real engine given EOF finishes writing the file it has open,
 *     where one given only a signal may not.
 *
 * POSIX only: it asserts against process groups and `ps` state.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:engine-shutdown
 */

import { execSync } from 'node:child_process';
import { PythonBridge } from '@aimaster/audio-engine';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
/**
 * Whether a pid is a RUNNING process.
 *
 * Not `kill -0`, which is what this used first and which lies here: it
 * succeeds for a zombie, and a killed child stays a zombie until something
 * reaps it — which in a container with a non-reaping PID 1 can be never.  So
 * a working tree-kill read as a leak, and the next move would have been to
 * "fix" code that was already correct.
 *
 * A zombie has exited.  It holds no file handles, locks no binary, and is
 * exactly what we wanted the shutdown to produce.
 */
const alive = (pid: number): boolean => {
  try {
    const stat = execSync(`ps -o stat= -p ${pid} 2>/dev/null`).toString().trim();
    return stat.length > 0 && !stat.startsWith('Z');
  } catch {
    return false;   // no such process
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Spawned {
  proc: { pid: number; stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream };
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

async function main(): Promise<void> {
  await check('the engine itself goes when the app goes', async () => {
    const b = new PythonBridge({ pythonPath: '/bin/sh', scriptPath: '' });
    b.spawn();
    const { proc } = b as unknown as Spawned;
    assert(proc?.pid, 'the bridge spawned nothing');
    await sleep(300);
    await b.killAndWait(400);
    await sleep(300);
    assert(!alive(proc.pid), `the engine is still alive (pid ${proc.pid})`);
  });

  await check('and so does the worker it unpacked', async () => {
    const b = new PythonBridge({ pythonPath: '/bin/sh', scriptPath: '' });
    b.spawn();
    const { proc } = b as unknown as Spawned;
    assert(proc?.pid, 'the bridge spawned nothing');

    let workerPid = 0;
    proc.stdout.on('data', (chunk: Buffer | string) => {
      const m = /WORKER=(\d+)/.exec(chunk.toString());
      if (m) workerPid = Number(m[1]);
    });
    // Fork a worker and wait on it — the bootloader's shape exactly.
    proc.stdin.write('sleep 300 & echo WORKER=$!\nwait\n');
    await sleep(800);
    assert(workerPid > 0, 'the worker never reported its pid');
    assert(alive(workerPid), 'the worker was not running to begin with');

    await b.killAndWait(400);
    await sleep(500);

    const leaked = alive(workerPid);
    if (leaked) { try { execSync(`kill -9 ${workerPid}`); } catch { /* ignore */ } }
    assert(!leaked,
      `the worker outlived the engine (pid ${workerPid}) — it would hold the `
      + 'binary open, and an installer cannot overwrite a file that is running');
  });

  await check('a worker that ignores the polite signal still goes', async () => {
    // The case the post-exit sweep exists for, and the one the other checks
    // cannot reach: a worker that traps SIGTERM while its parent exits
    // cleanly on stdin EOF.  `killAndWait` resolves on the PARENT's exit, so
    // the escalation never fires — without a sweep after the wait, this
    // worker survives a shutdown that looked completely orderly.
    //
    // Not a hypothetical shape: an engine writing a file installs exactly
    // this kind of handler so a render is not truncated half-written.
    const b = new PythonBridge({ pythonPath: '/bin/sh', scriptPath: '' });
    b.spawn();
    const { proc } = b as unknown as Spawned;
    assert(proc?.pid, 'the bridge spawned nothing');

    let workerPid = 0;
    proc.stdout.on('data', (chunk: Buffer | string) => {
      const m = /WORKER=(\d+)/.exec(chunk.toString());
      if (m) workerPid = Number(m[1]);
    });
    proc.stdin.write(
      "/bin/sh -c \"trap '' TERM; sleep 300\" & echo WORKER=$!\n",
    );
    await sleep(800);
    assert(workerPid > 0, 'the worker never reported its pid');
    assert(alive(workerPid), 'the worker was not running to begin with');

    await b.killAndWait(400);
    await sleep(600);

    const leaked = alive(workerPid);
    if (leaked) { try { execSync(`kill -9 ${workerPid}`); } catch { /* ignore */ } }
    assert(!leaked,
      `a SIGTERM-ignoring worker outlived the engine (pid ${workerPid})`);
  });

  await check('the engine is asked before it is forced', async () => {
    // stdin EOF is the protocol's "no more requests".  A force-killed
    // PyInstaller bootloader never removes its _MEI temp directory, so a
    // shutdown that skips the polite step leaks a few hundred megabytes
    // every run.  `sh` exits on EOF, so a clean exit here proves the ask
    // happened before the 400 ms escalation could fire.
    const b = new PythonBridge({ pythonPath: '/bin/sh', scriptPath: '' });
    b.spawn();
    const { proc } = b as unknown as Spawned;
    await sleep(250);
    const started = Date.now();
    await b.killAndWait(4000);
    const took = Date.now() - started;
    assert(!alive(proc.pid), 'the engine did not exit');
    assert(took < 3000,
      `shutdown took ${took} ms — it waited for the forced kill instead of `
      + 'exiting on stdin EOF');
  });

  console.log('\n=== Engine shutdown — nothing outlives the app ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
