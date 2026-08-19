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
import { armedTracks, canRecord, describePlan, planRecording } from '../../../daw/model/recording.js';
import { premium } from '../../../theme/premium.js';

export default function RecordStrip() {
  const session = useDawStore((s) => s.session);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const selection = useDawStore((s) => s.selection);
  const loopEnabled = useDawStore((s) => s.loopEnabled);
  const loopStartSec = useDawStore((s) => s.loopStartSec);
  const loopEndSec = useDawStore((s) => s.loopEndSec);
  const notify = useAppStore((s) => s.notify);

  const { status, settings, devices, level, elapsedSec, error } = useRecordingStore();
  const setSettings = useRecordingStore((s) => s.setSettings);
  const refreshDevices = useRecordingStore((s) => s.refreshDevices);
  const start = useRecordingStore((s) => s.start);
  const stop = useRecordingStore((s) => s.stop);

  const armed = armedTracks(session);
  const rolling = status === 'recording' || status === 'countIn';
  const readiness = canRecord(session, settings);

  useEffect(() => {
    if (error) notify(error, 'warning');
  }, [error, notify]);

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

      {/* Input meter — always live once armed, because that is when it matters. */}
      <div className="h-4 w-24 rounded-sm overflow-hidden shrink-0"
           style={{ background: premium.surface.well, border: `1px solid ${premium.surface.hairline}` }}
           title={`입력 피크 ${level > 0 ? `${(20 * Math.log10(level)).toFixed(1)} dBFS` : '—'}`}>
        <div style={{
          width: `${Math.min(100, level * 100)}%`, height: '100%',
          background: level > 0.98 ? premium.accent.danger
            : level > 0.7 ? premium.accent.base : premium.accent.good,
          transition: 'width 60ms linear',
        }} />
      </div>

      <select
        value={settings.inputDeviceId ?? ''}
        onFocus={() => { if (devices.length === 0) void refreshDevices(); }}
        onChange={(e) => setSettings({ inputDeviceId: e.target.value || null })}
        title="입력 장치"
        style={selectStyle}
      >
        <option value="">기본 입력</option>
        {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>

      <select value={settings.channels}
              onChange={(e) => setSettings({ channels: Number(e.target.value) === 2 ? 2 : 1 })}
              title="캡처 채널" style={selectStyle}>
        <option value={1}>MONO</option>
        <option value={2}>STEREO</option>
      </select>

      <Toggle on={settings.monitoring === 'on'}
              onClick={() => setSettings({ monitoring: settings.monitoring === 'on' ? 'off' : 'on' })}
              title="입력 모니터링 — 트랙의 인서트를 통과해서 들립니다">MON</Toggle>

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

      <span className="text-[10px] truncate" style={{ color: premium.text.faint, maxWidth: 340 }}
            title={describePlan(plan)}>
        {armed.length === 0 ? '트랙의 ● 를 눌러 무장하세요' : describePlan(plan)}
      </span>
    </div>
  );
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
