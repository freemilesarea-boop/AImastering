// assistant-reply-selftest — what the mix assistant does with the model's
// answer, and which key it uses to ask.
//
// `assistantHandlers.ts` had no test: it imports `safeStorage` from electron
// and the Anthropic SDK at module load, so every decision in it needed a live
// key and a running main process to reach.  Two of them were wrong.
//
//   · A plan cut off at the token ceiling was applied as a smaller plan.
//     `stop_reason: 'max_tokens'` was never checked, so the handler read the
//     tool call that WAS there and handed its partial input to `parsePlan`,
//     which validates each action, finds nothing wrong with the ones that
//     arrived, and lets the app apply four of the seven moves the user asked
//     for with nothing saying so.  The request allows 24 actions and 4096
//     output tokens, and on this model those tokens also pay for adaptive
//     thinking — so the ceiling is reachable, not theoretical.
//
//   · `ANTHROPIC_API_KEY` could not be reached whenever a stored key existed
//     and the platform had no encryption — the ordinary Linux case after a
//     keyring goes away.  The app told a user who had just exported the
//     variable that no key was set.
//
// Run: pnpm --filter @aimaster/desktop test:assistant-reply

export {};

import { REPLY_MESSAGES, planFromResponse } from '../src/main/ipc/assistant-reply.js';

/**
 * Models that accept `tool_choice: {type: 'tool'}`, and models that reject it.
 *
 * Here rather than beside the request because nothing in the app reads them —
 * an export only its own test can reach is exactly what the dead-exports
 * ratchet refuses, and it refused these.
 */
const MODELS_ACCEPTING_FORCED_TOOL_USE: readonly string[] = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
];
const MODELS_REJECTING_FORCED_TOOL_USE: readonly string[] = [
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5',
];
import { KEY_PATTERN, resolveAssistantKey } from '../src/main/utils/assistant-key.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

type Resp = Parameters<typeof planFromResponse>[0];
const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const OTHER = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ9876543210';

/** A tool call the way the SDK hands one over. */
const toolCall = (input: unknown): Resp['content'][number] =>
  ({ type: 'tool_use', id: 'toolu_1', name: 'propose_mix_plan', input } as Resp['content'][number]);
const text = (t: string): Resp['content'][number] =>
  ({ type: 'text', text: t, citations: null } as unknown as Resp['content'][number]);

const PLAN = {
  understood: '보컬을 올리고 드럼을 줄입니다',
  actions: [{ kind: 'gain', trackId: 't1', db: 2 }, { kind: 'gain', trackId: 't2', db: -1.5 }],
};

