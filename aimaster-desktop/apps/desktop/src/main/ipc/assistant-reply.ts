// What the assistant does with the model's answer, and the one answer it used
// to mistake for a plan.
//
// Pulled out of `assistantHandlers.ts` so these decisions can be tested: that
// file imports electron (`safeStorage`) and the Anthropic SDK at module load,
// so nothing in it could be reached from a test without a live key.
//
// ── A plan that was cut off is not a smaller plan ───────────────────────────
//
// `stop_reason` has four outcomes this code has to tell apart, and it used to
// read two of them:
//
//   refusal     → handled: returned as a refusal the renderer can draw
//   tool_use    → handled: the plan
//   no tool call → handled: whatever text came back, as a refusal
//   max_tokens  → NOT handled, and this is the dangerous one
//
// The request asks for up to 24 actions (`MAX_ACTIONS` in nl-protocol) and
// allows 4096 output tokens for the whole response — which on this model also
// pays for adaptive thinking, since thinking tokens count against
// `max_tokens`.  When generation stops at the cap part-way through the tool
// input, the API returns what it could parse: an object with `understood` and
// the actions that were complete.  `parsePlan` then validates those actions,
// finds nothing wrong with them, and the app applies FOUR of the seven moves
// the user asked for with nothing anywhere saying so.
//
// Half a mix instruction applied silently is worse than none, so a cut-off
// answer is reported as a refusal that says it was cut off.
import type Anthropic from '@anthropic-ai/sdk';

/** The shape the renderer's `parsePlan` accepts — it validates the contents. */
export interface RefusedPlan {
  understood: string;
  actions: never[];
  refusal: string;
}

export type ReplyDecision =
  | { kind: 'plan'; input: unknown }
  | { kind: 'refused'; plan: RefusedPlan };

/** Reasons the user is shown, kept here so a test can assert on them. */
export const REPLY_MESSAGES = {
  refusal: '모델이 이 요청을 거절했습니다',
  truncated: '답이 길어서 중간에 끊겼습니다 — 요청을 나눠서 다시 말씀해 주세요',
  noPlan: '모델이 동작을 제안하지 않았습니다',
} as const;

function refused(refusal: string): ReplyDecision {
  return { kind: 'refused', plan: { understood: '', actions: [], refusal } };
}

function firstText(response: Pick<Anthropic.Message, 'content'>): string {
  for (const block of response.content) {
    if (block.type === 'text' && block.text.trim().length > 0) return block.text;
  }
  return '';
}

/**
 * Turn one response into either a plan to validate or a refusal to show.
 *
 * Takes the response rather than making the call, so every branch is reachable
 * from a test with a constructed object and none of them needs an API key.
 */
export function planFromResponse(
  response: Pick<Anthropic.Message, 'content' | 'stop_reason' | 'stop_details'>,
): ReplyDecision {
  // A refusal is an HTTP 200 with no tool call.  Returning it as a plan the
  // renderer can draw beats throwing, which would look like a network fault.
  if (response.stop_reason === 'refusal') {
    return refused(response.stop_details?.explanation ?? REPLY_MESSAGES.refusal);
  }

  // Cut off at the token ceiling.  Checked BEFORE the tool call is read,
  // because the tool call is exactly what will be there and be incomplete.
  if (response.stop_reason === 'max_tokens') {
    return refused(REPLY_MESSAGES.truncated);
  }

  const call = response.content.find((block) => block.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    return refused(firstText(response) || REPLY_MESSAGES.noPlan);
  }

  // Handed back unvalidated on purpose: the renderer's `parsePlan` is the
  // wall, and having one wall rather than two halves is what makes it
  // testable without a key.
  return { kind: 'plan', input: call.input };
}

// ── The model id and `tool_choice` are coupled ──────────────────────────────
//
// The request forces the plan tool, which is right for this job — but forced
// tool use was REMOVED on the 5.5 generation and on Fable/Mythos 5.1: there
// `tool_choice: {type: 'any'}` and `{type: 'tool'}` return a 400 on every
// request, `count_tokens` and Batches included.  The replacement is
// `{type: 'auto'}` plus an instruction naming the tool, with `strict: true`
// or structured outputs to keep the arguments schema-valid.
//
// So a one-word model bump would break every request with a 400 that says
// nothing about this file.  `assistant-reply-selftest` holds the configured
// model against the two lists of models that accept and reject it; the lists
// live there rather than here because nothing in the app reads them, and an
// export only a test can reach is what the dead-exports ratchet is for.
