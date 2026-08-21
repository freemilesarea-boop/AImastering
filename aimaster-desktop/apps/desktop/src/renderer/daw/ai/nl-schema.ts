// The wire contract, with nothing behind it.
//
// This file has ZERO imports, and that is its entire reason for existing.
// The main process needs the tool schema and the system prompt to build a
// request; it must not need the plugin registry, the session model, or
// anything else that assumes a Web Audio context and a DOM.  Importing
// nl-protocol.ts from main would drag the whole renderer audio engine into the
// Electron main bundle to read two constants.
//
// So the contract lives here, alone, and both sides import it.

/**
 * The JSON shape handed to the model as a tool schema.
 *
 * Written out rather than generated so that what the model is told and what
 * `parsePlan` enforces can be read side by side.  When they drift, the
 * validator wins and the user gets a refusal — annoying but never unsafe.
 */
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understood', 'actions'],
  properties: {
    understood: {
      type: 'string',
      description: '이 계획이 무엇을 하는지 한 문장으로. 사용자의 언어로 씁니다.',
    },
    refusal: {
      type: 'string',
      description:
        '요청을 액션으로 옮길 수 없을 때만 채웁니다. 왜 못 하는지 한 문장. '
        + '추측해서 액션을 만드느니 여기에 이유를 쓰는 편이 낫습니다.',
    },
    actions: {
      type: 'array',
      description: '적용할 동작들. 확실하지 않으면 비워 두고 refusal 을 채우세요.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'trackVolume', 'trackPan', 'macro',
              'insertParam', 'addInsert', 'removeInsert', 'bypassInsert',
            ],
          },
          trackId: { type: 'string', description: '브리핑에 있는 트랙 id 그대로.' },
          db: { type: 'number', description: 'trackVolume 의 최종 페이더 값 (상대값 아님).' },
          pan: { type: 'number', description: 'trackPan. -1 = 완전 좌, +1 = 완전 우.' },
          macroId: { type: 'string' },
          value: { type: 'number', description: 'macro 는 0…1, insertParam 은 그 파라미터의 단위.' },
          pluginId: { type: 'string', description: '장치 목록에 있는 id 그대로.' },
          paramId: { type: 'string', description: '그 장치가 실제로 가진 파라미터 id.' },
          slot: { type: 'number', description: '인서트 슬롯 0…9.' },
          bypass: { type: 'boolean' },
        },
      },
    },
  },
} as const;

export const PLAN_TOOL_NAME = 'propose_mix_actions';

// ── The instruction ───────────────────────────────────────────────────────────

/**
 * The system prompt, including the device catalogue.
 *
 * The catalogue is passed in rather than read from the plugin registry so this
 * file stays import-free — and, more usefully, so the caller can put the whole
 * thing behind ONE cache breakpoint.  It is long, it is identical on every
 * request, and it is the difference between a cheap feature and an expensive
 * one.  Anything that varies per request belongs in the message, not here.
 *
 * Two rules in the text are load-bearing.  It tells the model to REFUSE rather
 * than guess, because a plausible wrong fader move costs more than a question.
 * And it forbids relative values: "2 dB 올려" becomes a final fader position
 * computed from the brief, so applying the same plan twice does not move
 * anything twice — the actions are absolute and the undo stack stays honest.
 */
export function systemPrompt(catalog: string): string {
  return [
    '당신은 DAW 안에서 사용자의 말을 믹스 동작으로 옮기는 보조자입니다.',
    '',
    `동작은 ${PLAN_TOOL_NAME} 도구로만 제안하고, 세션을 직접 바꾸지 않습니다.`,
    '제안한 동작은 사용자가 문장으로 읽고 동의해야 적용됩니다.',
    '',
    '규칙:',
    '1. 브리핑에 있는 트랙 id 와 아래 장치 목록에 있는 장치 · 파라미터 id 만',
    '   씁니다. 지어내면 거절됩니다.',
    '2. 값은 전부 **최종값**입니다. "2dB 올려" 는 현재 볼륨에 2 를 더한 값을 씁니다.',
    '3. 어떤 트랙인지 확실하지 않으면 동작을 만들지 말고 refusal 에 이유를 쓰세요.',
    '   틀린 페이더 이동보다 "어느 트랙인지 모르겠습니다" 가 낫습니다.',
    '4. 요청에 없는 것은 하지 않습니다. 한 트랙을 올려 달라는 말은 다른 트랙을',
    '   내려 달라는 말이 아닙니다.',
    '5. understood 는 사용자의 언어로 한 문장입니다.',
    '',
    '<장치>',
    catalog,
    '</장치>',
  ].join('\n');
}