function main(): void {
  console.log('\n=== A PLAN THAT WAS CUT OFF IS NOT A SMALLER PLAN ===\n');

  {
    // What the API returns when generation stops at the cap part-way through
    // the tool input: the actions that were complete, and nothing else to say
    // they are not all of them.
    const partial = {
      understood: '보컬을 올리고 드럼을 줄이고 리버브를',
      actions: [{ kind: 'gain', trackId: 't1', db: 2 }],
    };
    const cut = planFromResponse({
      content: [toolCall(partial)], stop_reason: 'max_tokens', stop_details: null,
    });
    check(
      'an answer cut off at the token ceiling is refused, not applied',
      cut.kind === 'refused',
      cut.kind === 'refused' ? `refusal: ${cut.plan.refusal}` : 'HANDED BACK AS A PLAN',
    );
    check(
      'and it says so in words the user can act on',
      cut.kind === 'refused' && cut.plan.refusal === REPLY_MESSAGES.truncated
        && cut.plan.actions.length === 0,
      cut.kind === 'refused' ? `"${cut.plan.refusal}", ${cut.plan.actions.length} action(s)` : '—',
    );
    check(
      'the partial tool call it carried is NOT what comes back',
      cut.kind === 'refused' && !JSON.stringify(cut.plan).includes('t1'),
      // Says what came back, not what should have: the first version of this
      // detail read the same whether it passed or failed.
      cut.kind === 'refused'
        ? 'the one complete action is dropped with the rest of the answer'
        : `the partial plan came back: ${JSON.stringify(cut.input).slice(0, 80)}`,
    );
  }

  {
    const ok = planFromResponse({
      content: [toolCall(PLAN)], stop_reason: 'tool_use', stop_details: null,
    });
    check(
      'a complete plan is handed over untouched, for the renderer to validate',
      ok.kind === 'plan' && ok.input === PLAN,
      ok.kind === 'plan' ? `${(ok.input as typeof PLAN).actions.length} action(s), same object` : 'refused',
    );
  }

  {
    // `end_turn` with a tool call is the ordinary success shape too: the
    // model answered and stopped, and nothing was truncated.
    const ok = planFromResponse({
      content: [text('이렇게 하겠습니다'), toolCall(PLAN)], stop_reason: 'end_turn', stop_details: null,
    });
    check(
      'a plan that arrives with commentary beside it is still a plan',
      ok.kind === 'plan',
      ok.kind === 'plan' ? 'tool call found past the text block' : 'refused',
    );
  }

  console.log('\n=== AND THE OTHER THREE ENDINGS STILL READ CORRECTLY ===\n');

  {
    const r = planFromResponse({
      content: [], stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: '요청을 수행할 수 없습니다' },
    } as Resp);
    check(
      "a refusal shows the model's own explanation",
      r.kind === 'refused' && r.plan.refusal === '요청을 수행할 수 없습니다',
      r.kind === 'refused' ? r.plan.refusal : '—',
    );
    const bare = planFromResponse({ content: [], stop_reason: 'refusal', stop_details: null });
    check(
      'and falls back to our own wording when it gives none',
      bare.kind === 'refused' && bare.plan.refusal === REPLY_MESSAGES.refusal,
      bare.kind === 'refused' ? bare.plan.refusal : '—',
    );
  }

  {
    const chat = planFromResponse({
      content: [text('어떤 트랙을 말씀하시는 건가요?')], stop_reason: 'end_turn', stop_details: null,
    });
    check(
      'an answer with no plan in it comes back as what the model said',
      chat.kind === 'refused' && chat.plan.refusal === '어떤 트랙을 말씀하시는 건가요?',
      chat.kind === 'refused' ? chat.plan.refusal : '—',
    );
    const silent = planFromResponse({
      content: [text('   ')], stop_reason: 'end_turn', stop_details: null,
    });
    check(
      'and whitespace is not an answer',
      silent.kind === 'refused' && silent.plan.refusal === REPLY_MESSAGES.noPlan,
      silent.kind === 'refused' ? silent.plan.refusal : '—',
    );
  }

  console.log('\n=== THE MODEL AND `tool_choice` ARE COUPLED, SO SAY SO ===\n');

  {
    // Read the configured model out of the handler rather than repeating it:
    // the point is that THIS file's model and the forced tool call agree.
    const src = readFileSync('src/main/ipc/assistantHandlers.ts', 'utf8');
    const model = /const MODEL = '([^']+)'/.exec(src)?.[1] ?? '';
    const forced = /tool_choice:\s*\{\s*type:\s*'(tool|any)'/.test(src);
    check(
      'the configured model accepts the forced tool call the request makes',
      !forced || MODELS_ACCEPTING_FORCED_TOOL_USE.includes(model),
      forced
        ? `${model} + tool_choice:tool — rejected by ${MODELS_REJECTING_FORCED_TOOL_USE.join(', ')}`
        : `${model}, no forced tool use`,
    );
    check(
      'and the two lists do not overlap, so the check cannot pass both ways',
      MODELS_ACCEPTING_FORCED_TOOL_USE.every((m) => !MODELS_REJECTING_FORCED_TOOL_USE.includes(m)),
      `${MODELS_ACCEPTING_FORCED_TOOL_USE.length} accept, ${MODELS_REJECTING_FORCED_TOOL_USE.length} reject`,
    );
  }

  console.log('\n=== AND THE KEY THE REQUEST IS MADE WITH ===\n');

  const base = {
    sessionKey: null, stored: null, canEncrypt: true,
    decrypt: () => { throw new Error('nothing stored'); },
    env: undefined,
  };

  {
    const r = resolveAssistantKey({
      ...base, stored: 'ciphertext', canEncrypt: false, env: KEY,
    });
    check(
      'a stored key this machine cannot decrypt no longer hides ANTHROPIC_API_KEY',
      r.key === KEY && r.source === 'env' && r.storedUnusable,
      `source ${r.source}, stored marked unusable: ${r.storedUnusable}`,
    );
  }

  {
    const r = resolveAssistantKey({
      ...base, stored: 'ciphertext',
      decrypt: () => { throw new Error('wrong machine'); }, env: KEY,
    });
    check(
      'and neither does one that throws when decrypted',
      r.key === KEY && r.source === 'env' && r.storedUnusable,
      `source ${r.source}`,
    );
  }

  {
    const r = resolveAssistantKey({ ...base, stored: 'ciphertext', decrypt: () => OTHER, env: KEY });
    check(
      'a decryptable stored key wins over the environment',
      r.key === OTHER && r.source === 'keychain' && !r.storedUnusable,
      `source ${r.source}`,
    );
    const session = resolveAssistantKey({
      ...base, sessionKey: KEY, stored: 'ciphertext', decrypt: () => OTHER,
    });
    check(
      'and a session key, set because the OS could not encrypt, wins over both',
      session.key === KEY && session.source === 'session',
      `source ${session.source}`,
    );
  }

  {
    const corrupt = resolveAssistantKey({
      ...base, stored: 'ciphertext', decrypt: () => 'not-a-key', env: undefined,
    });
    check(
      'a stored entry that decrypts to something that is not a key reads as absent',
      corrupt.key === null && corrupt.storedUnusable,
      'refused rather than sent to the API',
    );
    const junkEnv = resolveAssistantKey({ ...base, env: 'hunter2' });
    check(
      'and so does a junk environment variable',
      junkEnv.key === null && junkEnv.source === null,
      'ANTHROPIC_API_KEY must look like a key to be used',
    );
  }

  {
    check(
      'the pattern the setter enforces is the pattern the resolver trusts',
      KEY_PATTERN.test(KEY) && !KEY_PATTERN.test('sk-ant-short')
        && readFileSync('src/main/ipc/assistantHandlers.ts', 'utf8').includes('KEY_PATTERN.test'),
      'one pattern, used by both',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

import { readFileSync } from 'node:fs';

main();
