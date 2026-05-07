/**
 * Screen 6: Settings
 *
 * Sections:
 *   1. 출력 디렉토리 — choose where master WAV files are saved by default
 *   2. 오디오 기본값 — default target LUFS / TP / sample rate / bit depth
 *   3. 정보 — app version, open log folder
 *
 * (라이선스 섹션은 v3.6.0-rc.1+1 부터 제거 — 라이선스 게이트 비활성화.
 *  관련 컴포넌트 / 스토어는 트리에 dead-code 로 남아 있지만 활성 코드
 *  경로에서는 사용되지 않습니다.)
 */
import React, { useState, useEffect, useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';

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

// (License section removed — see file header.  Settings page now starts
//  at the output-directory section.)

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
  const options   = useAudioStore((s) => s.options);
  const setStyle  = useAudioStore((s) => s.setStyle);
  const notify    = useAppStore((s) => s.notify);

  // We persist via settings:set so choices survive relaunch
  const save = useCallback(async (key: string, value: unknown) => {
    await window.electronAPI.invoke('settings:set', key, value);
    notify('설정이 저장되었습니다.', 'success');
  }, [notify]);

  return (
    <Section title="오디오 기본값">
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
          {['balanced', 'warm', 'bright', 'punch'].map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </Row>

      <Row label="샘플레이트">
        <NumSelect
          value={options.sampleRate}
          options={[
            { v: 44100, label: '44.1 kHz' },
            { v: 48000, label: '48 kHz' },
            { v: 96000, label: '96 kHz' },
          ]}
          onChange={(v) => void save('defaultSampleRate', v)}
        />
      </Row>

      <Row label="비트 뎁스">
        <NumSelect
          value={options.bitDepth}
          options={[
            { v: 16, label: '16-bit' },
            { v: 24, label: '24-bit' },
          ]}
          onChange={(v) => void save('defaultBitDepth', v)}
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
          {/* Vite injects __APP_VERSION__ as a `define` constant from
              package.json at build time — see vite.config.ts.  The
              previous `import.meta.env.VITE_APP_VERSION` reference fell
              back to '1.0.0' on every build. */}
          {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0'}
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
          <OutputDirSection />
          <AudioDefaultsSection />
          <InfoSection />
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
