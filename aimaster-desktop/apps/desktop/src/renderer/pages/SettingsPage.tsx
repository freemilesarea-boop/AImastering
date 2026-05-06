/**
 * Screen 6: Settings
 *
 * Sections:
 *   1. 출력 디렉토리 — choose where master WAV files are saved by default
 *   2. 라이선스 — show tier/key, activate / deactivate
 *   3. 오디오 기본값 — default target LUFS / TP / sample rate / bit depth
 *   4. 정보 — app version, open log folder
 */
import React, { useState, useEffect, useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { useLicenseStore } from '../stores/licenseStore.js';
import { MASTERING_MODES } from '@aimaster/shared-types';

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-zinc-800">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">{title}</p>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-zinc-400 shrink-0">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ── Number select ──────────────────────────────────────────────────────────────

function NumSelect({
  value, options, onChange,
}: {
  value: number;
  options: { v: number; label: string }[];
  onChange: (v: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="no-drag bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1
                 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500"
    >
      {options.map(({ v, label }) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}

// ── License section ────────────────────────────────────────────────────────────

function LicenseSection() {
  const licenseInfo  = useLicenseStore((s) => s.licenseInfo);
  const activate     = useLicenseStore((s) => s.activate);
  const load         = useLicenseStore((s) => s.load);
  const error        = useLicenseStore((s) => s.error);
  const isLoading    = useLicenseStore((s) => s.isLoading);
  const notify       = useAppStore((s) => s.notify);

  const [key, setKey] = useState('');
  const [mode, setMode] = useState<'view' | 'activate'>('view');

  const isPro = licenseInfo?.tier === 'pro';

  const handleActivate = useCallback(async () => {
    if (!key.trim()) return;
    try {
      await activate(key.trim());
      notify('라이선스가 활성화되었습니다.', 'success');
      setMode('view');
      setKey('');
    } catch {
      // error is set in licenseStore
    }
  }, [key, activate, notify]);

  const handleDeactivate = useCallback(async () => {
    await window.electronAPI.invoke('license:deactivate');
    await load();
    notify('라이선스가 해제되었습니다.', 'info');
  }, [load, notify]);

  return (
    <Section title="라이선스">
      {/* Tier badge */}
      <Row label="플랜">
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
          isPro
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : 'bg-zinc-800 border-zinc-700 text-zinc-500'
        }`}>
          {isPro ? 'Pro' : '무료'}
        </span>
      </Row>

      {/* Trial count for free tier */}
      {!isPro && licenseInfo && (
        <Row label="남은 체험 횟수">
          <span className="font-mono text-sm text-zinc-300">
            {licenseInfo.trialMax - licenseInfo.trialUsed} / {licenseInfo.trialMax}
          </span>
        </Row>
      )}

      {/* License key for pro */}
      {isPro && licenseInfo?.key && (
        <Row label="키">
          <span className="font-mono text-xs text-zinc-500">{licenseInfo.key}</span>
        </Row>
      )}

      {/* Actions */}
      {mode === 'view' ? (
        <div className="flex gap-2 pt-1">
          {!isPro && (
            <button
              onClick={() => setMode('activate')}
              className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                         bg-zinc-100 text-zinc-900 hover:bg-white transition-colors"
            >
              라이선스 키 입력
            </button>
          )}
          {isPro && (
            <button
              onClick={handleDeactivate}
              className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                         border border-zinc-700 text-zinc-500 hover:text-zinc-300
                         hover:border-zinc-600 transition-colors"
            >
              해제
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2 pt-1">
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="AIMASTER-XXXX-XXXX-XXXX"
            className="no-drag w-full bg-zinc-800 border border-zinc-700 rounded-lg
                       px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-700
                       focus:outline-none focus:border-zinc-500"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleActivate(); }}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void handleActivate()}
              disabled={isLoading || !key.trim()}
              className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                         bg-zinc-100 text-zinc-900 hover:bg-white
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? '확인 중…' : '활성화'}
            </button>
            <button
              onClick={() => { setMode('view'); setKey(''); }}
              className="no-drag px-3 py-1.5 rounded-lg text-xs font-medium
                         border border-zinc-700 text-zinc-500 hover:text-zinc-300
                         hover:border-zinc-600 transition-colors"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Output directory section ───────────────────────────────────────────────────

function OutputDirSection() {
  const notify   = useAppStore((s) => s.notify);
  const [dir, setDir] = useState<string>('');

  useEffect(() => {
    void (async () => {
      const saved = await window.electronAPI.invoke('settings:get', 'outputDir') as string | null;
      setDir(saved ?? '');
    })();
  }, []);

  const handleChoose = useCallback(async () => {
    const chosen = await window.electronAPI.invoke('settings:choose-output-dir') as string | null;
    if (chosen) {
      await window.electronAPI.invoke('settings:set', 'outputDir', chosen);
      setDir(chosen);
      notify('출력 디렉토리가 저장되었습니다.', 'success');
    }
  }, [notify]);

  return (
    <Section title="출력 디렉토리">
      <Row label="저장 경로">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-zinc-500 truncate max-w-[180px]">
            {dir || '기본값 (다운로드 폴더)'}
          </span>
          <button
            onClick={() => void handleChoose()}
            className="no-drag px-2.5 py-1 rounded-lg text-xs border border-zinc-700
                       text-zinc-400 hover:text-zinc-200 hover:border-zinc-600
                       transition-colors shrink-0"
          >
            변경
          </button>
        </div>
      </Row>
    </Section>
  );
}

// ── Audio defaults section ─────────────────────────────────────────────────────

function AudioDefaultsSection() {
  const options       = useAudioStore((s) => s.options);
  const setStyle      = useAudioStore((s) => s.setStyle);
  const updateOptions = useAudioStore((s) => s.updateOptions);
  const notify        = useAppStore((s) => s.notify);

  // We persist via settings:set so choices survive relaunch
  const save = useCallback(async (key: string, value: unknown) => {
    await window.electronAPI.invoke('settings:set', key, value);
    notify('설정이 저장되었습니다.', 'success');
  }, [notify]);

  return (
    <Section title="오디오 기본값">
      {/* H-14 fix (audit 2026-05): use the shared MASTERING_MODES list so
          users can pick every v3 mode (natural / loud / kpop_loud / …) here,
          not just the four legacy hardcoded styles. */}
      <Row label="스타일 프리셋">
        <select
          value={options.style}
          onChange={(e) => {
            const v = e.target.value as typeof options.style;
            setStyle(v);
            void save('defaultStyle', v);
          }}
          className="no-drag bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1
                     text-xs text-zinc-300 focus:outline-none focus:border-zinc-500"
        >
          {MASTERING_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.legacy ? ' (legacy)' : ''}
            </option>
          ))}
        </select>
      </Row>

      {/* H-13 fix (audit 2026-05): also push the value into the audio store
          so the Home/Mastering page reflects the new value immediately
          (was persisting to electron-store only → UI snap-back on next render). */}
      <Row label="샘플레이트">
        <NumSelect
          value={options.sampleRate}
          options={[
            { v: 44100, label: '44.1 kHz' },
            { v: 48000, label: '48 kHz' },
            { v: 96000, label: '96 kHz' },
          ]}
          onChange={(v) => {
            updateOptions({ sampleRate: v });
            void save('defaultSampleRate', v);
          }}
        />
      </Row>

      <Row label="비트 뎁스">
        <NumSelect
          value={options.bitDepth}
          options={[
            { v: 16, label: '16-bit' },
            { v: 24, label: '24-bit' },
          ]}
          onChange={(v) => {
            updateOptions({ bitDepth: v as 16 | 24 });
            void save('defaultBitDepth', v);
          }}
        />
      </Row>
    </Section>
  );
}

// ── Info section ───────────────────────────────────────────────────────────────

function InfoSection() {
  const handleOpenLogs = useCallback(async () => {
    await window.electronAPI.invoke('file:open-in-finder', 'logs');
  }, []);

  return (
    <Section title="정보">
      <Row label="버전">
        <span className="font-mono text-xs text-zinc-500">
          {/* Vite injects VITE_APP_VERSION from package.json at build time */}
          {import.meta.env.VITE_APP_VERSION ?? '1.0.0'}
        </span>
      </Row>
      <Row label="로그">
        <button
          onClick={() => void handleOpenLogs()}
          className="no-drag px-2.5 py-1 rounded-lg text-xs border border-zinc-700
                     text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
        >
          폴더 열기
        </button>
      </Row>
    </Section>
  );
}

// ── SettingsPage ───────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const setPage = useAppStore((s) => s.setPage);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="설정"
        actions={
          <button
            onClick={() => setPage('home')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            닫기
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">
          <LicenseSection />
          <OutputDirSection />
          <AudioDefaultsSection />
          <InfoSection />
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
