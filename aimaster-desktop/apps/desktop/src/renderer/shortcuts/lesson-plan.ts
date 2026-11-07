// 단계별 노출 — the first twelve, not all 241.
//
// Every command in this app has a key and the `?` overlay lists all of them,
// which is the right answer for somebody who knows what they are looking for
// and the wrong one for somebody on their first day: 241 rows is not a
// keyboard, it is a reference manual, and nobody learns a keyboard from one.
//
// So the overlay can show a STAGE instead — a dozen at a time, in teaching
// order rather than in the Cubase grouping the table uses.  Stage 1 is enough
// to get a sound in, cut it, undo the cut, save, and send it to mastering,
// which is the whole loop of the first lesson.
//
// ── Why this is its own file ────────────────────────────────────────────────
//
// `definitions.ts` is the source of truth for the dispatcher and the overlay,
// and a teaching order is not a fact about the keyboard — it is a choice about
// a course, it will change between courses, and it should not require touching
// the file the key handling reads.  So the curriculum lives here: one list per
// stage, command ids only.  A typo is caught by the selftest, which checks
// every id against the table.
//
// The order inside a stage is the order it is taught in, and the overlay
// renders a stage in exactly that order.

import type { CommandId } from './definitions.js';

export interface Lesson {
  stage: 1 | 2 | 3;
  title: string;
  /** One line, shown under the chips when this stage is on. */
  note: string;
  /** In teaching order. */
  commands: readonly CommandId[];
}

export const LESSONS: readonly Lesson[] = [
  {
    stage: 1,
    title: '1단계 · 첫 곡',
    note: '소리를 넣고, 듣고, 자르고, 되돌리고, 저장하고, 마스터링으로 보냅니다',
    commands: [
      'daw.importAudio',        // 소리를 넣는다
      'transport.playPause',    // 듣는다
      'transport.returnToZero',
      'view.zoomInH',
      'view.zoomOutH',
      'tool.select',
      'tool.split',             // 자른다
      'edit.splitAtCursor',
      'edit.undo',              // 되돌린다
      'file.save',              // 저장한다
      'daw.sendToMastering',    // 끝낸다
      // 그리고 나머지 229개를 찾는 법 — 이름만 알면 된다.
      'daw.palette',
    ],
  },
  {
    stage: 2,
    title: '2단계 · 다루기',
    note: '복사 · 반복 · 루프 · 솔로와 뮤트 · 페이드 — 편집다운 편집',
    commands: [
      'edit.redo',
      'edit.copy',
      'edit.cut',
      'edit.paste',
      'edit.duplicate',
      'edit.toggleSnap',
      'transport.toggleLoop',
      'loop.toSelection',
      'transport.metronome',
      'track.solo',
      'track.mute',
      'track.clearSoloMute',
      'daw.fadeIn',
      'daw.fadeOut',
      'daw.crossfade',
    ],
  },
  {
    stage: 3,
    title: '3단계 · 믹스와 내보내기',
    note: '믹스콘솔 · 체인 · 프리즈와 커밋 · 바운스와 스템 — 곡을 내보내는 길',
    commands: [
      'window.mixConsole',
      'daw.showChain',
      'daw.smartControls',
      'daw.toggleAutomation',
      'daw.createStack',
      'daw.freeze',
      'daw.commit',
      'daw.separate',
      'daw.showSpectral',
      'daw.showReference',
      'daw.analyzeMix',
      'daw.bounce',
      'daw.exportStems',
      'file.export',
    ],
  },
];

export type StageId = Lesson['stage'];

export function findLesson(stage: StageId): Lesson | undefined {
  return LESSONS.find((l) => l.stage === stage);
}

/** Which stage teaches this command, or null when no stage does. */
export function stageOf(id: CommandId): StageId | null {
  for (const lesson of LESSONS) if (lesson.commands.includes(id)) return lesson.stage;
  return null;
}
