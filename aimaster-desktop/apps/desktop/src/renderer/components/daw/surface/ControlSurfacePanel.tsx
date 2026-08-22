// The control surface panel — what is wired to what.
//
// Two things this window is built around, both learned from setting up real
// desks:
//
//   THE ACTIVITY LINE IS THE MOST USEFUL THING HERE.  Every message that
//   arrives is printed with what it is bound to, or with nothing.  "The desk
//   is talking and nothing is listening" is the single most common state to be
//   in while mapping, and it is invisible without this.
//
//   LEARN IS A MODE, NOT A DIALOG.  Pick what you want to control, press
//   learn, wiggle the knob.  The list is the editor.

import React, { useEffect, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import { useControlSurfaceStore, surfaceConflicts } from '../../../stores/controlSurfaceStore.js';
import { useRecordingStore } from '../../../stores/recordingStore.js';
import {
  MODE_LABELS, SWITCH_LABELS, TRANSPORT_LABELS,
  describeSource,
  type ControlAction, type ControlBinding, type ControlMode,
} from '../../../daw/model/control-surface.js';
import { availableTargets, describeTarget } from '../../../daw/edit/automation-lanes.js';
import { listMidiOutputs } from '../../../daw/engine/midi-input.js';
import { premium } from '../../../theme/premium.js';

const MODES: ControlMode[] = ['absolute', 'relative', 'toggle', 'trigger'];

/** What the binding drives, in words, using the session for the names. */
function describeAction(
  session: ReturnType<typeof useDawStore.getState>['session'], action: ControlAction,
): string {
  if (action.kind === 'transport') return `트랜스포트 · ${TRANSPORT_LABELS[action.command]}`;
  const track = session.tracks.find((t) => t.id === action.trackId);
  if (!track) return '없는 트랙';
  if (action.kind === 'trackSwitch') return `${track.name} · ${SWITCH_LABELS[action.what]}`;
  return `${track.name} · ${describeTarget(track, action.target)}`;
}

export default function ControlSurfacePanel() {
  const session = useDawStore((s) => s.session);
  const close = useWorkspaceStore((s) => s.setPanel);
  const midiDevices = useRecordingStore((s) => s.midiDevices);
  const refreshMidiDevices = useRecordingStore((s) => s.refreshMidiDevices);

  const {
    enabled, deviceId, feedback, outputId, outputName, bindings, learning, lastSeen, error,
  } = useControlSurfaceStore();
  const [midiOutputs, setMidiOutputs] = useState<Array<{ id: string; name: string; connected: boolean }>>([]);
  const store = useControlSurfaceStore;

  useEffect(() => { store.getState().refresh(); }, [store]);
  useEffect(() => { void refreshMidiDevices(); }, [refreshMidiDevices]);
  useEffect(() => {
    void listMidiOutputs().then(setMidiOutputs).catch(() => setMidiOutputs([]));
  }, [enabled]);

  const conflicts = surfaceConflicts();

  // What can be learned, built from the session so it always matches reality.
  const targets: Array<{ label: string; action: ControlAction }> = [];
  for (const command of Object.keys(TRANSPORT_LABELS) as Array<keyof typeof TRANSPORT_LABELS>) {
    targets.push({
      label: `트랜스포트 · ${TRANSPORT_LABELS[command]}`,
      action: { kind: 'transport', command },
    });
  }
  for (const track of session.tracks) {
    for (const what of ['mute', 'solo', 'recordArm'] as const) {
      targets.push({
        label: `${track.name} · ${SWITCH_LABELS[what]}`,
        action: { kind: 'trackSwitch', trackId: track.id, what },
      });
    }
    for (const target of availableTargets(track)) {
      targets.push({
        label: `${track.name} · ${describeTarget(track, target)}`,
        action: { kind: 'param', trackId: track.id, target },
      });
    }
  }

  return (
    <div
      className="fixed right-3 top-14 bottom-3 w-[420px] z-40 rounded-xl overflow-hidden flex flex-col"
      style={{
        background: premium.surface.frame,
        border: `1px solid ${premium.surface.hairline}`,
        boxShadow: premium.shadow.panel,
        fontFamily: premium.type.sans,
      }}
    >
      <div className="flex items-center gap-2 px-3 h-9 shrink-0"
           style={{ background: premium.gradient.frame, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="text-[12px] font-medium flex-1"
              style={{ fontFamily: premium.type.display, color: premium.accent.light }}>
          컨트롤 서피스
        </span>
        <button onClick={() => void store.getState().setEnabled(!enabled)}
                title="켜면 MIDI 입력을 계속 열어 둡니다 (트랙 무장과 무관)"
                style={{
                  height: 22, padding: '0 10px', borderRadius: 3, fontSize: 9.5, letterSpacing: '0.1em',
                  color: enabled ? premium.text.onAccent : premium.text.muted,
                  background: enabled ? premium.accent.base : premium.surface.well,
                  border: `1px solid ${enabled ? premium.accent.deep : premium.surface.hairline}`,
                }}>
          {enabled ? 'ON' : 'OFF'}
        </button>
        <button onClick={() => close('surface', false)} title="닫기"
                className="w-5 h-5 rounded text-[12px] leading-none"
                style={{ color: premium.text.muted }}>×</button>
      </div>

      <div className="px-3 py-2 flex flex-col gap-2 shrink-0"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>장치</span>
          <select value={deviceId ?? ''}
                  onChange={(e) => void store.getState().setDeviceId(e.target.value || null)}
                  className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
                  style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}>
            <option value="">모든 MIDI 입력</option>
            {midiDevices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.connected ? '' : ' (분리됨)'}</option>
            ))}
          </select>
        </div>

        {/* Feedback — its own switch, because it fails in the opposite
            direction: a desk that reads but does not light is merely plain,
            while writing to something that is actually a synth plays notes. */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>피드백</span>
          <button onClick={() => void store.getState().setFeedback(!feedback)}
                  title="세션 상태를 데스크로 보냅니다 — 모터 페이더와 버튼 LED"
                  style={{
                    height: 22, padding: '0 10px', borderRadius: 3, fontSize: 9.5, letterSpacing: '0.1em',
                    color: feedback ? premium.text.onAccent : premium.text.muted,
                    background: feedback ? premium.accent.base : premium.surface.well,
                    border: `1px solid ${feedback ? premium.accent.deep : premium.surface.hairline}`,
                  }}>
            {feedback ? 'ON' : 'OFF'}
          </button>
          <select value={outputId ?? ''}
                  onChange={(e) => void store.getState().setOutputId(e.target.value || null)}
                  disabled={!feedback}
                  className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
                  style={{
                    color: feedback ? premium.text.primary : premium.text.faint,
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}>
            <option value="">입력과 같은 이름의 출력</option>
            {midiOutputs.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.connected ? '' : ' (분리됨)'}</option>
            ))}
          </select>
        </div>

        {/* Which desk is actually being written to — the setting says what was
            asked for, this says what happened. */}
        {feedback && (
          <div className="text-[9px] px-1" style={{ color: outputName ? premium.text.faint : premium.accent.danger }}>
            {outputName ? `출력: ${outputName}` : '출력을 찾지 못했습니다 — 입력은 그대로 동작합니다'}
          </div>
        )}

        {/* The activity line.  "The desk is talking, nothing is listening" is
            invisible without it, and it is the state people get stuck in. */}
        <div className="h-6 rounded px-2 flex items-center gap-2 text-[9.5px]"
             style={{
               background: premium.surface.well,
               border: `1px solid ${lastSeen?.boundTo ? premium.accent.deep : premium.surface.hairline}`,
               fontFamily: premium.type.mono,
               color: lastSeen ? premium.text.secondary : premium.text.faint,
             }}>
          {lastSeen
            ? <>
                <span className="truncate">{lastSeen.text}</span>
                <span style={{ color: lastSeen.boundTo ? premium.accent.base : premium.accent.danger }}>
                  {lastSeen.boundTo ? `→ ${lastSeen.boundTo}` : '→ 연결 안 됨'}
                </span>
              </>
            : enabled ? '노브를 움직여 보세요…' : 'OFF — 켜면 여기에 들어오는 메시지가 보입니다'}
        </div>

        {error && (
          <span className="text-[9.5px]" style={{ color: premium.accent.danger }}>{error}</span>
        )}

        {conflicts.length > 0 && (
          <span className="text-[9.5px]" style={{ color: premium.accent.danger }}>
            같은 컨트롤에 매핑이 {conflicts.length}건 겹칩니다 — 하나만 동작합니다
          </span>
        )}
      </div>

      {/* Learn */}
      <div className="px-3 py-2 flex items-center gap-2 shrink-0"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {learning ? (
          <>
            <span className="text-[10px] flex-1 truncate" style={{ color: premium.accent.base }}>
              {describeAction(session, learning)} — 컨트롤을 움직이세요
            </span>
            <button onClick={() => store.getState().cancelLearn()} style={linkButton(premium.text.muted)}>
              취소
            </button>
          </>
        ) : (
          <>
            <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>학습</span>
            <select
              value=""
              onChange={(e) => {
                const chosen = targets[Number(e.target.value)];
                if (chosen) store.getState().startLearn(chosen.action);
              }}
              className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
              style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}
            >
              <option value="">연결할 대상을 고르세요…</option>
              {targets.map((t, i) => <option key={`${t.label}-${i}`} value={i}>{t.label}</option>)}
            </select>
          </>
        )}
      </div>

      {/* The list is the editor. */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
        {bindings.length === 0 && (
          <span className="text-[10px] leading-relaxed" style={{ color: premium.text.faint }}>
            아직 매핑이 없습니다. 위에서 대상을 고르고 컨트롤을 움직이면 연결됩니다.
          </span>
        )}
        {bindings.map((binding) => (
          <BindingRow key={binding.id} binding={binding} session={session} />
        ))}
      </div>

      <div className="px-3 py-2 flex items-center gap-3 shrink-0"
           style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={() => void store.getState().exportToFile()}
                title="매핑 전체를 파일로 저장합니다"
                style={linkButton(premium.text.faint)}>내보내기</button>
        <button onClick={() => void store.getState().importFromFile()}
                title="매핑 파일을 읽어 옵니다"
                style={linkButton(premium.text.faint)}>가져오기</button>
        <span className="flex-1" />
        {bindings.length > 0 && (
          <button onClick={() => store.getState().clearAll()}
                  title="매핑을 전부 지웁니다"
                  style={linkButton(premium.accent.danger)}>전부 삭제</button>
        )}
      </div>
    </div>
  );
}

