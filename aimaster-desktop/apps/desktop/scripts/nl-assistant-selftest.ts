/**
 * nl-assistant-selftest — the wall in front of the language model.
 *
 * A model is a text generator.  This feature is only safe because nothing it
 * writes reaches the session: every proposal is checked against the real
 * tracks, the real device registry and the real parameter ranges first.  So
 * almost every test here is an ATTACK — a plan that names a track that was
 * deleted, a parameter that never existed, a fader at +400 dB, an action kind
 * nobody implemented — and the assertion is always the same shape: refused,
 * and refused OUT LOUD.
 *
 * The second half tests the ordering: the rule parser goes first, the model is
 * the fallback, and when the model cannot be reached the parser's answer is
 * still returned with the reason attached.  A bridge is injected, so this runs
 * offline with no key.  A feature whose tests need a credential is a feature
 * that stops being tested.
 *
 * Run: pnpm --filter @aimaster/desktop test:nl
 */

import { parsePlan, PLAN_SCHEMA, PLAN_TOOL_NAME, systemPrompt } from '../src/renderer/daw/ai/nl-protocol.js';
import {
  ask, fromInterpretation, hasAssistantBridge, setAssistantBridge,
  type AssistantBridge,
} from '../src/renderer/daw/ai/nl-assistant.js';
import { catalogText, deviceCatalog, macroCatalog, sessionBrief } from '../src/renderer/daw/ai/nl-context.js';
import { applyActions } from '../src/renderer/daw/ai/actions.js';
import {
  addTrack, createInsert, createSession, createTrack, findTrack, setInsert, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { PLUGINS, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { MACROS } from '../src/renderer/daw/model/macros.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Two tracks and a master, with one EQ already in the vocal's slot 0. */
function mix(): { session: DawSession; vox: TrackId; kick: TrackId } {
  resetIds();
  let session = createSession('nl test', 48000);
  const vox = createTrack('Lead Vox', 'audio');
  const kick = createTrack('Kick', 'audio');
  session = addTrack(addTrack(session, vox), kick);
  session = updateTrack(session, vox.id, (t) => ({ ...t, volumeDb: -4, pan: 0.2 }));
  session = setInsert(session, vox.id, createInsert(0, 'eq3', 'EQ'));
  return { session, vox: vox.id, kick: kick.id };
}

const plan = (actions: unknown[], extra: Record<string, unknown> = {}): unknown =>
  ({ understood: '테스트', actions, ...extra });

// ── The validator: things that must be refused ────────────────────────────────

check('a track that is not in this session is refused, by name', () => {
  const { session } = mix();
  const out = parsePlan(session, plan([{ kind: 'trackVolume', trackId: 'trk_ghost', db: -2 }]));
  eq(out.actions.length, 0, 'nothing survives');
  eq(out.rejected.length, 1, 'and it is reported');
  assert(out.rejected[0]?.includes('trk_ghost'), `says which track: ${out.rejected[0]}`);
});

check('an action with no track at all is refused', () => {
  const { session } = mix();
  const out = parsePlan(session, plan([{ kind: 'trackVolume', db: -2 }]));
  eq(out.actions.length, 0, 'nothing survives');
  assert(out.rejected[0]?.includes('트랙'), 'says the track is missing');
});

check('a device that is not in the registry is refused', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([
    { kind: 'insertParam', trackId: vox, pluginId: 'magic-vocal-fixer', paramId: 'amount', value: 1 },
  ]));
  eq(out.actions.length, 0, 'nothing survives');
  assert(out.rejected[0]?.includes('magic-vocal-fixer'), 'names the invented device');
});

check('a parameter the device does not have is refused', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([
    { kind: 'insertParam', trackId: vox, pluginId: 'eq3', paramId: 'presence', value: 3 },
  ]));
  eq(out.actions.length, 0, 'nothing survives');
  assert(out.rejected[0]?.includes('presence'), 'names the invented parameter');
});

