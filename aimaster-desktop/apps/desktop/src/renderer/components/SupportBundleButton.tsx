/**
 * SupportBundleButton — TopBar action that exports the support bundle
 * to a JSON file via the `support:bundle-export` IPC.
 *
 * Tester onboarding (see TESTER_GUIDE_v3.6_RC.md) tells testers to use
 * this button.  We keep it small + tooltip-only so it doesn't take real
 * estate from the license badge.
 *
 * Failures are surfaced through `appStore.notify`, NOT through a hard
 * error dialog — even the diagnostic export shouldn't break the user's
 * flow.
 */
import React, { useCallback, useState } from 'react';
import { useAppStore } from '../stores/appStore.js';

interface ExportResult {
  savedTo:   string;
  sizeBytes: number;
}

export default function SupportBundleButton() {
  const notify     = useAppStore((s) => s.notify);
  const [busy, setBusy] = useState(false);

  const handleClick = useCallback(async () => {
    if (busy) return;
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined);
    if (!api?.invoke) {
      notify('지원 진단을 내보낼 수 없습니다 (Electron API 미연결)', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.invoke('support:bundle-export') as ExportResult | null;
      if (!r) {
        // User canceled the save dialog.  Silent.
        return;
      }
      const kb = Math.max(1, Math.round(r.sizeBytes / 1024));
      notify(`지원 진단 저장됨 (~${kb} KB)`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify(`지원 진단 저장 실패: ${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, notify]);

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title="지원 진단을 JSON 파일로 내보냅니다 (개인정보 / 절대 경로 미포함)"
      className={`no-drag flex items-center gap-1.5 px-2 py-1 rounded-md
                  text-[10px] uppercase tracking-wider font-medium
                  border transition-colors
                  ${busy
                    ? 'bg-zinc-900 text-zinc-600 border-zinc-800 cursor-wait'
                    : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/60 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
    >
      <span aria-hidden="true">ⓘ</span>
      <span>지원 진단</span>
    </button>
  );
}
