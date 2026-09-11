// Device setup — one window for everything that is plugged in.
//
// Before this existed, the audio input picker lived in the record strip, the
// MIDI input picker lived in two different places (the record strip and the
// control surface panel, meaning two different things), and the answer to
// "I plugged in my keyboard, why is it silent?" was not written down anywhere.
//
// The diagnosis is `deviceSetupReport` in the model — it is the part worth
// testing, and it is what makes this more than three dropdowns.  This file
// draws it and owns the pickers.

import React, { useEffect } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import { useRecordingStore } from '../../../stores/recordingStore.js';
import { isMidiSupported, midiFailureReason, listMidiOutputs } from '../../../daw/engine/midi-input.js';
import { trackRecordKind, armedSplit } from '../../../daw/model/recording.js';
import {
  deviceSetupReport, deviceSetupStatus, type DeviceLine, type DevicePort,
} from '../../../daw/model/device-setup.js';
import { premium } from '../../../theme/premium.js';

const STATUS_COLOR: Record<DeviceLine['status'], string> = {
  ok: premium.accent.good,
  warn: premium.accent.base,
  blocked: premium.accent.danger,
};

const STATUS_WORD: Record<DeviceLine['status'], string> = {
  ok: '정상',
  warn: '확인 필요',
  blocked: '사용 불가',
};