check('a macro that is not one of the seven is refused', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([
    { kind: 'macro', trackId: vox, macroId: 'vibe', value: 0.5 },
  ]));
  eq(out.actions.length, 0, 'nothing survives');
  assert(out.rejected[0]?.includes('vibe'), 'names the invented macro');
});

check('an action kind nobody implemented is refused', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([{ kind: 'deleteEverything', trackId: vox }]));
  eq(out.actions.length, 0, 'nothing survives');
  assert(out.rejected[0]?.includes('deleteEverything'), 'names the invented kind');
});

check('a non-finite number is refused rather than clamped', () => {
  const { session, vox } = mix();
  // JSON has no NaN, but a bridge that hands back a JS object can.  Clamping
  // NaN produces NaN, and a NaN fader is a silent hole in the mix.
  const out = parsePlan(session, plan([{ kind: 'trackVolume', trackId: vox, db: Number.NaN }]));
  eq(out.actions.length, 0, 'nothing survives');
  const out2 = parsePlan(session, plan([{ kind: 'trackPan', trackId: vox, pan: Number.POSITIVE_INFINITY }]));
  eq(out2.actions.length, 0, 'infinity too');
});

check('garbage in the actions array does not take the plan down with it', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([
    null, 'hello', 42,
    { kind: 'trackVolume', trackId: vox, db: -2 },
  ]));
  eq(out.actions.length, 1, 'the good one still lands');
  eq(out.rejected.length, 3, 'and each bad one is reported');
});

check('a model that returns nothing at all produces an empty plan, not a throw', () => {
  const { session } = mix();
  for (const raw of [null, undefined, 'text', 42, []]) {
    const out = parsePlan(session, raw);
    eq(out.actions.length, 0, `no actions from ${JSON.stringify(raw)}`);
  }
  eq(parsePlan(session, {}).rejected.length, 0, 'an empty object is empty, not broken');
});

// ── The validator: clamping, and saying so ────────────────────────────────────

check('an absurd fader is clamped AND reported', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([{ kind: 'trackVolume', trackId: vox, db: 400 }]));
  eq(out.actions.length, 1, 'the action survives, clamped');
  const action = out.actions[0];
  assert(action?.kind === 'trackVolume' && action.db === 12, 'clamped to the fader top');
  eq(out.rejected.length, 1, 'and the user is told it was not what was asked for');
  assert(out.rejected[0]?.includes('400'), `mentions the original: ${out.rejected[0]}`);
});

check('a parameter is clamped to that device’s own range, not a global one', () => {
  const { session, vox } = mix();
  const spec = findPlugin('eq3')?.params.find((p) => p.id === 'lowDb');
  assert(spec, 'the fixture device has the parameter');
  const out = parsePlan(session, plan([
    { kind: 'insertParam', trackId: vox, pluginId: 'eq3', paramId: 'lowDb', value: 999 },
  ]));
  const action = out.actions[0];
  assert(action?.kind === 'insertParam' && action.value === spec?.max,
    `clamped to ${spec?.max}, got ${action?.kind === 'insertParam' ? action.value : '?'}`);
});

check('a value inside the range is passed through with nothing said', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([
    { kind: 'insertParam', trackId: vox, pluginId: 'eq3', paramId: 'lowDb', value: 2 },
  ]));
  eq(out.rejected.length, 0, 'no complaint');
  const action = out.actions[0];
  assert(action?.kind === 'insertParam' && action.value === 2, 'value untouched');
});

check('pan clamps at the ends', () => {
  const { session, kick } = mix();
  const out = parsePlan(session, plan([{ kind: 'trackPan', trackId: kick, pan: -3 }]));
  const action = out.actions[0];
  assert(action?.kind === 'trackPan' && action.pan === -1, 'hard left, not -3');
  eq(out.rejected.length, 1, 'and said so');
});

// ── The validator: the empty-slot rule ────────────────────────────────────────

