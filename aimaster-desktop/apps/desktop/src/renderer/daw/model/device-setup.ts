// Device setup — what is plugged in, and whether anything can hear it.
//
// The panel that shows this is a list of pickers, and a list of pickers is not
// worth testing.  What IS worth testing is the diagnosis: a keyboard can be
// connected, selected, and completely inaudible, and the difference between
// "plug it in" and "arm a track" is the difference between a five-second fix
// and half an hour of unplugging cables.
//
// So the rules live here, as data, and the panel renders them.  Each rule
// below is a state a real rig gets into:
//
//   Web MIDI missing entirely            → nothing to configure, say why
//   Ports listed but all disconnected    → the driver remembers gear that left
//   A chosen port that is no longer there → the picker falls back to "all"
//                                            silently, which reads as a fault
//   Ports fine, nothing armed, audition off → the connected-but-silent case
//   Auditioning with no instrument track  → nowhere to send the notes
//
// The last two are the ones this file exists for.  They are the states where
// every cable is right and no sound comes out.

/** A MIDI port as the device list reports it. */
export interface DevicePort {
  id: string;
  name: string;
  connected: boolean;
}

/** An audio input as the browser reports it. */
export interface DeviceInput {
  id: string;
  label: string;
}

export interface DeviceSetupInput {
  /** Whether the runtime has Web MIDI at all. */
  midiSupported: boolean;
  /** Why it does not, when it does not. */
  midiFailure?: string | null;
  midiInputs: DevicePort[];
  midiOutputs: DevicePort[];
  audioInputs: DeviceInput[];
  /** `null` means "every input port", which is the default and is fine. */
  selectedMidiInputId?: string | null;
  /** How many instrument tracks are armed for MIDI right now. */
  armedMidiCount: number;
  /** How many instrument tracks exist at all. */
  instrumentTrackCount: number;
  /** Whether audition (hear the keyboard without arming) is on. */
  audition: boolean;
  /** Whether a MIDI port is actually open at this moment. */
  midiOpen: boolean;
}

export type DeviceStatus = 'ok' | 'warn' | 'blocked';

export interface DeviceLine {
  /** Stable key, so a test names a rule instead of matching its prose. */
  key: string;
  status: DeviceStatus;
  title: string;
  detail: string;
  /** What to do about it.  Absent when there is nothing to do. */
  fix?: string;
}

const RANK: Record<DeviceStatus, number> = { ok: 0, warn: 1, blocked: 2 };

/** The worst status in a report — what the panel's header should show. */
export function deviceSetupStatus(lines: readonly DeviceLine[]): DeviceStatus {
  let worst: DeviceStatus = 'ok';
  for (const line of lines) if (RANK[line.status] > RANK[worst]) worst = line.status;
  return worst;
}

/** Ports the OS still lists but that are no longer answering. */
export function connectedPorts(ports: readonly DevicePort[]): DevicePort[] {
  return ports.filter((p) => p.connected);
}

/**
 * Whether the chosen input port is still present.
 *
 * `null` (every port) is always resolvable.  A named port that has gone is the
 * case worth reporting: the open call falls back to every port, which works,
 * so nothing errors and the only symptom is that a filter the user set is
 * quietly not in force.
 */
export function midiSelectionResolves(
  selectedId: string | null | undefined,
  ports: readonly DevicePort[],
): boolean {
  if (!selectedId) return true;
  return ports.some((p) => p.id === selectedId);
}

/** The audio half of the report. */
function audioLines(input: DeviceSetupInput): DeviceLine[] {
  if (input.audioInputs.length === 0) {
    return [{
      key: 'audio.none',
      status: 'warn',
      title: '오디오 입력 없음',
      detail: '녹음할 수 있는 입력 장치가 보이지 않습니다.',
      fix: '오디오 인터페이스를 연결한 뒤 새로고침하세요.',
    }];
  }
  // Empty labels are the browser's way of saying permission has never been
  // granted.  The devices are real; their names are not readable yet.
  const unnamed = input.audioInputs.filter((d) => d.label.trim() === '').length;
  if (unnamed === input.audioInputs.length) {
    return [{
      key: 'audio.unnamed',
      status: 'warn',
      title: '입력 이름을 읽을 수 없음',
      detail: `${input.audioInputs.length}개 입력이 있지만 이름이 비어 있습니다.`,
      fix: '마이크 권한을 한 번 허용하면 장치 이름이 보입니다.',
    }];
  }
  return [{
    key: 'audio.ok',
    status: 'ok',
    title: '오디오 입력 준비됨',
    detail: `${input.audioInputs.length}개 입력을 사용할 수 있습니다.`,
  }];
}

