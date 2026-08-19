// DawInspector — the left inspector strip (Alt+I).
//
// Shows, at a glance, everything the keyboard layer can change: source file,
// mastering targets, tool / snap / zoom, loop + selection, and undo depth.
// Deliberately read-only — it is a status surface for fast keyboard testing,
// not a second editor.

import React from 'react';
import { useAudioStore } from '../../stores/audioStore.js';
import { useAppStore } from '../../stores/appStore.js';
import { useWorkspaceStore, TOOL_LABELS } from '../../stores/workspaceStore.js';
import { fmtTime } from '../../shortcuts/commands.js';

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wider shrink-0">{label}</span>
      <span className={`text-[11px] font-mono truncate ${dim ? 'text-zinc-600' : 'text-zinc-300'}`}
            title={value}>{value}</span>
    </div>
  );
}

export default function DawInspector() {
  const page         = useAppStore((s) => s.currentPage);
  const selectedFile = useAudioStore((s) => s.selectedFile);
  const options      = useAudioStore((s) => s.options);
  const result       = useAudioStore((s) => s.masteringResult);

  const tool        = useWorkspaceStore((s) => s.tool);
  const snapEnabled = useWorkspaceStore((s) => s.snapEnabled);
  const zoomH       = useWorkspaceStore((s) => s.zoomH);
  const zoomV       = useWorkspaceStore((s) => s.zoomV);
  const loop        = useWorkspaceStore((s) => s.loop);
  const loopEnabled = useWorkspaceStore((s) => s.loopEnabled);
  const selection   = useWorkspaceStore((s) => s.selection);
  const history     = useWorkspaceStore((s) => s.history);
  const durationSec = useWorkspaceStore((s) => s.durationSec);

  const fileName = selectedFile
    ? (selectedFile.split('/').pop()?.split('\\').pop() ?? selectedFile)
    : '—';

  return (
    <aside className="w-56 shrink-0 h-full overflow-y-auto border-r border-zinc-800
                      bg-[#0d0d14]/95 px-3 py-3 space-y-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500 font-semibold">인스펙터</p>

      <div className="space-y-1.5">
        <Row label="Page"   value={page} />
        <Row label="소스"   value={fileName} dim={!selectedFile} />
        <Row label="길이"   value={durationSec > 0 ? fmtTime(durationSec) : '—'} dim={durationSec <= 0} />
      </div>

      <div className="border-t border-zinc-800 pt-2 space-y-1.5">
        <Row label="Style"  value={options.style} />
        <Row label="Target" value={`${options.targetLufs} LUFS`} />
        <Row label="TP"     value={`${options.targetTp} dBTP`} />
        <Row label="Limiter" value={options.limiterStrength} />
        <Row label="Bypass" value={options.rt?.masterBypass ? 'ON (원본)' : 'OFF'} dim={!options.rt?.masterBypass} />
      </div>

      <div className="border-t border-zinc-800 pt-2 space-y-1.5">
        <Row label="툴"   value={`${TOOL_LABELS[tool]}`} />
        <Row label="스냅" value={snapEnabled ? 'ON' : 'OFF'} dim={!snapEnabled} />
        <Row label="줌"   value={`H ×${zoomH} · V ×${zoomV.toFixed(1)}`} />
        <Row label="루프" value={loop.endSec > loop.startSec
          ? `${loopEnabled ? 'ON' : 'OFF'} ${fmtTime(loop.startSec)}~${fmtTime(loop.endSec)}`
          : '—'} dim={loop.endSec <= loop.startSec} />
        <Row label="선택" value={selection ? `${fmtTime(selection.startSec)}~${fmtTime(selection.endSec)}` : '—'}
             dim={!selection} />
      </div>

      <div className="border-t border-zinc-800 pt-2 space-y-1.5">
        <Row label="Undo" value={`${history?.past.length ?? 0} 단계`} dim={!history?.past.length} />
        <Row label="Redo" value={`${history?.future.length ?? 0} 단계`} dim={!history?.future.length} />
        <Row label="결과" value={result?.outputPath ? '있음' : '없음'} dim={!result?.outputPath} />
      </div>

      <p className="text-[9px] text-zinc-700 leading-relaxed border-t border-zinc-800 pt-2">
        ? 키로 전체 단축키 목록을 엽니다.
      </p>
    </aside>
  );
}