check('removing an insert from an empty slot is refused', () => {
  const { session, vox } = mix();
  // The vocal has one insert, in slot 0.
  const out = parsePlan(session, plan([{ kind: 'removeInsert', trackId: vox, slot: 3 }]));
  eq(out.actions.length, 0, 'nothing removed');
  assert(out.rejected[0]?.includes('비어'), `says the slot is empty: ${out.rejected[0]}`);
});

check('removing an insert that is really there is allowed', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([{ kind: 'removeInsert', trackId: vox, slot: 0 }]));
  eq(out.actions.length, 1, 'the occupied slot goes through');
  const after = applyActions(session, out.actions);
  eq(findTrack(after, vox)?.inserts.length, 0, 'and it really is gone');
});

check('bypass with no boolean is refused', () => {
  const { session, vox } = mix();
  const out = parsePlan(session, plan([{ kind: 'bypassInsert', trackId: vox, slot: 0 }]));
  eq(out.actions.length, 0, 'nothing survives');
  const ok = parsePlan(session, plan([
    { kind: 'bypassInsert', trackId: vox, slot: 0, bypass: true },
  ]));
  eq(ok.actions.length, 1, 'with the boolean it goes through');
});

check('a runaway plan is capped, and the cap is reported', () => {
  const { session, vox } = mix();
  const many = Array.from({ length: 200 }, () => ({ kind: 'trackVolume', trackId: vox, db: -2 }));
  const out = parsePlan(session, plan(many));
  assert(out.actions.length <= 24, `capped, got ${out.actions.length}`);
  assert(out.rejected.some((r) => r.includes('200')), 'and says how many were dropped');
});

// ── The validator: what a valid plan does ─────────────────────────────────────

check('a valid plan applies through the same path the UI uses', () => {
  const { session, vox, kick } = mix();
  const out = parsePlan(session, plan([
    { kind: 'trackVolume', trackId: vox, db: -1 },
    { kind: 'trackPan', trackId: kick, pan: -0.3 },
    { kind: 'macro', trackId: vox, macroId: MACROS[0]?.id, value: 0.4 },
  ]));
  eq(out.rejected.length, 0, 'clean plan');
  eq(out.actions.length, 3, 'all three');
  const after = applyActions(session, out.actions);
  eq(findTrack(after, vox)?.volumeDb, -1, 'fader moved');
  eq(findTrack(after, kick)?.pan, -0.3, 'pan moved');
});

check('applying the same plan twice changes nothing the second time', () => {
  // This is what "values are absolute, never relative" buys.  A model that
  // returned "+2 dB" would double on a second press; a final position cannot.
  const { session, vox } = mix();
  const out = parsePlan(session, plan([{ kind: 'trackVolume', trackId: vox, db: -1 }]));
  const once = applyActions(session, out.actions);
  const twice = applyActions(once, out.actions);
  eq(findTrack(twice, vox)?.volumeDb, findTrack(once, vox)?.volumeDb, 'idempotent');
});

check('the model’s own refusal survives into the plan', () => {
  const { session } = mix();
  const out = parsePlan(session, plan([], { refusal: '어느 트랙인지 모르겠습니다' }));
  eq(out.actions.length, 0, 'no actions');
  eq(out.refusal, '어느 트랙인지 모르겠습니다', 'and the reason is kept');
});

// ── The brief ─────────────────────────────────────────────────────────────────

check('the brief names every track with its real id', () => {
  const { session, vox } = mix();
  const brief = sessionBrief(session, vox);
  eq(brief.tracks.length, session.tracks.length, 'every track');
  const entry = brief.tracks.find((t) => t.id === vox);
  assert(entry, 'the vocal is in there under its real id');
  eq(entry?.focused, true, 'and the focused one is marked');
  assert(entry?.inserts.includes('0:eq3'), `its chain is described: ${entry?.inserts.join()}`);
});

check('the brief is byte-identical for an unchanged session', () => {
  // Prompt caching is a prefix match: one wobbling field and the cache never
  // hits.  This is the test that catches a Date.now() sneaking in.
  const { session, vox } = mix();
  eq(JSON.stringify(sessionBrief(session, vox)), JSON.stringify(sessionBrief(session, vox)),
    'same session, same bytes');
});