/** The MIDI half of the report. */
function midiLines(input: DeviceSetupInput): DeviceLine[] {
  if (!input.midiSupported) {
    return [{
      key: 'midi.unsupported',
      status: 'blocked',
      title: 'MIDI를 쓸 수 없음',
      detail: input.midiFailure?.trim()
        ? input.midiFailure
        : '이 실행 환경에 Web MIDI가 없습니다.',
      fix: '마스터 건반은 이 환경에서 동작하지 않습니다.',
    }];
  }

  // The API being present is not the same as it working.  `requestMIDIAccess`
  // exists and then rejects — no ALSA, no CoreMIDI, permission denied — and
  // the port list comes back empty either way.  Reporting that as "no device
  // connected" sends someone to re-seat a USB cable that was never the
  // problem, so a live failure reason outranks an empty list.
  const failure = input.midiFailure?.trim() ?? '';
  if (failure !== '') {
    return [{
      key: 'midi.failed',
      status: 'blocked',
      title: 'MIDI를 열지 못함',
      detail: failure,
      fix: '장치를 연결한 뒤 새로고침을 눌러 다시 시도하세요 — 앱을 켠 뒤에 연결해도 됩니다.',
    }];
  }

  const live = connectedPorts(input.midiInputs);
  if (input.midiInputs.length === 0) {
    return [{
      key: 'midi.none',
      status: 'warn',
      title: '연결된 MIDI 입력 없음',
      detail: 'MIDI 입력 포트가 하나도 보이지 않습니다.',
      fix: 'USB로 마스터 건반을 연결한 뒤 새로고침하세요.',
    }];
  }
  if (live.length === 0) {
    // The port list outlives the hardware: unplugging a keyboard leaves its
    // name behind with state "disconnected" until the driver forgets it.
    return [{
      key: 'midi.disconnected',
      status: 'warn',
      title: 'MIDI 장치가 응답하지 않음',
      detail: `${input.midiInputs.length}개 포트가 목록에 있지만 모두 연결이 끊겼습니다.`,
      fix: 'USB를 다시 꽂거나 전원을 확인하세요.',
    }];
  }

  const lines: DeviceLine[] = [];
  if (!midiSelectionResolves(input.selectedMidiInputId, input.midiInputs)) {
    lines.push({
      key: 'midi.selection-gone',
      status: 'warn',
      title: '선택한 MIDI 장치가 사라짐',
      detail: '지정해 둔 입력 포트가 목록에 없어 모든 포트를 듣고 있습니다.',
      fix: '입력 장치를 다시 고르세요.',
    });
  }

  if (input.armedMidiCount > 0) {
    lines.push({
      key: 'midi.armed',
      status: 'ok',
      title: '건반 연결됨',
      detail: `${live.length}개 포트 · 무장된 악기 트랙 ${input.armedMidiCount}개로 들어갑니다.`,
    });
    return lines;
  }

  if (input.instrumentTrackCount === 0) {
    lines.push({
      key: 'midi.no-instrument',
      status: 'warn',
      title: '소리 낼 악기 트랙이 없음',
      detail: '건반은 연결됐지만 노트를 받을 악기 트랙이 없습니다.',
      fix: '악기 트랙을 하나 추가하세요.',
    });
    return lines;
  }

  if (!input.audition) {
    // The state this file exists for: everything is plugged in, the port is
    // listed, and pressing a key does nothing at all.
    lines.push({
      key: 'midi.silent',
      status: 'warn',
      title: '건반이 연결됐지만 아무도 듣지 않음',
      detail: '무장된 트랙이 없고 오디션도 꺼져 있어 건반을 눌러도 소리가 나지 않습니다.',
      fix: '오디션을 켜거나 악기 트랙을 녹음 무장하세요.',
    });
    return lines;
  }

  lines.push({
    key: 'midi.audition',
    status: 'ok',
    title: '오디션 중',
    detail: input.midiOpen
      ? `${live.length}개 포트가 열려 있고, 무장 없이 바로 들립니다.`
      : `${live.length}개 포트가 보입니다.  포트를 여는 중입니다.`,
  });
  return lines;
}

/**
 * The whole report, MIDI first — it is the half that goes wrong.
 */
export function deviceSetupReport(input: DeviceSetupInput): DeviceLine[] {
  return [...midiLines(input), ...audioLines(input)];
}
