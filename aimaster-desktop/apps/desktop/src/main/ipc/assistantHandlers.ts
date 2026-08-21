// The only place in the app that holds an API key or opens a socket to
// Anthropic.
//
// It lives in the main process for one reason that is not negotiable: the
// renderer runs the user's session, third-party plugin UIs, and everything
// else this app draws.  A key in there is a key on the page.  So the renderer
// sends words and gets back JSON; it never sees the key, and there is no
// channel through which it could ask for one.
//
// The key is stored encrypted with Electron's `safeStorage`, which is backed
// by the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret where it
// exists).  When the platform cannot encrypt — a Linux box with no keyring —
// the key is NOT written in plaintext as a convenience.  It is kept for the
// session only and the user is told, because a mixing app quietly leaving a
// billable credential in a JSON file under ~/.config is not a tradeoff anyone
// asked for.

import type { IpcMain } from 'electron';
import { safeStorage } from 'electron';
import Store from 'electron-store';
import Anthropic from '@anthropic-ai/sdk';
import { PLAN_SCHEMA, PLAN_TOOL_NAME, systemPrompt } from '../../renderer/daw/ai/nl-schema.js';

const store = new Store({ name: 'assistant' });
const KEY_FIELD = 'anthropicKeyEncrypted';

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 4096;
/** A mix instruction that has not answered in this long is not going to. */
const TIMEOUT_MS = 60_000;
/** Enough for "그럼 반만" to resolve; short enough to stay cheap. */
const MAX_HISTORY = 8;
const MAX_TEXT = 2000;

/** Held in memory when the OS cannot encrypt, so the session still works. */
let sessionKey: string | null = null;

function readKey(): string | null {
  if (sessionKey) return sessionKey;
  const stored = store.get(KEY_FIELD);
  if (typeof stored !== 'string' || stored.length === 0) {
    return process.env['ANTHROPIC_API_KEY'] ?? null;
  }
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // A key encrypted on a different machine or under a different OS user.
    // Dropping it is right: it can never be decrypted here again.
    store.delete(KEY_FIELD);
    return null;
  }
}

interface AskRequest {
  text: string;
  brief: unknown;
  /** The device list, built by the renderer from its own plugin registry. */
  catalog: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}

function validRequest(raw: unknown): AskRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const text = record['text'];
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT) return null;
  if (typeof record['brief'] !== 'object' || record['brief'] === null) return null;
  const catalog = record['catalog'];
  if (typeof catalog !== 'string' || catalog.length === 0) return null;
  const history = Array.isArray(record['history']) ? record['history'] : [];
  const turns: AskRequest['history'] = [];
  for (const turn of history.slice(-MAX_HISTORY)) {
    if (typeof turn !== 'object' || turn === null) continue;
    const entry = turn as Record<string, unknown>;
    const role = entry['role'];
    const content = entry['content'];
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.length > 0) {
      turns.push({ role, content: content.slice(0, MAX_TEXT) });
    }
  }
  // The API requires the first message to be a user turn.  A window that
  // happens to open on an assistant reply — trimmed history, a cleared box —
  // would 400 the whole request, so lead turns are dropped rather than sent.
  while (turns.length > 0 && turns[0]?.role !== 'user') turns.shift();
  return { text, brief: record['brief'], catalog, history: turns };
}

let client: Anthropic | null = null;
let clientKey: string | null = null;

function clientFor(key: string): Anthropic {
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS });
    clientKey = key;
  }
  return client;
}

export function registerAssistantHandlers(ipc: IpcMain): void {
  ipc.handle('assistant:status', () => {
    if (!readKey()) return { ok: false, reason: 'API 키가 설정되지 않았습니다' };
    return {
      ok: true,
      model: MODEL,
      // The UI says where the key lives, because "왜 다시 물어보지" has a
      // real answer on a machine with no keyring and the user deserves it.
      persisted: sessionKey === null && typeof store.get(KEY_FIELD) === 'string',
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  });

  ipc.handle('assistant:set-key', (_e, raw: unknown) => {
    if (typeof raw !== 'string' || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(raw.trim())) {
      throw new Error('assistant:set-key: 키 형식이 아닙니다');
    }
    const key = raw.trim();
    if (!safeStorage.isEncryptionAvailable()) {
      sessionKey = key;
      return { ok: true, persisted: false, reason: '이 컴퓨터에서는 키를 안전하게 저장할 수 없어 이번 실행에만 유지합니다' };
    }
    store.set(KEY_FIELD, safeStorage.encryptString(key).toString('base64'));
    sessionKey = null;
    return { ok: true, persisted: true };
  });

  ipc.handle('assistant:clear-key', () => {
    store.delete(KEY_FIELD);
    sessionKey = null;
    client = null;
    clientKey = null;
    return { ok: true };
  });

  ipc.handle('assistant:ask', async (_e, raw: unknown) => {
    const request = validRequest(raw);
    if (!request) throw new Error('assistant:ask: 요청 형식이 잘못됐습니다');
    const key = readKey();
    if (!key) throw new Error('API 키가 설정되지 않았습니다');

    // The device catalogue is the big, unchanging half of the prompt, so it
    // goes in `system` behind a cache breakpoint and the volatile session
    // brief goes in the message.  Getting this backwards would put a cache
    // miss on every single request.
    const response = await clientFor(key).messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [
        { type: 'text', text: systemPrompt(request.catalog), cache_control: { type: 'ephemeral' } },
      ],
      tools: [{
        name: PLAN_TOOL_NAME,
        description: '사용자의 요청을 믹스 동작 목록으로 옮깁니다. 확실하지 않으면 refusal 을 채우세요.',
        input_schema: PLAN_SCHEMA as unknown as Anthropic.Tool['input_schema'],
        // `strict: true` is deliberately NOT set.  It would make the API
        // enforce this schema, which sounds strictly better — but the schema
        // has optional properties (a `macro` action carries no `pluginId`),
        // and whether strict mode accepts that is not something this code can
        // verify without a live key.  Guessing wrong breaks EVERY request.
        // The validator in nl-protocol.ts is the guarantee either way, and it
        // is the one the tests actually exercise.
      }],
      tool_choice: { type: 'tool', name: PLAN_TOOL_NAME },
      messages: [
        ...request.history,
        {
          role: 'user',
          content: [
            `<세션>\n${JSON.stringify(request.brief, null, 1)}\n</세션>`,
            '',
            `요청: ${request.text}`,
          ].join('\n'),
        },
      ],
    });

    // A refusal is an HTTP 200 with no tool call.  Returning it as a plan the
    // renderer can draw beats throwing, which would look like a network fault.
    if (response.stop_reason === 'refusal') {
      return {
        understood: '', actions: [],
        refusal: response.stop_details?.explanation ?? '모델이 이 요청을 거절했습니다',
      };
    }

    const call = response.content.find((block) => block.type === 'tool_use');
    if (!call || call.type !== 'tool_use') {
      const text = response.content.find((b) => b.type === 'text');
      return {
        understood: '', actions: [],
        refusal: (text && text.type === 'text' ? text.text : '') || '모델이 동작을 제안하지 않았습니다',
      };
    }
    // Handed back unvalidated on purpose: the renderer's `parsePlan` is the
    // wall, and having one wall rather than two halves is what makes it
    // testable without a key.
    return call.input;
  });
}