check('the brief changes when the mix changes', () => {
  const { session, vox } = mix();
  const moved = updateTrack(session, vox, (t) => ({ ...t, volumeDb: -9 }));
  assert(JSON.stringify(sessionBrief(session)) !== JSON.stringify(sessionBrief(moved)),
    'a moved fader shows up');
});

check('the catalogue offers every device in the registry, and only real params', () => {
  const catalog = deviceCatalog();
  eq(catalog.length, PLUGINS.length, 'nothing hand-curated, nothing stale');
  for (const device of catalog) {
    const real = findPlugin(device.id);
    assert(real, `${device.id} is a real device`);
    eq(device.params.length, real?.params.length ?? -1, `${device.id} lists its real params`);
  }
});

check('the catalogue text is stable and mentions the macros', () => {
  eq(catalogText(), catalogText(), 'deterministic');
  for (const macro of macroCatalog()) {
    assert(catalogText().includes(macro.id), `${macro.id} is offered`);
  }
});

check('the system prompt carries the catalogue and the tool name', () => {
  const prompt = systemPrompt(catalogText());
  assert(prompt.includes(PLAN_TOOL_NAME), 'names the tool it must call');
  assert(prompt.includes('eq3'), 'and the devices it may name');
  assert(prompt.includes('최종값'), 'and the absolute-value rule');
});

check('the schema offers exactly the kinds the validator accepts', () => {
  const kinds = PLAN_SCHEMA.properties.actions.items.properties.kind.enum as readonly string[];
  const { session, vox } = mix();
  for (const kind of kinds) {
    // Every advertised kind must be REACHABLE — a schema that offers an action
    // the validator drops is a promise the app does not keep.
    const out = parsePlan(session, plan([{ kind, trackId: vox }]));
    const unknownKind = out.rejected.some((r) => r.includes('할 수 있는 동작이 아닙니다'));
    assert(!unknownKind, `${kind} is advertised but not implemented`);
  }
});

// ── The two engines ───────────────────────────────────────────────────────────

/** A bridge that returns whatever it is handed, and records what it was asked. */
function fakeBridge(answer: unknown, opts: { ready?: boolean; throws?: string } = {}): {
  bridge: AssistantBridge; calls: { text: string; catalog: string }[];
} {
  const calls: { text: string; catalog: string }[] = [];
  return {
    calls,
    bridge: {
      ready: async () => (opts.ready === false
        ? { ok: false, reason: '키가 없습니다' } : { ok: true }),
      ask: async (request) => {
        calls.push({ text: request.text, catalog: request.catalog });
        if (opts.throws) throw new Error(opts.throws);
        return answer;
      },
    },
  };
}