export default function DeviceSetupPanel() {
  const session = useDawStore((s) => s.session);
  const close = useWorkspaceStore((s) => s.setPanel);

  const devices = useRecordingStore((s) => s.devices);
  const midiDevices = useRecordingStore((s) => s.midiDevices);
  const settings = useRecordingStore((s) => s.settings);
  const audition = useRecordingStore((s) => s.audition);
  const midiOpen = useRecordingStore((s) => s.midiOpen);
  const midiNote = useRecordingStore((s) => s.midiNote);
  const store = useRecordingStore;

  const [midiOutputs, setMidiOutputs] = React.useState<DevicePort[]>([]);

  const refresh = React.useCallback(() => {
    void store.getState().refreshDevices();
    void store.getState().refreshMidiDevices();
    void listMidiOutputs()
      .then((ports) => setMidiOutputs(ports.map(
        (p) => ({ id: p.id, name: p.name, connected: p.connected }))))
      .catch(() => setMidiOutputs([]));
  }, [store]);

  useEffect(() => { refresh(); }, [refresh]);

  const instrumentTracks = session.tracks.filter((t) => trackRecordKind(t) === 'midi');
  const report = deviceSetupReport({
    midiSupported: isMidiSupported(),
    midiFailure: midiFailureReason(),
    midiInputs: midiDevices.map((d) => ({ id: d.id, name: d.name, connected: d.connected })),
    midiOutputs,
    audioInputs: devices.map((d) => ({ id: d.id, label: d.label })),
    selectedMidiInputId: settings.midiInputId ?? null,
    armedMidiCount: armedSplit(session).midi.length,
    instrumentTrackCount: instrumentTracks.length,
    audition,
    midiOpen,
  });
  const overall = deviceSetupStatus(report);

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
          디바이스 셋업
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ color: STATUS_COLOR[overall], border: `1px solid ${STATUS_COLOR[overall]}` }}>
          {STATUS_WORD[overall]}
        </span>
        <button onClick={refresh} title="장치 목록을 다시 읽습니다"
                className="text-[9px] px-2 h-5 rounded"
                style={{ color: premium.text.muted, border: `1px solid ${premium.surface.hairline}` }}>
          새로고침
        </button>
        <button onClick={() => close('deviceSetup', false)} title="닫기"
                className="w-5 h-5 rounded text-[12px] leading-none"
                style={{ color: premium.text.muted }}>×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3">
        {/* The diagnosis first.  Every other control on this panel is a thing
            you might change; this is the thing you came to find out. */}
        <div className="flex flex-col gap-1.5">
          {report.map((line) => (
            <div key={line.key} className="rounded px-2 py-1.5"
                 style={{
                   background: premium.surface.well,
                   borderLeft: `2px solid ${STATUS_COLOR[line.status]}`,
                 }}>
              <div className="text-[10.5px]" style={{ color: premium.text.primary }}>{line.title}</div>
              <div className="text-[9.5px] mt-0.5" style={{ color: premium.text.secondary }}>{line.detail}</div>
              {line.fix && (
                <div className="text-[9.5px] mt-0.5" style={{ color: STATUS_COLOR[line.status] }}>
                  → {line.fix}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Audition — the switch the diagnosis points at. */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-wide shrink-0 w-14" style={{ color: premium.text.faint }}>
            오디션
          </span>
          <button onClick={() => void store.getState().setAudition(!audition)}
                  title="무장하지 않아도 건반 소리가 들립니다 — 포커스된 악기 트랙으로 들어갑니다"
                  style={{
                    height: 22, padding: '0 10px', borderRadius: 3, fontSize: 9.5, letterSpacing: '0.1em',
                    color: audition ? premium.text.onAccent : premium.text.muted,
                    background: audition ? premium.accent.base : premium.surface.well,
                    border: `1px solid ${audition ? premium.accent.deep : premium.surface.hairline}`,
                  }}>
            {audition ? 'ON' : 'OFF'}
          </button>
          <div className="flex-1 h-5 rounded px-2 flex items-center text-[9.5px]"
               style={{
                 background: premium.surface.well,
                 border: `1px solid ${midiNote ? premium.accent.deep : premium.surface.hairline}`,
                 fontFamily: premium.type.mono,
                 color: midiNote ? premium.accent.light : premium.text.faint,
               }}>
            {midiNote ? `note ${midiNote.pitch} · vel ${midiNote.velocity}` : '건반을 누르면 여기에 표시됩니다'}
          </div>
        </div>

        {/* MIDI input. */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-wide shrink-0 w-14" style={{ color: premium.text.faint }}>
            MIDI 입력
          </span>
          <select value={settings.midiInputId ?? ''}
                  onChange={(e) => void store.getState()
                    .setSettings({ midiInputId: e.target.value || null })}
                  className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
                  style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}>
            <option value="">모든 MIDI 입력</option>
            {midiDevices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.connected ? '' : ' (분리됨)'}</option>
            ))}
          </select>
        </div>

        {/* MIDI output — listed, not selected here: the only thing that writes
            to a MIDI output is the control surface's feedback, and its picker
            lives with the bindings it belongs to. */}
        <div className="flex flex-col gap-1">
          <span className="text-[9px] tracking-wide" style={{ color: premium.text.faint }}>MIDI 출력</span>
          {midiOutputs.length === 0
            ? <div className="text-[9.5px] px-1" style={{ color: premium.text.faint }}>출력 포트 없음</div>
            : midiOutputs.map((d) => (
              <div key={d.id} className="text-[9.5px] px-1"
                   style={{ color: d.connected ? premium.text.secondary : premium.text.faint }}>
                {d.name}{d.connected ? '' : ' (분리됨)'}
              </div>
            ))}
        </div>

        {/* Audio inputs. */}
        <div className="flex flex-col gap-1">
          <span className="text-[9px] tracking-wide" style={{ color: premium.text.faint }}>오디오 입력</span>
          {devices.length === 0
            ? <div className="text-[9.5px] px-1" style={{ color: premium.text.faint }}>입력 장치 없음</div>
            : devices.map((d) => (
              <div key={d.id} className="text-[9.5px] px-1 flex gap-2"
                   style={{ color: premium.text.secondary }}>
                <span className="flex-1 truncate">{d.label || '(이름 없음)'}</span>
                <span style={{ color: premium.text.faint, fontFamily: premium.type.mono }}>
                  {store.getState().widthOf(d.id)}ch
                </span>
              </div>
            ))}
        </div>

        <div className="text-[9px] leading-relaxed px-1" style={{ color: premium.text.faint }}>
          트랙별 입력 배정은 녹음 스트립에서 합니다.  이 창은 어떤 장치가 붙어 있는지와
          왜 소리가 안 나는지를 봅니다.
        </div>
      </div>
    </div>
  );
}
