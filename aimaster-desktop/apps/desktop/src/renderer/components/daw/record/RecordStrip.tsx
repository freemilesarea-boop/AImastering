// RecordStrip — the record controls that live in the transport bar.
//
// It shows what the take WILL be before it happens: the plan line spells out
// count-in, pre-roll and punch in words, so nobody has to press record to find
// out where it starts.  The input meter is always live once a track is armed,
// because "is the mic actually working" is the question being asked at that
// moment, not after the take.

import React, { useEffect, useMemo } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useRecordingStore } from '../../../stores/recordingStore.js';
import {
  DEFAULT_TRACK_INPUT, armedSplit, armedTracks, canRecord, describeArmed, describePlan,
  planRecording,
} from '../../../daw/model/recording.js';
import { pitchName } from '../../../daw/model/midi.js';
import { premium } from '../../../theme/premium.js';
import { describeInput, resolveTrackInput, trackInputRef } from '../../../daw/model/track-input.js';
import { describePatch, patchOptions } from '../../../daw/model/input-channels.js';
import { LATENCY_LABELS, describeLatency } from '../../../daw/model/input-latency.js';

export default function RecordStrip() {
  const session = useDawStore((s) => s.session);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const selection = useDawStore((s) => s.selection);
  const loopEnabled = useDawStore((s) => s.loopEnabled);
  const loopStartSec = useDawStore((s) => s.loopStartSec);
  const loopEndSec = useDawStore((s) => s.loopEndSec);
  const notify = useAppStore((s) => s.notify);

  const {
    status, settings, devices, midiDevices, midiOpen, midiNote,
    inputs, levels, elapsedSec, lastTakeNote, calibrating, error,
  } = useRecordingStore();
  const setSettings = useRecordingStore((s) => s.setSettings);
  const setTrackInput = useRecordingStore((s) => s.setTrackInput);
  const refreshDevices = useRecordingStore((s) => s.refreshDevices);
  const refreshMidiDevices = useRecordingStore((s) => s.refreshMidiDevices);
  const start = useRecordingStore((s) => s.start);
  const stop = useRecordingStore((s) => s.stop);
  const setLatency = useRecordingStore((s) => s.setLatency);
  const calibrateLatency = useRecordingStore((s) => s.calibrateLatency);
  const widthOf = useRecordingStore((s) => s.widthOf);

  const armed = armedTracks(session);
  const rolling = status === 'recording' || status === 'countIn';
  const split = armedSplit(session);
  const hasMidi = split.midi.length > 0;
  const readiness = canRecord(session, settings, { midiOpen });

  useEffect(() => {
    if (error) notify(error, 'warning');
  }, [error, notify]);

  useEffect(() => {
    if (lastTakeNote) notify(`MIDI 테이크: ${lastTakeNote}`, 'info');
  }, [lastTakeNote, notify]);

  const plan = useMemo(() => planRecording(
    session, settings, playheadSec,
    loopEnabled ? { startSec: loopStartSec, endSec: loopEndSec } : null,
  ), [session, settings, playheadSec, loopEnabled, loopStartSec, loopEndSec]);

  const usePunchFromSelection = (): void => {
    const length = Math.abs(selection.endSec - selection.startSec);
    if (length < 0.05) { notify('펀치 구간으로 쓸 선택이 없습니다', 'warning'); return; }
    setSettings({
      punchEnabled: true,
      punchStartSec: Math.min(selection.startSec, selection.endSec),
      punchEndSec: Math.max(selection.startSec, selection.endSec),
    });
  };

  return (
    <div className="flex items-center gap-1.5 px-3 py-1 border-b border-zinc-800 bg-[#101017] flex-wrap"
         style={{ fontFamily: premium.type.sans }}>
      <button
        onClick={() => (rolling ? void stop() : void start())}
        disabled={!rolling && !readiness.ok}
        title={rolling ? '녹음 정지' : (readiness.reason ?? '녹음 시작 (Numpad *)')}
        className="h-7 px-3 rounded border text-[11px] flex items-center gap-1.5"
        style={{
          background: rolling ? '#C03030' : readiness.ok ? 'rgba(192,48,48,0.22)' : premium.surface.well,
          borderColor: rolling ? '#E05555' : readiness.ok ? 'rgba(224,85,85,0.5)' : premium.surface.hairline,
          color: rolling ? '#fff' : readiness.ok ? '#F0A0A0' : premium.text.faint,
          cursor: !rolling && !readiness.ok ? 'default' : 'pointer',
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>●</span>
        {rolling ? (status === 'countIn' ? '카운트인' : `REC ${elapsedSec.toFixed(1)}s`) : 'REC'}
      </button>

      {status === 'committing' && (
        <span style={{ fontSize: 11, color: premium.accent.base }}>테이크 기록 중…</span>
      )}

      {hasMidi && (
        <>
          {/* The keyboard's own meter: the last key played.  "Is the keyboard
              reaching the app" is the question being asked while arming. */}
          <div className="h-4 w-20 rounded-sm shrink-0 flex items-center justify-center"
               style={{
                 background: midiNote ? premium.accent.good : premium.surface.well,
                 border: `1px solid ${midiNote ? premium.accent.good : premium.surface.hairline}`,
                 fontFamily: premium.type.mono, fontSize: 9.5,
                 color: midiNote ? premium.text.onAccent : premium.text.faint,
                 transition: 'background 90ms linear',
               }}
               title={midiOpen
                 ? `마지막으로 들어온 노트 — ${split.midi.length}개 인스트루먼트 트랙으로 갑니다`
                 : 'MIDI 입력이 열려 있지 않습니다'}>
            {midiNote
              ? `${pitchName(midiNote.pitch)} ${Math.round(midiNote.velocity * 127)}`
              : midiOpen ? `MIDI ×${split.midi.length}` : '—'}
          </div>

          <select
            value={settings.midiInputId ?? ''}
            onFocus={() => { if (midiDevices.length === 0) void refreshMidiDevices(); }}
            onChange={(e) => setSettings({ midiInputId: e.target.value || null })}
            title="MIDI 입력 장치 — 비워 두면 연결된 모든 입력을 받습니다"
            style={selectStyle}
          >
            <option value="">모든 MIDI 입력</option>
            {midiDevices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.connected ? '' : ' (분리됨)'}</option>
            ))}
          </select>

          <Toggle on={settings.midiSustainPedal}
                  onClick={() => setSettings({ midiSustainPedal: !settings.midiSustainPedal })}
                  title="서스테인 페달(CC64)을 노트 길이로 기록합니다">PED</Toggle>
        </>
      )}

      <Toggle on={settings.monitoring === 'on'}
              onClick={() => setSettings({ monitoring: settings.monitoring === 'on' ? 'off' : 'on' })}
              title="입력 모니터링 — 무장한 모든 트랙의 인서트를 통과해서 들립니다">MON</Toggle>

      {/* Round-trip compensation.  The number is shown, not hidden behind a
          preference, because whether it is measured or merely reported changes
          how much of it to believe. */}
      <Toggle on={settings.latencyEnabled && settings.latencySource !== 'none'}
              onClick={() => setLatency({ enabled: !settings.latencyEnabled })}
              title={describeLatency({
                seconds: settings.latencySec,
                source: settings.latencySource,
                enabled: settings.latencyEnabled,
              })}>
        LAT {(settings.latencySec * 1000).toFixed(1)}
      </Toggle>

      <button
        onClick={() => void calibrateLatency()}
        disabled={calibrating || status !== 'armed'}
        title={'루프백 보정 — 출력을 입력으로 되돌려 연결(또는 스피커와 마이크)한 뒤 누르세요. '
          + '클릭을 재생하고 돌아온 시각을 재서 왕복 지연을 구합니다. '
          + `현재: ${LATENCY_LABELS[settings.latencySource]} · 오차 약 ±3 ms (렌더 블록 경계)`}
        style={{
          height: 24, padding: '0 8px', borderRadius: 3,
          fontFamily: premium.type.sans, fontSize: 9.5, letterSpacing: '0.1em',
          color: status === 'armed' ? premium.text.muted : premium.text.faint,
          background: premium.surface.well,
          border: `1px solid ${premium.surface.hairline}`,
          cursor: calibrating || status !== 'armed' ? 'default' : 'pointer',
        }}
      >{calibrating ? '측정 중…' : '보정'}</button>

      <label style={labelStyle} title="녹음 전에 굴러가는 트랜스포트 시간. 이 구간은 버려집니다.">
        PRE
        <input type="number" min={0} max={16} step={0.5} value={settings.preRollSec}
               onChange={(e) => setSettings({ preRollSec: Number(e.target.value) })}
               style={numberStyle} />s
      </label>

      <label style={labelStyle} title="트랜스포트가 움직이기 전에 무음 위로 재생되는 클릭 마디 수">
        CNT
        <input type="number" min={0} max={8} step={1} value={settings.countInBars}
               onChange={(e) => setSettings({ countInBars: Number(e.target.value) })}
               style={numberStyle} />bar
      </label>

      <Toggle on={settings.punchEnabled}
              onClick={() => (settings.punchEnabled
                ? setSettings({ punchEnabled: false })
                : usePunchFromSelection())}
              title="선택 구간을 펀치 인/아웃으로 사용">PUNCH</Toggle>

      <Toggle on={settings.loopTakes}
              onClick={() => setSettings({ loopTakes: !settings.loopTakes })}
              title="루프 녹음 시 각 패스를 별도 테이크로 쌓습니다">TAKES</Toggle>

      <span className="text-[10px] truncate" style={{ color: premium.text.faint, maxWidth: 300 }}
            title={describePlan(plan)}>
        {armed.length === 0
          ? '트랙의 ● 를 눌러 무장하세요 (여러 트랙 가능)'
          : `${describeArmed(session)} · ${describePlan(plan)}`}
      </span>

      {/* One row per armed AUDIO track: its own device, its own channel count,
          its own meter.  Six microphones on one interface are six different
          inputs, and a strip that can only say "the input device" cannot
          record a band. */}
      {split.audio.length > 0 && (
        <div className="w-full flex items-center gap-2 flex-wrap pt-1">
          {split.audio.map((track) => {
            const input = inputs[track.id] ?? DEFAULT_TRACK_INPUT;
            const peak = levels[track.id] ?? 0;
            // What the SESSION says this track records from, and whether the
            // machine can currently honour it.
            const saved = trackInputRef(track);
            const resolution = resolveTrackInput(saved, devices);
            const missing = resolution.kind === 'missing';
            return (
              <div key={track.id} className="flex items-center gap-1 rounded px-1.5 py-0.5"
                   title={resolution.reason ?? undefined}
                   style={{
                     border: `1px solid ${missing ? premium.accent.danger : premium.surface.hairline}`,
                     background: premium.surface.well,
                   }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: track.color }} />
                <span className="text-[9.5px] truncate" style={{ color: premium.text.muted, maxWidth: 74 }}
                      title={track.name}>{track.name}</span>
                <div className="h-3 w-12 rounded-sm overflow-hidden shrink-0"
                     style={{ background: '#000', border: `1px solid ${premium.surface.hairline}` }}
                     title={`입력 피크 ${peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : '—'}`}>
                  <div style={{
                    width: `${Math.min(100, peak * 100)}%`, height: '100%',
                    background: peak > 0.98 ? premium.accent.danger
                      : peak > 0.7 ? premium.accent.base : premium.accent.good,
                    transition: 'width 60ms linear',
                  }} />
                </div>
                <select
                  value={saved.deviceId ?? input.deviceId ?? ''}
                  onFocus={() => { if (devices.length === 0) void refreshDevices(); }}
                  onChange={(e) => setTrackInput(track.id, { deviceId: e.target.value || null })}
                  title={`${track.name} 의 입력 장치 — ${describeInput(saved)} (세션에 저장됩니다)`}
                  style={{
                    ...selectStyle, height: 20, maxWidth: 118,
                    borderColor: missing ? premium.accent.danger : premium.surface.hairline,
                    color: missing ? premium.accent.danger : premium.text.secondary,
                  }}
                >
                  <option value="">기본 입력</option>
                  {/* The saved device, listed even when it is not plugged in.
                      Dropping it from the list would silently reset the track
                      to the default the moment the interface is unplugged —
                      and the assignment would be gone for good. */}
                  {missing && saved.deviceLabel && saved.deviceId && (
                    <option value={saved.deviceId}>{saved.deviceLabel} (없음)</option>
                  )}
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                {/* Which socket of the interface, not just how many channels.
                    The list is the device's REAL width, learned when its
                    stream opened — before that it is the two every device
                    has, because offering input 5 on a box that has two would
                    be an option that fails when it is used. */}
                <select
                  value={`${saved.firstChannel}:${saved.channels}`}
                  onChange={(e) => {
                    const [first, count] = e.target.value.split(':');
                    setTrackInput(track.id, {
                      firstChannel: Number(first),
                      channels: Number(count) === 2 ? 2 : 1,
                    });
                  }}
                  title={`${track.name} 이(가) 읽을 입력 — ${describePatch({
                    firstChannel: saved.firstChannel, channels: saved.channels,
                  })}`}
                  style={{ ...selectStyle, height: 20, maxWidth: 86 }}
                >
                  {patchOptions(widthOf(saved.deviceId ?? input.deviceId)).map((p) => (
                    <option key={`${p.firstChannel}:${p.channels}`}
                            value={`${p.firstChannel}:${p.channels}`}>
                      {socketLabel(p.firstChannel, p.channels,
                        widthOf(saved.deviceId ?? input.deviceId))}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What to call one socket in the picker.
 *
 * On a two-input device the familiar words are what people scan for; past
 * that the socket number is the only thing that identifies which microphone,
 * so the number wins.
 */
function socketLabel(firstChannel: number, channels: 1 | 2, width: number): string {
  if (width > 2) return describePatch({ firstChannel, channels });
  if (channels === 2) return 'STEREO';
  return firstChannel === 0 ? 'MONO' : 'MONO (R)';
}

const selectStyle: React.CSSProperties = {
  height: 24, borderRadius: 3, fontSize: 10,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`, maxWidth: 150,
};

const numberStyle: React.CSSProperties = {
  width: 44, height: 20, marginLeft: 3, marginRight: 1, borderRadius: 3,
  background: premium.surface.well, color: premium.text.primary,
  border: `1px solid ${premium.surface.hairline}`,
  fontFamily: premium.type.mono, fontSize: 10, padding: '0 3px',
};

const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 2,
  fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint,
};

function Toggle(
  { on, onClick, children, title }: {
    on: boolean; onClick: () => void; children: React.ReactNode; title?: string;
  },
) {
  return (
    <button onClick={onClick} title={title} style={{
      height: 24, padding: '0 8px', borderRadius: 3,
      fontFamily: premium.type.sans, fontSize: 9.5, letterSpacing: '0.1em',
      color: on ? premium.text.onAccent : premium.text.muted,
      background: on ? premium.accent.base : premium.surface.well,
      border: `1px solid ${on ? premium.accent.deep : premium.surface.hairline}`,
    }}>{children}</button>
  );
}