function BindingRow(
  { binding, session }: {
    binding: ControlBinding;
    session: ReturnType<typeof useDawStore.getState>['session'];
  },
) {
  const store = useControlSurfaceStore;
  const continuous = binding.mode === 'absolute' || binding.mode === 'relative';
  const action = binding.action;
  const missing = action.kind !== 'transport'
    && !session.tracks.some((t) => t.id === action.trackId);

  return (
    <div className="rounded px-2 py-1.5 flex flex-col gap-1"
         style={{ background: premium.surface.well, border: `1px solid ${premium.surface.hairline}` }}>
      <div className="flex items-center gap-2">
        <span className="text-[9.5px] shrink-0" style={{
          color: premium.accent.base, fontFamily: premium.type.mono,
        }}>{describeSource(binding.source)}</span>
        <span className="text-[10px] truncate flex-1"
              style={{ color: missing ? premium.accent.danger : premium.text.secondary }}
              title={describeAction(session, binding.action)}>
          → {describeAction(session, binding.action)}
        </span>
        <button onClick={() => store.getState().remove(binding.id)} title="이 매핑을 지웁니다"
                className="w-4 h-4 rounded text-[9px] leading-none"
                style={{ color: premium.text.muted, border: '1px solid rgba(255,255,255,0.12)' }}>×</button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <select value={binding.mode}
                onChange={(e) => store.getState().edit(binding.id, { mode: e.target.value as ControlMode })}
                title="이 컨트롤이 어떤 종류인가"
                style={miniSelect}>
          {MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
        </select>

        {continuous && (
          <>
            <button
              onClick={() => store.getState().edit(binding.id, { invert: !binding.invert })}
              title="진행 방향을 뒤집습니다"
              style={chip(binding.invert)}
            >INV</button>
            {binding.mode === 'absolute' && (
              <button
                onClick={() => store.getState().edit(binding.id, {
                  takeover: binding.takeover === 'pickup' ? 'jump' : 'pickup',
                })}
                title={binding.takeover === 'pickup'
                  ? '픽업 — 컨트롤이 현재 값을 지나야 넘겨받습니다'
                  : '점프 — 만지는 즉시 컨트롤 위치로 갑니다'}
                style={chip(binding.takeover === 'pickup')}
              >{binding.takeover === 'pickup' ? 'PICKUP' : 'JUMP'}</button>
            )}
            {binding.mode === 'relative' && (
              <button
                onClick={() => store.getState().edit(binding.id, {
                  relative: binding.relative === 'signedBit' ? 'twosComplement' : 'signedBit',
                })}
                title="엔코더 인코딩 — 방향이 반대로 튀면 바꿔 보세요"
                style={chip(true)}
              >{binding.relative === 'signedBit' ? 'SIGNED' : '2COMP'}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const miniSelect: React.CSSProperties = {
  height: 20, borderRadius: 3, fontSize: 9,
  background: 'transparent', color: premium.text.muted,
  border: '1px solid rgba(255,255,255,0.12)',
};

function chip(on: boolean): React.CSSProperties {
  return {
    height: 20, padding: '0 6px', borderRadius: 3, fontSize: 8.5, letterSpacing: '0.08em',
    color: on ? premium.text.onAccent : premium.text.muted,
    background: on ? premium.accent.base : 'transparent',
    border: `1px solid ${on ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
  };
}

function linkButton(color: string): React.CSSProperties {
  return {
    fontSize: 9, letterSpacing: '0.04em', color,
    background: 'transparent', border: 'none', padding: 0,
    textDecoration: 'underline', textUnderlineOffset: 2,
  };
}
