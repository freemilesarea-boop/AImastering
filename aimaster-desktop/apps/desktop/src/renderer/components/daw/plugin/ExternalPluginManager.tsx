// What third-party plugins are installed, grouped by who made them.
//
// The list is honest about the difference between "found" and "usable".  A
// picker full of plugins that silently do nothing is worse than a picker
// without them: you would spend an afternoon wondering why your compressor
// has no effect.  So every entry says what the app can currently do with it,
// and the panel says exactly what is missing and why.

import React, { useEffect, useState } from 'react';
import {
  byVendor, formatCounts, useExternalPluginStore, type PluginFormat,
} from '../../../stores/externalPluginStore.js';
import { HOST_REQUIREMENTS, hostability } from '../../../daw/engine/external-host.js';
import { premium } from '../../../theme/premium.js';

const FORMAT_LABEL: Record<PluginFormat, string> = {
  vst3: 'VST3', au: 'Audio Unit', vst2: 'VST2', clap: 'CLAP',
};

export default function ExternalPluginManager({ onClose }: { onClose: () => void }) {
  const plugins = useExternalPluginStore((s) => s.plugins);
  const searched = useExternalPluginStore((s) => s.searched);
  const skipped = useExternalPluginStore((s) => s.skipped);
  const status = useExternalPluginStore((s) => s.status);
  const error = useExternalPluginStore((s) => s.error);
  const scan = useExternalPluginStore((s) => s.scan);

  const [showPaths, setShowPaths] = useState(false);
  const [filter, setFilter] = useState('');

  // Scan on first open, not on app start: it walks folders and reads a file
  // per bundle, and nobody has asked for it until they open this.
  useEffect(() => { if (status === 'idle') void scan(); }, [status, scan]);

  const visible = plugins.filter((p) =>
    (p.name + p.vendor).toLowerCase().includes(filter.trim().toLowerCase()));
  const counts = formatCounts(plugins);
  const groups = byVendor(visible);
  const unmet = HOST_REQUIREMENTS.filter((r) => !r.met);

  return (
    <div
      className="fixed rounded-xl overflow-hidden flex flex-col"
      style={{
        left: '50%', top: 80, transform: 'translateX(-50%)',
        zIndex: 210, width: 560, maxHeight: '76vh',
        background: premium.surface.frame,
        border: `1px solid ${premium.accent.deep}`,
        boxShadow: premium.shadow.panel,
      }}
    >
      <div
        className="flex items-center gap-3 px-4 h-10 shrink-0"
        style={{ background: premium.gradient.frame, borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span
          className="text-[13px] flex-1"
          style={{ fontFamily: premium.type.display, color: premium.accent.light }}
        >서드파티 플러그인</span>
        <button
          onClick={() => void scan(true)}
          disabled={status === 'scanning'}
          className="h-6 px-2 rounded text-[10px] border"
          style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
        >{status === 'scanning' ? '스캔 중…' : '다시 스캔'}</button>
        <button
          onClick={onClose}
          className="h-6 w-6 text-[13px] leading-none"
          style={{ color: premium.text.muted }}
        >×</button>
      </div>

      {/* What the app can currently do with these — said once, at the top. */}
      {unmet.length > 0 && (
        <div
          className="px-4 py-3 shrink-0"
          style={{ background: 'rgba(251,191,36,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[11px] mb-1.5" style={{ color: 'rgb(251,191,36)' }}>
            지금은 목록만 읽습니다 — 아직 채널에 걸 수 없습니다
          </p>
          <ul className="flex flex-col gap-1">
            {unmet.map((requirement) => (
              <li key={requirement.id} className="text-[10px] leading-relaxed">
                <span style={{ color: premium.text.secondary }}>· {requirement.what}</span>
                <br />
                <span style={{ color: premium.text.faint, paddingLeft: 10 }}>{requirement.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 py-2 shrink-0"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="이름 · 제조사 검색"
          className="flex-1 h-7 px-2 text-[11px] bg-transparent outline-none rounded"
          style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.1)' }}
        />
        <span className="text-[10px] font-mono" style={{ color: premium.text.faint }}>
          {(Object.keys(FORMAT_LABEL) as PluginFormat[])
            .filter((f) => counts[f] > 0)
            .map((f) => `${FORMAT_LABEL[f]} ${counts[f]}`)
            .join(' · ') || '0'}
        </span>
      </div>

      <div className="overflow-y-auto flex-1">
        {status === 'scanning' && (
          <p className="p-4 text-[11px]" style={{ color: premium.text.muted }}>
            플러그인 폴더를 읽는 중…
          </p>
        )}

        {status === 'unavailable' && (
          <p className="p-4 text-[11px]" style={{ color: premium.accent.danger }}>
            스캔할 수 없습니다 — {error}
          </p>
        )}

        {status === 'ready' && plugins.length === 0 && (
          <div className="p-4 flex flex-col gap-2">
            <p className="text-[11px]" style={{ color: premium.text.secondary }}>
              설치된 플러그인을 찾지 못했습니다.
            </p>
            <p className="text-[10px]" style={{ color: premium.text.faint }}>
              아래 폴더를 확인했습니다. 다른 곳에 설치하셨다면 그 경로가 목록에
              없을 수 있습니다.
            </p>
          </div>
        )}

        {groups.map((group) => (
          <div key={group.vendor}>
            <div
              className="px-4 h-7 flex items-center sticky top-0"
              style={{ background: premium.surface.frame, borderBottom: '1px solid rgba(255,255,255,0.04)' }}
            >
              <span className="text-[10px] tracking-wide flex-1" style={{ color: premium.accent.base }}>
                {group.vendor}
              </span>
              <span className="text-[9px]" style={{ color: premium.text.faint }}>
                {group.plugins.length}
              </span>
            </div>
            {group.plugins.map((plugin) => {
              const host = hostability(plugin.format);
              return (
                <div
                  key={plugin.id}
                  className="px-4 h-8 flex items-center gap-2"
                  title={plugin.path}
                >
                  <span className="text-[11px] flex-1 truncate" style={{ color: premium.text.primary }}>
                    {plugin.name}
                  </span>
                  {plugin.kind === 'instrument' && (
                    <span className="text-[8px] px-1 rounded"
                          style={{ border: '1px solid rgba(255,255,255,0.12)', color: premium.text.faint }}>
                      INST
                    </span>
                  )}
                  <span className="text-[9px] w-16 text-right" style={{ color: premium.text.faint }}>
                    {FORMAT_LABEL[plugin.format]}
                  </span>
                  <span
                    className="text-[9px] w-24 text-right truncate"
                    style={{ color: host.hostable ? premium.accent.good : premium.text.faint }}
                    title={host.reason}
                  >{host.hostable ? host.reason : '호스팅 불가'}</span>
                </div>
              );
            })}
          </div>
        ))}

        {status === 'ready' && (
          <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              onClick={() => setShowPaths(!showPaths)}
              className="text-[10px]"
              style={{ color: premium.text.muted }}
            >{showPaths ? '▾' : '▸'} 확인한 폴더 {searched.length}곳
              {skipped.length > 0 && ` · 읽지 못한 번들 ${skipped.length}개`}</button>
            {showPaths && (
              <ul className="mt-2 flex flex-col gap-0.5">
                {searched.map((dir) => (
                  <li key={dir} className="text-[9px] font-mono truncate"
                      style={{ color: premium.text.faint }}>{dir}</li>
                ))}
                {skipped.map((entry) => (
                  <li key={entry.path} className="text-[9px] font-mono truncate"
                      style={{ color: 'rgb(251,191,36)' }}>{entry.path} — {entry.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