void (async () => {
  await checkAsync('a phrase the parser knows never reaches the model', async () => {
    const { session } = mix();
    const fake = fakeBridge(plan([]));
    setAssistantBridge(fake.bridge);
    const answer = await ask(session, 'Lead Vox 2dB 올려');
    eq(answer.source, 'rules', 'answered locally');
    assert(answer.actions.length > 0, 'and actually answered');
    eq(fake.calls.length, 0, 'nothing left the machine');
  });

  await checkAsync('forceModel sends it anyway', async () => {
    const { session, vox } = mix();
    const fake = fakeBridge(plan([{ kind: 'trackVolume', trackId: vox, db: -3 }]));
    setAssistantBridge(fake.bridge);
    const answer = await ask(session, 'Lead Vox 2dB 올려', { forceModel: true });
    eq(answer.source, 'model', 'the model answered');
    eq(fake.calls.length, 1, 'and was actually asked');
  });

  await checkAsync('a phrase the parser cannot read goes to the model', async () => {
    const { session, vox } = mix();
    const fake = fakeBridge(plan(
      [{ kind: 'insertParam', trackId: vox, pluginId: 'eq3', paramId: 'midDb', value: -3 }],
      { understood: 'Lead Vox 의 중역을 3 dB 깎습니다' },
    ));
    setAssistantBridge(fake.bridge);
    const answer = await ask(session, '보컬이 좀 답답한데 뚫어줘');
    eq(answer.source, 'model', 'the model answered');
    eq(answer.actions.length, 1, 'with one action');
    assert(answer.understood.includes('중역'), 'and a sentence to read first');
    assert(fake.calls[0]?.catalog.includes('eq3'), 'the catalogue went with it');
  });

  await checkAsync('a model plan full of invented names comes back empty, with reasons', async () => {
    const { session } = mix();
    setAssistantBridge(fakeBridge(plan([
      { kind: 'trackVolume', trackId: 'trk_ghost', db: 0 },
      { kind: 'insertParam', trackId: 'trk_ghost', pluginId: 'nope', paramId: 'x', value: 1 },
    ])).bridge);
    const answer = await ask(session, '아무 말이나 해봐 이상하게');
    eq(answer.actions.length, 0, 'nothing to apply');
    assert(answer.rejected.length >= 2, 'and every refusal is visible');
  });

  await checkAsync('no bridge means the parser answers, and says the model is missing', async () => {
    const { session } = mix();
    setAssistantBridge(null);
    eq(hasAssistantBridge(), false, 'no bridge installed');
    const answer = await ask(session, '보컬이 좀 답답한데 뚫어줘');
    eq(answer.source, 'rules', 'still answered by the parser');
    assert(answer.degraded, 'and said why it could not do better');
  });

  await checkAsync('a bridge that is not ready degrades instead of failing', async () => {
    const { session } = mix();
    setAssistantBridge(fakeBridge(plan([]), { ready: false }).bridge);
    const answer = await ask(session, 'Lead Vox 2dB 올려', { forceModel: true });
    eq(answer.source, 'rules', 'falls back to the parser');
    assert(answer.actions.length > 0, 'and still moves the fader it understood');
    assert(answer.degraded?.includes('키'), `with the real reason: ${answer.degraded}`);
  });

  await checkAsync('a bridge that throws degrades with the error text', async () => {
    const { session } = mix();
    setAssistantBridge(fakeBridge(plan([]), { throws: '네트워크에 연결할 수 없습니다' }).bridge);
    const answer = await ask(session, 'Lead Vox 2dB 올려', { forceModel: true });
    eq(answer.source, 'rules', 'falls back');
    eq(answer.degraded, '네트워크에 연결할 수 없습니다', 'and shows what went wrong');
  });

  await checkAsync('an empty instruction asks what to do rather than calling anything', async () => {
    const { session } = mix();
    const fake = fakeBridge(plan([]));
    setAssistantBridge(fake.bridge);
    const answer = await ask(session, '   ');
    eq(answer.actions.length, 0, 'nothing proposed');
    eq(fake.calls.length, 0, 'and nothing sent');
  });

  await checkAsync('history reaches the bridge, so a follow-up has something to refer to', async () => {
    const { session, vox } = mix();
    const fake = fakeBridge(plan([{ kind: 'trackVolume', trackId: vox, db: -2 }]));
    setAssistantBridge(fake.bridge);
    let seen: readonly { role: string; content: string }[] = [];
    setAssistantBridge({
      ready: fake.bridge.ready,
      ask: async (request) => { seen = request.history; return fake.bridge.ask(request); },
    });
    await ask(session, '그럼 반만', {
      history: [{ role: 'user', content: '보컬 올려' }, { role: 'assistant', content: '올렸습니다' }],
    });
    eq(seen.length, 2, 'both turns went along');
  });

  check('the rule parser’s answer converts into the plan shape', () => {
    const { session } = mix();
    const answer = fromInterpretation({ understood: '테스트', actions: [], error: '모르겠습니다' });
    eq(answer.source, 'rules', 'labelled as local');
    eq(answer.refusal, '모르겠습니다', 'the error becomes the refusal');
    eq(answer.rejected.length, 0, 'the parser never half-understands');
    void session;
  });

  setAssistantBridge(null);

  // ── Report ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Natural language: validation · brief · fallback ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
})();
