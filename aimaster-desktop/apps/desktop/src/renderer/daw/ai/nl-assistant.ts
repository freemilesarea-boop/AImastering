// The natural-language front end, with two engines behind one door.
//
// The rule parser in language.ts understands a small grammar exactly.  A model
// understands everything approximately.  Neither is the right answer alone:
//
//   "보컬 2dB 올려"            the parser gets this right, instantly, offline,
//                              for free.  Sending it to a model is a worse
//                              product in every measurable way.
//
//   "보컬이 좀 답답한데 뚫어줘"  the parser has no rule for this and says so.
//                              A model reads the brief, sees an eq3 already in
//                              slot 0, and proposes a mid cut.
//
// So the parser goes FIRST and the model is the fallback, not the other way
// around.  That ordering is the whole design: the common case never leaves the
// machine, never costs anything, and never waits on a network.  The model is
// what happens when the deterministic thing has already admitted it does not
// understand — which is exactly the moment its approximation is worth the
// round trip.
//
// The bridge is injectable.  Tests drive the whole path — brief, plan,
// validation, fallback — with a fake, because a feature whose tests need an
// API key is a feature that stops being tested.

import { interpret, type Interpretation } from './language.js';
import { parsePlan, type Plan } from './nl-protocol.js';
import { catalogText, sessionBrief } from './nl-context.js';
import type { DawSession, TrackId } from '../model/types.js';

/** Where an answer came from.  Shown in the UI — the user should always know. */
export type AnswerSource = 'rules' | 'model';

export interface Answer extends Plan {
  source: AnswerSource;
  /** Set when the model was wanted but could not be reached. */
  degraded?: string;
}

/**
 * What the main process must provide.
 *
 * Deliberately tiny and JSON-only: the renderer never sees an SDK object, a
 * key, or a stream.  It sends words and a brief and gets back a plan-shaped
 * blob whose contents it does not trust — that is `parsePlan`'s job.
 */
export interface AssistantBridge {
  ready(): Promise<{ ok: boolean; reason?: string }>;
  ask(request: {
    text: string;
    brief: unknown;
    /** The device list.  Sent every time; cached on the far side. */
    catalog: string;
    /** Prior turns, oldest first — "그럼 반만" needs to know what "그" was. */
    history: readonly { role: 'user' | 'assistant'; content: string }[];
  }): Promise<unknown>;
}

let bridge: AssistantBridge | null = null;

/** Injected once at startup by the renderer, and by tests with a fake. */
export function setAssistantBridge(next: AssistantBridge | null): void {
  bridge = next;
}

export function hasAssistantBridge(): boolean {
  return bridge !== null;
}

/** The rule parser's answer, in the plan shape the UI draws. */
export function fromInterpretation(interpretation: Interpretation): Answer {
  return {
    source: 'rules',
    understood: interpretation.understood,
    actions: interpretation.actions,
    rejected: [],
    ...(interpretation.error ? { refusal: interpretation.error } : {}),
  };
}

export interface AskOptions {
  focusedTrackId?: TrackId | null;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  /**
   * Skip the rule parser and go straight to the model.
   *
   * For when the parser was right about the grammar and wrong about the
   * intent — "마스터 넓게" parses, but the user meant something else and wants
   * a second opinion.  Never the default: see the ordering argument above.
   */
  forceModel?: boolean;
}

/**
 * One instruction in, one plan out.  Applies nothing.
 *
 * The failure ladder is the interesting part.  If the model cannot be reached
 * the parser's answer is returned WITH the reason attached, so the user gets
 * whatever could be understood plus an honest note — rather than an error
 * screen in place of an answer the app could have given offline.
 */
export async function ask(
  session: DawSession, text: string, options: AskOptions = {},
): Promise<Answer> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { source: 'rules', understood: '', actions: [], rejected: [], refusal: '무엇을 할까요?' };
  }

  const focused = options.focusedTrackId ?? null;
  const rules = interpret(session, trimmed, focused);

  // The parser understood it.  Nothing leaves the machine.
  if (!options.forceModel && rules.actions.length > 0) return fromInterpretation(rules);

  if (!bridge) return withDegraded(rules, '언어 모델이 설정되지 않았습니다');

  const ready = await bridge.ready().catch(() => ({ ok: false, reason: '모델에 연결하지 못했습니다' }));
  if (!ready.ok) return withDegraded(rules, ready.reason ?? '모델을 쓸 수 없습니다');

  let raw: unknown;
  try {
    raw = await bridge.ask({
      text: trimmed,
      brief: sessionBrief(session, focused),
      catalog: catalogText(),
      history: options.history ?? [],
    });
  } catch (error) {
    return withDegraded(rules, reasonOf(error));
  }

  const plan = parsePlan(session, raw);

  // The model answered but nothing survived validation, and the parser had
  // something.  The parser's answer is the better one to show.
  if (plan.actions.length === 0 && rules.actions.length > 0) {
    return {
      ...fromInterpretation(rules),
      rejected: plan.rejected,
      ...(plan.refusal ? { degraded: plan.refusal } : {}),
    };
  }

  return { ...plan, source: 'model' };
}

function withDegraded(rules: Interpretation, why: string): Answer {
  const answer = fromInterpretation(rules);
  return { ...answer, degraded: why };
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '모델 호출이 실패했습니다';
}

// ── The real bridge ───────────────────────────────────────────────────────────

interface ElectronInvoke { invoke(channel: string, ...args: unknown[]): Promise<unknown> }

/**
 * The bridge that talks to the main process.
 *
 * Returns null outside Electron — the browser build, Storybook, a test — so
 * the caller keeps the rule parser and nothing throws on a missing `window`.
 */
export function ipcBridge(): AssistantBridge | null {
  const api = (globalThis as { electronAPI?: ElectronInvoke }).electronAPI;
  if (!api) return null;
  return {
    ready: async () => {
      const status = await api.invoke('assistant:status');
      if (typeof status === 'object' && status !== null && 'ok' in status) {
        return status as { ok: boolean; reason?: string };
      }
      return { ok: false, reason: '모델 상태를 확인하지 못했습니다' };
    },
    ask: (request) => api.invoke('assistant:ask', request),
  };
}
