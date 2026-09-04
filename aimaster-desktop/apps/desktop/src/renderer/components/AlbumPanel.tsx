// AlbumPanel — turn a queue of finished masters into a record.
//
// Mastering one song at a time is what the app does; delivering an album is a
// separate decision with its own consequences, so it gets its own panel rather
// than another checkbox on the export.  Three things happen here and nothing
// else:
//
//   • ORDER and GAPS — the running order, and the silence between songs, shown
//     as the PQ layout a plant would read.  The times are the real ones, on the
//     CD's 75-frames-a-second grid, not seconds rounded for display.
//   • LEVELS — album mode by default, which moves every song by the SAME
//     amount and so keeps the record's shape.  The spread between the loudest
//     and quietest song is shown next to it, because that number staying put
//     IS album mode working.
//   • PROBLEMS — Red Book errors before anyone sends anything, not after.
//
// The panel is read-mostly: it computes from the queue and the album, and the
// only writes are the ones a person makes.

import React, { useMemo, useState } from 'react';
import { useAudioStore, type QueueItem } from '../stores/audioStore.js';
import { premium } from '../theme/premium.js';
import {
  addAlbumTrack, albumLayout, createAlbum, framesToMsf, hasErrors, moveAlbumTrack,
  removeAlbumTrack, setAllGaps, updateAlbumTrack, validateAlbum,
  type Album, type AlbumTrack,
} from '../daw/album/album.js';
import {
  DEFAULT_LEVELS, LEVEL_LABELS, describeLevels, loudnessSpread, planLevels,
  type LevelMode, type TrackLoudness,
} from '../daw/album/album-levels.js';
import { toCueSheet, toPqLog } from '../daw/album/cue-sheet.js';

const field = {
  background: '#1d1d28', border: '1px solid #3a3a48', borderRadius: 4,
  padding: '3px 7px', fontSize: 11, color: premium.text.primary,
} as const;

/** A finished master, as an album track. */
function trackFromQueue(item: QueueItem): AlbumTrack | null {
  const result = item.masteringResult;
  if (!result) return null;
  return {
    id: item.id,
    title: item.fileName.replace(/\.[^.]+$/, ''),
    sourcePath: result.outputPath,
    // Duration comes from the ANALYSIS, which measured the source; the master
    // is the same length.  Zero when it is not known, which validation then
    // reports as a too-short track rather than the panel guessing a number.
    durationSec: item.analysis?.fileInfo.durationSec ?? 0,
    gapBeforeSec: 2,
    gainDb: 0,
  };
}

