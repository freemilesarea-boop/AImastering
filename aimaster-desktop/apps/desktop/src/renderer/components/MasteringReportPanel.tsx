/**
 * MasteringReportPanel — bullet-list summary of what the mastering chain
 * actually did.  Pass either:
 *
 *   <MasteringReportPanel snapshot={pipelineSnapshot} />
 *   <MasteringReportPanel report={preComputedReport}  />
 *
 * Categories drive the colour bar on the left of each bullet:
 *   gain      — zinc
 *   eq        — sky
 *   vocal     — violet
 *   dynamics  — amber
 *   transient — emerald
 *   loudness  — emerald (brighter)
 *   truepeak  — orange
 *   info      — zinc-dim
 *   warning   — red
 *
 * Minor bullets are collapsed under a "+N more" toggle so the headline
 * actions stand out.
 */
import React, { useState, useMemo } from 'react';
import {
  generateMasteringReport,
  MasteringPipelineSnapshot,
  MasteringReport,
  ReportBullet,
  ReportCategory,
} from '../audio/report.js';

interface Props {
  snapshot?: MasteringPipelineSnapshot;
  report?:   MasteringReport;
  className?: string;
  /** Show "+N more" expansion for minor bullets.  Default true. */
  collapseMinor?: boolean;
}

const CATEGORY_STYLES: Record<ReportCategory, { bar: string; tag: string; tagBg: string }> = {
  gain:      { bar: 'bg-zinc-500',    tag: 'GAIN',     tagBg: 'bg-zinc-700/40 text-zinc-300' },
  eq:        { bar: 'bg-sky-500',     tag: 'EQ',       tagBg: 'bg-sky-900/40 text-sky-300' },
  vocal:     { bar: 'bg-violet-500',  tag: 'VOCAL',    tagBg: 'bg-violet-900/40 text-violet-300' },
  dynamics:  { bar: 'bg-amber-500',   tag: 'DYN',      tagBg: 'bg-amber-900/40 text-amber-300' },
  transient: { bar: 'bg-emerald-500', tag: 'TRANS',    tagBg: 'bg-emerald-900/40 text-emerald-300' },
  loudness:  { bar: 'bg-emerald-400', tag: 'LOUD',     tagBg: 'bg-emerald-900/30 text-emerald-200' },
  truepeak:  { bar: 'bg-orange-500',  tag: 'PEAK',     tagBg: 'bg-orange-900/40 text-orange-300' },
  info:      { bar: 'bg-zinc-700',    tag: 'INFO',     tagBg: 'bg-zinc-800/60 text-zinc-400' },
  warning:   { bar: 'bg-red-500',     tag: 'WARN',     tagBg: 'bg-red-900/40 text-red-300' },
};

function BulletRow({ b }: { b: ReportBullet }) {
  const style = CATEGORY_STYLES[b.category];
  return (
    <li className="flex items-start gap-3 py-1.5">
      <span className={`mt-1 inline-block h-3 w-1 shrink-0 rounded-full ${style.bar}`} />
      <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${style.tagBg}`}>
        {style.tag}
      </span>
      <span className="text-sm leading-snug text-zinc-200">{b.text}</span>
    </li>
  );
}

export function MasteringReportPanel(props: Props) {
  const { snapshot, report: passedReport, className, collapseMinor = true } = props;
  const [showMinor, setShowMinor] = useState(false);

  const report = useMemo<MasteringReport>(() => {
    if (passedReport) return passedReport;
    return generateMasteringReport(snapshot ?? {});
  }, [passedReport, snapshot]);

  const major = report.bullets.filter((b) => b.importance === 'major');
  const minor = report.bullets.filter((b) => b.importance === 'minor');
  const visibleMinor = collapseMinor && !showMinor ? [] : minor;

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 ${className ?? ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Mastering Report
        </h3>
        <span className="text-[10px] tabular-nums text-zinc-500">
          {report.totalActions} action{report.totalActions === 1 ? '' : 's'}
        </span>
      </div>

      <p className="mb-4 rounded-lg border border-emerald-700/40 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-200">
        {report.summary}
      </p>

      {report.bullets.length === 0 ? (
        <p className="text-xs text-zinc-500">No actions to report.</p>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {major.map((b, i) => <BulletRow key={`maj-${i}`} b={b} />)}
          {visibleMinor.map((b, i) => <BulletRow key={`min-${i}`} b={b} />)}
        </ul>
      )}

      {collapseMinor && minor.length > 0 && (
        <button
          onClick={() => setShowMinor((v) => !v)}
          className="mt-3 text-[11px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        >
          {showMinor
            ? `Hide ${minor.length} additional detail${minor.length === 1 ? '' : 's'}`
            : `+${minor.length} additional detail${minor.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

export default MasteringReportPanel;
