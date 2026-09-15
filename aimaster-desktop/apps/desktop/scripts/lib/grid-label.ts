// What the chart is actually on.
//
// Small enough to look pointless as its own file, and it is not: the whole
// claim is that a report must never print a tempo the detector REJECTED as
// though the chart were on it.  Buried inside the benchmark's output code
// that claim cannot be tested, and an untestable honesty property is a
// decoration.

export interface GridReport {
  /** What the tempo detector returned, whatever became of it. */
  detectedBpm: number;
  detectedConfidence: number;
  /** Whether the chord detector actually laid its grid from that tempo. */
  fromTempo: boolean;
  /** The grid's own BPM — zero for a fixed window. */
  gridBpm: number;
}

export function describeGrid(report: GridReport): string {
  if (report.fromTempo) return `${report.gridBpm.toFixed(1)} BPM`;
  return report.detectedBpm > 0
    ? `고정 창 (${report.detectedBpm.toFixed(0)} BPM 을 신뢰도 `
      + `${(report.detectedConfidence * 100).toFixed(0)}% 로 기각)`
    : '고정 창 (템포 없음)';
}
