// ProvenancePanel — what this track is, and what it is built on.
//
// The AI section is READ-ONLY on purpose.  What the app did is not a claim
// the user gets to edit: a disclosure you can quietly empty is a checkbox
// that always says whatever its owner wants it to say, and the whole point of
// writing this into the file is that somebody else can rely on it.  It is
// also drawn in the COOL accent, which this theme reserves for values the
// app measured rather than values a person set.
//
// Everything else is the part only a person knows — the original work, and
// the right under which it is being used.

import React, { useCallback } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import {
  AI_KIND_LABELS, BASIS_LABELS, describeProvenance, provenanceProblem,
  type LicenceBasis, type Provenance, type SourceWork,
} from '../../../daw/model/provenance.js';
import { provenanceOf, setProvenance } from '../../../daw/model/provenance-session.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import { premium } from '../../../theme/premium.js';

const BASES: LicenceBasis[] = ['own-work', 'licensed', 'permission', 'public-domain', 'unknown'];

export default function ProvenancePanel() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const closePanel = useWorkspaceStore((v) => v.togglePanel);
  const p = provenanceOf(session);

  const edit = useCallback((patch: Partial<Provenance>) => {
    apply((s) => setProvenance(s, { ...provenanceOf(s), ...patch }));
  }, [apply]);

  const editSource = (i: number, patch: Partial<SourceWork>): void => {
    edit({ derivedFrom: p.derivedFrom.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  };

  const problem = provenanceProblem(p);

  return (
    <div className="fixed right-2 top-12 z-40 w-[340px] max-h-[80vh] overflow-y-auto rounded border shadow-2xl"
         style={{ background: premium.surface.panel, borderColor: premium.surface.hairline,
                  fontFamily: premium.type.sans }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b sticky top-0"
           style={{ borderColor: premium.surface.hairline, background: premium.surface.panel }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>메타데이터</span>
        <span className="text-[9px]" style={{ color: premium.text.faint }}>파일에 새겨집니다</span>
        <div className="flex-1" />
        <button onClick={() => closePanel('provenance')}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기
        </button>
      </div>

      <div className="p-2 space-y-3">
        <Section label="이 곡">
          <Field label="제목" value={p.title} onChange={(v) => edit({ title: v })} />
          <Field label="아티스트" value={p.artist} onChange={(v) => edit({ artist: v })} />
          <Field label="저작권" value={p.copyright} placeholder="© 2026 …"
                 onChange={(v) => edit({ copyright: v })} />
          <Field label="발매 연도" value={p.year === null ? '' : String(p.year)} placeholder="2026"
                 onChange={(v) => {
                   const n = Number(v);
                   edit({ year: v.trim() === '' || !Number.isFinite(n) ? null : Math.trunc(n) });
                 }} />
        </Section>

        <Section label="사람이 한 것">
          {p.humanWork.map((w, i) => (
            <div key={i} className="flex gap-1 items-center">
              <input value={w} onChange={(e) => edit({
                humanWork: p.humanWork.map((x, n) => (n === i ? e.target.value : x)),
              })} style={inputStyle} className="flex-1" />
              <button style={miniStyle} title="제거"
                      onClick={() => edit({ humanWork: p.humanWork.filter((_, n) => n !== i) })}>×</button>
            </div>
          ))}
          <button style={miniStyle} onClick={() => edit({ humanWork: [...p.humanWork, ''] })}>
            + 작업 추가
          </button>
        </Section>

        <Section label="AI 가 한 것">
          {p.aiWork.length === 0 ? (
            <p className="text-[9.5px]" style={{ color: premium.text.faint }}>
              아직 없습니다. AI 기능을 쓰면 여기에 자동으로 기록되고, 지울 수 없습니다.
            </p>
          ) : p.aiWork.map((s, i) => (
            <div key={i} className="text-[10px] flex gap-1.5">
              <span style={{ color: premium.accent.cool }}>{AI_KIND_LABELS[s.kind]}</span>
              <span style={{ color: premium.text.faint }}>{s.detail}</span>
            </div>
          ))}
        </Section>

        <Section label="2차 창작 — 원곡">
          {p.derivedFrom.length === 0 && (
            <p className="text-[9.5px]" style={{ color: premium.text.faint }}>
              비어 있으면 원저작물로 기록됩니다.
            </p>
          )}
          {p.derivedFrom.map((src, i) => (
            <div key={i} className="rounded border p-1.5 space-y-1"
                 style={{ borderColor: premium.surface.hairline }}>
              <div className="flex gap-1">
                <input value={src.title} placeholder="원곡 제목" style={inputStyle} className="flex-1"
                       onChange={(e) => editSource(i, { title: e.target.value })} />
                <button style={miniStyle} title="이 원곡 제거"
                        onClick={() => edit({ derivedFrom: p.derivedFrom.filter((_, n) => n !== i) })}>×</button>
              </div>
              <input value={src.artist} placeholder="원곡 아티스트" style={inputStyle} className="w-full"
                     onChange={(e) => editSource(i, { artist: e.target.value })} />
              <input value={src.isrc ?? ''} placeholder="ISRC (선택)" style={inputStyle} className="w-full"
                     onChange={(e) => editSource(i, { isrc: e.target.value })} />
              <select value={src.basis} style={inputStyle} className="w-full"
                      onChange={(e) => editSource(i, { basis: e.target.value as LicenceBasis })}>
                {BASES.map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
              </select>
              <input value={src.note ?? ''} placeholder="근거 — 계약번호·URL 등" style={inputStyle}
                     className="w-full" onChange={(e) => editSource(i, { note: e.target.value })} />
            </div>
          ))}
          <button style={miniStyle} onClick={() => edit({
            derivedFrom: [...p.derivedFrom, { title: '', artist: '', basis: 'unknown' as const }],
          })}>+ 원곡 추가</button>
        </Section>

        {problem && (
          <p className="text-[9.5px] leading-snug" style={{ color: premium.accent.danger }}>
            {problem}
          </p>
        )}

        <div className="pt-1.5 border-t" style={{ borderColor: premium.surface.hairline }}>
          <p style={labelStyle}>파일에 들어갈 문장</p>
          <p className="text-[9px] leading-snug mt-1 font-mono break-words"
             style={{ color: premium.text.secondary }}>
            {describeProvenance(p)}
          </p>
        </div>

        <p className="text-[8.5px] leading-snug pt-1.5 border-t"
           style={{ color: premium.text.faint, borderColor: premium.surface.hairline }}>
          이 기록은 바운스와 마스터링 전송 파일에 새겨집니다. Content ID 는 소리의
          지문으로 대조하므로 어떤 태그로도 매칭을 피할 수 없습니다 — 이건 매칭이
          걸렸을 때 <b>답할 수 있게</b> 하는 자료입니다.
        </p>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p style={labelStyle}>{label}</p>
      {children}
    </div>
  );
}

function Field(
  { label, value, onChange, placeholder }:
  { label: string; value: string; onChange: (v: string) => void; placeholder?: string },
) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[9.5px] shrink-0" style={{ width: 54, color: premium.text.faint }}>{label}</span>
      <input value={value} placeholder={placeholder ?? ''} style={inputStyle} className="flex-1"
             onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 9, letterSpacing: '0.1em', color: premium.text.faint,
};

const inputStyle: React.CSSProperties = {
  height: 22, padding: '0 6px', borderRadius: 3, fontSize: 10,
  background: '#18181b', border: '1px solid #3f3f46', color: '#e4e4e7', outline: 'none',
};

const miniStyle: React.CSSProperties = {
  height: 18, padding: '0 6px', borderRadius: 3, fontSize: 9,
  background: '#18181b', border: '1px solid #3f3f46', color: '#a1a1aa',
};
