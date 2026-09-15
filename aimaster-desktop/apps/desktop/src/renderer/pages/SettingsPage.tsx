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
import { SAMPLE_RATES, BIT_DEPTHS } from '../lib/audio-defaults.js';

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

/**
 * The rates the settings page offers, spelled for people.
 *
 * The LIST lives in lib/audio-defaults.ts next to the validator that reads it
 * back, so a rate cannot be offered here and rejected there — which is what
 * happened the other way round: the main-process whitelist allowed 88.2 kHz
 * that this page never showed.
 */
const RATE_LABELS: Record<number, string> = {
  44100: '44.1 kHz', 48000: '48 kHz', 96000: '96 kHz',
};

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
      {/* Says what it does now that it does something.  The folder is where
          내보내기 / 바운스 / 일괄 저장 dialogs open; it is a starting point,
          not a lock — every one of those still lets you go elsewhere. */}
      <p className="text-[11px] text-zinc-600 leading-snug">
        내보내기 · 바운스 · 일괄 저장 창이 이 폴더에서 열립니다. 창에서 다른 곳을 고를 수 있습니다.
      </p>
      <Row label="저장 경로">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-zinc-500 truncate max-w-[180px]">
            {dir || '기본값 (마지막에 저장한 위치)'}
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

  /**
   * Change the setting for this session AND for the next one.
   *
   * Both halves, always.  Writing only to disk left every one of these
   * `<select>`s reading `options.*`, so the value the user picked was
   * overwritten by the old one on the next render — the dropdown snapped back
   * while a green "저장되었습니다" said it had not.  Writing only to the store
   * would be the same bug a relaunch later.
   *
   * The toast is raised only if the write actually lands: a store that refuses
   * to write has to say so rather than congratulate the user.
   */
  const save = useCallback(async (patch: Partial<typeof options>, key: string, value: unknown) => {
    updateOptions(patch);
    try {
      await window.electronAPI.invoke('settings:set', key, value);
      notify('설정이 저장되었습니다.', 'success');
    } catch (err) {
      notify(`설정을 저장하지 못했습니다 — ${(err as Error).message}`, 'error');
    }
  }, [notify, updateOptions]);

  return (
    <Section title="오디오 기본값">
      <Row label="스타일 프리셋">
        <select
          value={options.style}
          onChange={(e) => {
            const v = e.target.value as typeof options.style;
            setStyle(v);
            void save({}, 'defaultStyle', v);
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
          options={SAMPLE_RATES.map((v) => ({ v, label: RATE_LABELS[v] ?? `${v} Hz` }))}
          onChange={(v) => void save({ sampleRate: v }, 'defaultSampleRate', v)}
        />
      </Row>

      <Row label="비트 뎁스">
        <NumSelect
          value={options.bitDepth}
          options={BIT_DEPTHS.map((v) => ({ v, label: `${v}-bit` }))}
          onChange={(v) => {
            if (v !== 16 && v !== 24) return;
            void save({ bitDepth: v }, 'defaultBitDepth', v);
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
          <OutputDirSection />
          <AudioDefaultsSection />
          <InfoSection />
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
