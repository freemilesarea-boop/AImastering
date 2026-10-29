// What each surface offers when you right-click it.
//
// Data, not UI: the four menus are lists of command ids with a few one-off
// actions, which keeps them readable side by side and lets a selftest ask the
// questions that matter — does every id exist, is every surface non-empty,
// does a menu offer something destructive without saying so.
//
// The ORDER follows the surfaces of the app rather than the keymap's groups:
// what you do to a clip most often is cut it and fade it, so those are at the
// top where the pointer already is.  Anything that opens a window goes last,
// because a menu item that replaces the screen should not sit next to one
// that nudges a value.

import type { CommandId } from '../../shortcuts/definitions.js';
import type { MenuItem } from '../../stores/contextMenuStore.js';

/**
 * A clip in the arrange lane.
 *
 * Almost all command ids, because right-clicking a clip SELECTS it first —
 * which is what every DAW does and what makes `daw.separate` and
 * `daw.renameClip` act on the thing under the pointer without this file
 * knowing how either of them works.  The two actions left are the ones with
 * no command: opening the editor the clip's kind needs, and deleting this one
 * clip rather than the selected range.
 */
export function clipMenu(opts: {
  onOpenEditor: () => void;
  onDelete: () => void;
  kind: 'audio' | 'midi';
}): MenuItem[] {
  return [
    { kind: 'action', label: '편집기에서 열기', run: opts.onOpenEditor },
    { kind: 'command', id: 'daw.renameClip' },
    { kind: 'separator' },
    { kind: 'header', label: '자르기 · 붙이기' },
    { kind: 'command', id: 'daw.separate' },
    { kind: 'command', id: 'daw.heal' },
    { kind: 'command', id: 'daw.trimToSelection' },
    { kind: 'command', id: 'daw.consolidate' },
    { kind: 'separator' },
    { kind: 'header', label: '페이드' },
    { kind: 'command', id: 'daw.fadeIn' },
    { kind: 'command', id: 'daw.fadeOut' },
    { kind: 'command', id: 'daw.crossfade' },
    ...(opts.kind === 'audio' ? [
      { kind: 'separator' as const },
      { kind: 'header' as const, label: '오디오' },
      { kind: 'command' as const, id: 'daw.clipGainUp' as CommandId },
      { kind: 'command' as const, id: 'daw.clipGainDown' as CommandId },
      { kind: 'command' as const, id: 'daw.normalizeClip' as CommandId },
      { kind: 'command' as const, id: 'daw.reverseClip' as CommandId },
      { kind: 'command' as const, id: 'daw.quantizeAudio' as CommandId },
      { kind: 'command' as const, id: 'daw.showWarp' as CommandId },
      { kind: 'command' as const, id: 'daw.showRestore' as CommandId },
    ] : []),
    { kind: 'separator' },
    { kind: 'command', id: 'daw.bounceSelection' },
    { kind: 'command', id: 'daw.spotClip' },
    { kind: 'separator' },
    { kind: 'action', label: '클립 삭제', run: opts.onDelete, danger: true },
  ];
}

/** A track header in the arrange window. */
export function trackMenu(opts: {
  onDelete: (() => void) | null;
  onInserts: () => void;
  /** Stacks only make sense on a track that is in one, or could lead one. */
  inStack: boolean;
}): MenuItem[] {
  return [
    { kind: 'command', id: 'daw.renameTrack' },
    { kind: 'command', id: 'daw.duplicateTrack' },
    { kind: 'separator' },
    { kind: 'header', label: '보기' },
    { kind: 'command', id: 'daw.trackHeightUp' },
    { kind: 'command', id: 'daw.trackHeightDown' },
    { kind: 'command', id: 'daw.hideTracks' },
    { kind: 'command', id: 'daw.showAllTracks' },
    { kind: 'command', id: 'daw.toggleAutomation' },
    { kind: 'separator' },
    { kind: 'header', label: '처리' },
    { kind: 'action', label: '인서트 창', run: opts.onInserts },
    { kind: 'command', id: 'daw.smartControls' },
    { kind: 'command', id: 'daw.freeze' },
    { kind: 'command', id: 'daw.commit' },
    { kind: 'command', id: 'daw.bounce' },
    { kind: 'separator' },
    { kind: 'command', id: opts.inStack ? 'daw.unpackStack' : 'daw.createStack' },
    ...(opts.onDelete === null
      // The master has no delete, and saying so beats offering a dead item:
      // the edit window already hides its delete button for the same reason.
      ? [{ kind: 'action' as const, label: '트랙 삭제 (마스터는 삭제할 수 없습니다)',
           run: () => {}, disabled: true }]
      : [{ kind: 'separator' as const },
         { kind: 'action' as const, label: '트랙 삭제', run: opts.onDelete, danger: true }]),
  ];
}

/** A channel strip in the mix console. */
export function mixerMenu(opts: {
  onInserts: () => void;
  /** Master and VCA strips carry no clips and no inserts worth freezing. */
  isMaster: boolean;
}): MenuItem[] {
  return [
    { kind: 'action', label: '인서트 창', run: opts.onInserts },
    { kind: 'command', id: 'daw.showChain' },
    { kind: 'separator' },
    { kind: 'header', label: '채널' },
    { kind: 'command', id: 'track.solo' },
    { kind: 'command', id: 'track.mute' },
    { kind: 'command', id: 'daw.toggleSoloSafe' },
    { kind: 'command', id: 'track.clearSoloMute' },
    { kind: 'separator' },
    { kind: 'header', label: '설정 복사' },
    { kind: 'command', id: 'daw.copyChannel' },
    { kind: 'command', id: 'daw.pasteChannel' },
    ...(opts.isMaster ? [] : [
      { kind: 'separator' as const },
      { kind: 'header' as const, label: '트랙 딜레이' },
      { kind: 'command' as const, id: 'daw.trackDelayEarlier' as CommandId },
      { kind: 'command' as const, id: 'daw.trackDelayLater' as CommandId },
      { kind: 'command' as const, id: 'daw.trackDelayClear' as CommandId },
    ]),
    { kind: 'separator' },
    { kind: 'command', id: 'daw.smartControls' },
  ];
}

/** One insert slot, filled or empty. */
export function insertMenu(opts: {
  /** null when the slot is empty — most of the menu is then unavailable. */
  pluginName: string | null;
  bypassed: boolean;
  onOpen: () => void;
  onToggleBypass: () => void;
  onRemove: () => void;
  onInserts: () => void;
}): MenuItem[] {
  if (opts.pluginName === null) {
    return [
      { kind: 'action', label: '인서트 창에서 고르기', run: opts.onInserts },
    ];
  }
  return [
    { kind: 'action', label: `${opts.pluginName} 열기`, run: opts.onOpen },
    { kind: 'action', label: opts.bypassed ? '바이패스 해제' : '바이패스', run: opts.onToggleBypass },
    { kind: 'separator' },
    { kind: 'action', label: '인서트 창', run: opts.onInserts },
    { kind: 'separator' },
    { kind: 'action', label: '이 슬롯 비우기', run: opts.onRemove, danger: true },
  ];
}