export default function AlbumPanel({ onClose }: { onClose: () => void }) {
  const queue = useAudioStore((s) => s.queue);
  const done = useMemo(() => queue.filter((i) => i.status === 'done' && i.masteringResult), [queue]);

  const [album, setAlbum] = useState<Album>(() => {
    let a = createAlbum();
    for (const item of queue) {
      if (item.status !== 'done') continue;
      const track = trackFromQueue(item);
      if (track) a = addAlbumTrack(a, track);
    }
    return a;
  });
  const [mode, setMode] = useState<LevelMode>(DEFAULT_LEVELS.mode);
  const [targetLufs, setTargetLufs] = useState(DEFAULT_LEVELS.targetLufs);

  const layout = useMemo(() => albumLayout(album), [album]);
  const problems = useMemo(() => validateAlbum(album), [album]);

  // Loudness comes from what each master already reported — nothing is
  // re-analysed to draw this panel.
  const loudness = useMemo<TrackLoudness[]>(() => album.tracks.map((t) => {
    const item = done.find((q) => q.id === t.id);
    const after = item?.masteringResult?.loudnessAfter;
    return {
      trackId: t.id,
      // NaN, not -Infinity: a track nobody measured must not read as silence.
      integratedLufs: after?.integratedLufs ?? NaN,
      truePeakDbtp: after?.truePeakDbtp ?? 0,
      durationSec: t.durationSec,
    };
  }), [album.tracks, done]);

  const plan = useMemo(
    () => planLevels(loudness, { mode, targetLufs }),
    [loudness, mode, targetLufs],
  );
  const spreadBefore = useMemo(() => loudnessSpread(loudness), [loudness]);
  const spreadAfter = useMemo(() => loudnessSpread(loudness, plan), [loudness, plan]);

  const gainOf = (trackId: string): number =>
    plan.adjustments.find((a) => a.trackId === trackId)?.gainDb ?? 0;

  const download = (name: string, text: string): void => {
    // Written through the same save dialog the rest of the app uses; the
    // browser download path does not exist inside Electron.
    void window.electronAPI?.invoke('daw:bounce-audio', {
      name, data: new TextEncoder().encode(text),
    });
  };

  const errors = hasErrors(problems);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-lg border p-5 overflow-auto"
        style={{
          width: 820, maxHeight: '86vh', background: '#15151d', borderColor: '#3a3a48',
          fontFamily: premium.type.sans, color: premium.text.primary,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="album-panel"
      >
        <div className="flex items-baseline justify-between mb-3">
          <h2 style={{ fontFamily: premium.type.display, fontSize: 17 }}>앨범 만들기</h2>
          <span style={{ fontSize: 11, color: premium.text.muted }} data-testid="album-total">
            {album.tracks.length}곡 · {framesToMsf(layout.totalFrames)}
          </span>
        </div>

        {/* Album metadata */}
        <div className="flex gap-2 mb-3">
          <input
            style={{ ...field, flex: 2 }} value={album.title} placeholder="앨범 제목"
            onChange={(e) => setAlbum((a) => ({ ...a, title: e.target.value }))}
            data-testid="album-title"
          />
          <input
            style={{ ...field, flex: 2 }} value={album.performer} placeholder="아티스트"
            onChange={(e) => setAlbum((a) => ({ ...a, performer: e.target.value }))}
          />
          <input
            style={{ ...field, flex: 1 }} value={album.upc ?? ''} placeholder="UPC / EAN"
            onChange={(e) => setAlbum((a) => ({ ...a, upc: e.target.value }))}
          />
        </div>

        {/* Levels */}
        <div
          className="flex items-center gap-3 mb-3 px-3 py-2 rounded"
          style={{ background: '#1d1d28' }}
        >
          <select
            value={mode} style={field}
            onChange={(e) => setMode(e.target.value as LevelMode)}
            data-testid="album-level-mode"
          >
            {(Object.keys(LEVEL_LABELS) as LevelMode[]).map((m) => (
              <option key={m} value={m}>{LEVEL_LABELS[m]}</option>
            ))}
          </select>
          <label style={{ fontSize: 11, color: premium.text.muted }}>목표</label>
          <input
            type="number" step={0.5} value={targetLufs} style={{ ...field, width: 66 }}
            onChange={(e) => setTargetLufs(Number(e.target.value))}
            disabled={mode === 'off'}
          />
          <span style={{ fontSize: 11, color: premium.text.muted }}>LUFS</span>
          <span
            className="flex-1 text-right"
            style={{ fontSize: 11, color: premium.text.secondary }}
            data-testid="album-spread"
          >
            곡 간 차이 {spreadBefore.toFixed(1)} → <b
              style={{ color: mode === 'album' ? premium.accent.light : '#e0a050' }}
            >{spreadAfter.toFixed(1)}</b> dB
          </span>
        </div>

        {/* Gaps */}
        <div className="flex items-center gap-2 mb-2">
          <span style={{ fontSize: 11, color: premium.text.muted }}>모든 곡 간격</span>
          {[0, 1, 2, 3, 4].map((g) => (
            <button
              key={g}
              className="px-2 py-0.5 rounded text-[11px]"
              style={{ background: '#2a2a36', color: premium.text.secondary }}
              onClick={() => setAlbum((a) => setAllGaps(a, g))}
            >{g === 0 ? '이어붙임' : `${g}초`}</button>
          ))}
        </div>

        {/* The running order */}
        <div className="rounded mb-3 overflow-auto" style={{ background: '#1d1d28', maxHeight: 300 }}>
          <div
            className="flex gap-2 px-3 py-1 sticky top-0"
            style={{ background: '#22222e', fontSize: 10, color: premium.text.muted }}
          >
            <span style={{ width: 20 }}>#</span>
            <span style={{ flex: 1 }}>제목</span>
            <span style={{ width: 108 }}>ISRC</span>
            <span style={{ width: 44 }}>간격</span>
            <span style={{ width: 62 }}>시작</span>
            <span style={{ width: 62 }}>길이</span>
            <span style={{ width: 54 }}>게인</span>
            <span style={{ width: 46 }} />
          </div>
          {album.tracks.map((track, i) => {
            const at = layout.tracks[i];
            const gain = gainOf(track.id);
            return (
              <div
                key={track.id}
                className="flex gap-2 items-center px-3 py-1"
                style={{ fontSize: 11 }}
                data-testid={`album-row-${i}`}
              >
                <span style={{ width: 20, color: premium.text.muted, fontFamily: 'monospace' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <input
                  style={{ ...field, flex: 1 }} value={track.title}
                  onChange={(e) => setAlbum((a) =>
                    updateAlbumTrack(a, track.id, (t) => ({ ...t, title: e.target.value })))}
                />
                <input
                  style={{ ...field, width: 108, fontFamily: 'monospace' }}
                  value={track.isrc ?? ''} placeholder="ISRC"
                  onChange={(e) => setAlbum((a) =>
                    updateAlbumTrack(a, track.id, (t) => ({ ...t, isrc: e.target.value })))}
                />
                <input
                  type="number" step={0.5} min={0}
                  style={{ ...field, width: 44 }}
                  value={i === 0 ? 0 : track.gapBeforeSec}
                  disabled={i === 0}
                  title={i === 0 ? '첫 곡 앞은 리드인이 담당합니다' : undefined}
                  onChange={(e) => setAlbum((a) =>
                    updateAlbumTrack(a, track.id, (t) => ({ ...t, gapBeforeSec: Number(e.target.value) })))}
                />
                <span style={{ width: 62, fontFamily: 'monospace', color: premium.accent.light }}>
                  {at ? framesToMsf(at.index1Frames) : '—'}
                </span>
                <span style={{ width: 62, fontFamily: 'monospace', color: premium.text.muted }}>
                  {at ? framesToMsf(at.durationFrames) : '—'}
                </span>
                <span
                  style={{
                    width: 54, fontFamily: 'monospace',
                    color: Math.abs(gain) < 0.05 ? premium.text.muted : premium.accent.light,
                  }}
                >
                  {gain >= 0 ? '+' : ''}{gain.toFixed(1)}
                </span>
                <span style={{ width: 46 }} className="flex gap-0.5">
                  <button
                    style={{ color: premium.text.muted }}
                    onClick={() => setAlbum((a) => moveAlbumTrack(a, track.id, i - 1))}
                    disabled={i === 0}
                    title="위로"
                  >↑</button>
                  <button
                    style={{ color: premium.text.muted }}
                    onClick={() => setAlbum((a) => moveAlbumTrack(a, track.id, i + 1))}
                    disabled={i === album.tracks.length - 1}
                    title="아래로"
                  >↓</button>
                  <button
                    style={{ color: '#c06060' }}
                    onClick={() => setAlbum((a) => removeAlbumTrack(a, track.id))}
                    title="빼기"
                  >×</button>
                </span>
              </div>
            );
          })}
          {album.tracks.length === 0 && (
            <div className="px-3 py-6 text-center" style={{ fontSize: 11, color: premium.text.muted }}>
              마스터링이 끝난 곡이 없습니다.
            </div>
          )}
        </div>

        {/* Problems */}
        {problems.length > 0 && (
          <div
            className="rounded mb-3 px-3 py-2"
            style={{ background: '#1d1d28', maxHeight: 120, overflow: 'auto' }}
            data-testid="album-problems"
          >
            {problems.map((p, i) => (
              <div
                key={i}
                style={{ fontSize: 11, color: p.level === 'error' ? '#e07070' : '#e0a050' }}
              >
                {p.track === null ? '앨범' : `${p.track}번`} — {p.message}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span style={{ fontSize: 11, color: premium.text.secondary }} data-testid="album-levels">
            {describeLevels(plan, loudness)}
          </span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 rounded text-sm"
              style={{ background: '#2a2a36', color: premium.text.secondary }}
              onClick={onClose}
            >닫기</button>
            <button
              className="px-3 py-1.5 rounded text-sm"
              style={{ background: '#2a2a36', color: premium.text.secondary }}
              onClick={() => download(`${album.title || 'album'}.pq.txt`,
                toPqLog(album, { levels: describeLevels(plan, loudness) }))}
              data-testid="album-pq"
            >PQ 시트</button>
            <button
              className="px-4 py-1.5 rounded text-sm"
              style={{
                background: errors ? '#3a3a48' : premium.accent.base,
                color: errors ? premium.text.muted : '#101018',
                fontWeight: 600, cursor: errors ? 'not-allowed' : 'pointer',
              }}
              disabled={errors}
              title={errors ? '위의 빨간 문제를 먼저 고쳐야 합니다' : undefined}
              onClick={() => download(`${album.title || 'album'}.cue`,
                toCueSheet(album, {
                  imageFileName: `${album.title || 'album'}.wav`,
                  comment: `Loui · ${describeLevels(plan, loudness)}`,
                }))}
              data-testid="album-cue"
            >큐시트 내보내기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
