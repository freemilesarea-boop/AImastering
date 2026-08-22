// KeyEditorInspector — the left panel: Scale Assistant, Chord Editing,
// Quantize, Transpose, Length and Humanize.
//
// Every button here calls the same pure function the keyboard shortcut calls,
// so the panel and the key never disagree about what an operation does.

import React, { useMemo } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useMidiEditorStore, currentGridBeat } from '../../../stores/midiEditorStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips, updateClip } from '../../../daw/model/session-ops.js';
import {
  quantizeNotes, humanizeNotes, transposeNotes, quantizePitches, applyLegato,
  scaleLegato, fixedLengths, extendToNextSelected, deleteOverlapsMono,
  deleteOverlapsPoly, glueNotes, setVelocity, velocityRamp, scaleVelocityRange,
} from '../../../daw/edit/midi-edit.js';
import { SCALES, PITCH_CLASS_NAMES, suggestScales, scaleName } from '../../../daw/model/scales.js';
import { detectChord, formatChord, voiceChord, QUALITIES, makeChord } from '../../../daw/model/chords.js';
import { createNote, from7bit, noteEndBeat, type MidiNote } from '../../../daw/model/midi.js';
import { beatsToSecAt, partClock, secToBeatsAt } from '../../../daw/model/note-time.js';
import { tempoMapOf } from '../../../daw/model/tempo-map.js';

const COMMON_QUALITIES = ['maj', 'min', 'sus4', 'sus2', 'dim', 'aug',
  'maj7', 'dom7', 'min7', 'min6', 'min7b5', 'minMaj7', 'sus4_7', 'dim7'] as const;

export default function KeyEditorInspector() {
  const session = useDawStore((s) => s.session);
  const apply   = useDawStore((s) => s.apply);
  const notify  = useAppStore((s) => s.notify);

  const open          = useMidiEditorStore((s) => s.open);
  const selectedIds   = useMidiEditorStore((s) => s.selectedNoteIds);
  const setSelection  = useMidiEditorStore((s) => s.setSelection);
  const scale         = useMidiEditorStore((s) => s.scale);
  const setScale      = useMidiEditorStore((s) => s.setScale);
  const showGuides    = useMidiEditorStore((s) => s.showScaleGuides);
  const toggleGuides  = useMidiEditorStore((s) => s.toggleScaleGuides);
  const snapPitch     = useMidiEditorStore((s) => s.snapPitchEditing);
  const toggleSnapPitch = useMidiEditorStore((s) => s.toggleSnapPitchEditing);
  const quantize      = useMidiEditorStore((s) => s.quantize);
  const setQuantize   = useMidiEditorStore((s) => s.setQuantize);
  const humanizeTimingMs = useMidiEditorStore((s) => s.humanizeTimingMs);
  const humanizeVelocity = useMidiEditorStore((s) => s.humanizeVelocity);
  const humanizeSeed  = useMidiEditorStore((s) => s.humanizeSeed);
  const setHumanize   = useMidiEditorStore((s) => s.setHumanize);
  const legatoPercent = useMidiEditorStore((s) => s.legatoPercent);
  const setLegatoPercent = useMidiEditorStore((s) => s.setLegatoPercent);
  const overlapMs     = useMidiEditorStore((s) => s.overlapMs);
  const setOverlapMs  = useMidiEditorStore((s) => s.setOverlapMs);
  const transposeSemitones = useMidiEditorStore((s) => s.transposeSemitones);
  const setTransposeSemitones = useMidiEditorStore((s) => s.setTransposeSemitones);
  const scaleCorrection = useMidiEditorStore((s) => s.scaleCorrection);
  const toggleScaleCorrection = useMidiEditorStore((s) => s.toggleScaleCorrection);

  const track = open ? findTrack(session, open.trackId) : undefined;
  const part = track ? trackClips(track).find((c) => c.id === open?.clipId) : undefined;
  const notes = useMemo(() => part?.notes ?? [], [part]);
  const targetIds = useMemo(
    () => new Set(selectedIds.length > 0 ? selectedIds : notes.map((n) => n.id)),
    [selectedIds, notes],
  );
  const gridBeat = currentGridBeat();
  // The one place this panel needs the timeline: turning a millisecond feel
  // (humanize, legato overlap) into the beats the notes live in, and the
  // part's beat length back into the seconds its box is drawn with.
  const clock = useMemo(
    () => partClock(tempoMapOf(session), part?.startSec ?? 0),
    [session, part?.startSec],
  );
  const msToBeats = (ms: number): number => secToBeatsAt(clock, ms / 1000);

  const write = (next: MidiNote[]): void => {
    if (!open) return;
    apply((s) => updateClip(s, open.trackId, open.clipId, (c) => ({
      ...c,
      notes: next,
      durationSec: Math.max(
        c.durationSec,
        beatsToSecAt(clock, next.reduce((m, n) => Math.max(m, noteEndBeat(n)), 0)),
      ),
    })));
  };

  const suggestions = useMemo(
    () => suggestScales(notes.map((n) => ({ pitch: n.pitch, weight: n.durationBeat })), 6),
    [notes],
  );

  const selectedChord = useMemo(() => {
    const picked = notes.filter((n) => selectedIds.includes(n.id));
    return picked.length >= 2 ? detectChord(picked.map((n) => n.pitch)) : null;
  }, [notes, selectedIds]);

  if (!open || !part) return null;

  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800 bg-[#0e0e15] px-2 py-2 space-y-2">
      {/* ── Scale Assistant ─────────────────────────────────────────────── */}
      <Section title="Scale Assistant">
        <div className="flex gap-1">
          <select
            value={scale.root}
            onChange={(e) => setScale({ ...scale, root: Number(e.target.value) })}
            className="h-6 flex-1 min-w-0 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300"
          >
            {PITCH_CLASS_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          <select
            value={scale.scaleId}
            onChange={(e) => setScale({ ...scale, scaleId: e.target.value })}
            className="h-6 flex-[2] min-w-0 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300"
          >
            {SCALES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <Check label="Show Scale Note Guides" checked={showGuides} onChange={toggleGuides} />
        <Check label="Snap Pitch Editing" checked={snapPitch} onChange={toggleSnapPitch} />

        {suggestions.length > 0 && (
          <div className="space-y-0.5 pt-1">
            <p className="text-[9px] text-zinc-600">Scale Suggestions</p>
            {suggestions.slice(0, 4).map((s) => (
              <button
                key={`${s.scale.root}-${s.scale.scaleId}`}
                onClick={() => setScale(s.scale)}
                className="w-full flex items-center justify-between px-1.5 py-0.5 rounded
                           bg-zinc-900/70 border border-zinc-800 hover:border-zinc-600 text-[10px]"
              >
                <span className="text-zinc-300 truncate">{scaleName(s.scale)}</span>
                <span className="text-zinc-600 font-mono">{Math.round(s.score * 100)}</span>
              </button>
            ))}
          </div>
        )}

        <Action onClick={() => { write(quantizePitches(notes, targetIds, scale)); notify('스케일로 피치 퀀타이즈'); }}>
          Quantize Pitches
        </Action>
      </Section>

      {/* ── Chord Editing ───────────────────────────────────────────────── */}
      <Section title="Chord Editing">
        <div className="h-6 rounded bg-zinc-900 border border-zinc-700 flex items-center justify-center">
          <span className="text-[11px] text-zinc-200">
            {selectedChord ? formatChord(selectedChord.chord) : '—'}
          </span>
        </div>
        <p className="text-[9px] text-zinc-600 leading-snug">
          코드 버튼: 선택 노트의 최저음을 근음으로 코드를 만듭니다.
        </p>
        <div className="grid grid-cols-2 gap-1">
          {COMMON_QUALITIES.map((qid) => {
            const quality = QUALITIES.find((q) => q.id === qid);
            return (
              <button
                key={qid}
                onClick={() => {
                  const picked = notes.filter((n) => selectedIds.includes(n.id));
                  const rootNote = picked.length > 0
                    ? picked.reduce((low, n) => (n.pitch < low.pitch ? n : low))
                    : null;
                  if (!rootNote) { notify('노트를 먼저 선택하세요', 'warning'); return; }
                  const voiced = voiceChord(makeChord(rootNote.pitch % 12, qid), rootNote.pitch);
                  const others = notes.filter((n) => !selectedIds.includes(n.id));
                  const built = voiced.map((pitch) => createNote({
                    pitch,
                    startBeat: rootNote.startBeat,
                    durationBeat: rootNote.durationBeat,
                    velocity: rootNote.velocity,
                  }));
                  write([...others, ...built]);
                  setSelection(built.map((n) => n.id));
                  notify(`${formatChord(makeChord(rootNote.pitch % 12, qid))} 생성`);
                }}
                className="h-6 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-600
                           text-[9px] text-zinc-300"
              >{quality?.suffix || 'maj'}</button>
            );
          })}
        </div>
      </Section>

      {/* ── Quantize ────────────────────────────────────────────────────── */}
      <Section title="Quantize">
        <Slider label="Strength" value={quantize.strengthPercent ?? 100} min={0} max={100} step={1}
          suffix="%" onChange={(v) => setQuantize({ strengthPercent: v })} />
        <Slider label="Swing" value={quantize.swingPercent ?? 0} min={0} max={100} step={1}
          suffix="%" onChange={(v) => setQuantize({ swingPercent: v })} />
        <Slider label="Randomize" value={Math.round((quantize.randomizeBeat ?? 0) * 1000) / 10}
          min={0} max={25} step={0.5}
          suffix="%박" onChange={(v) => setQuantize({ randomizeBeat: v / 100 })} />
        <Slider label="Catch" value={Math.round((quantize.catchRangeBeat ?? 0) * 100)}
          min={0} max={100} step={5}
          suffix="%박" onChange={(v) => setQuantize({ catchRangeBeat: v / 100 })} />
        <Action onClick={() => {
          write(quantizeNotes(notes, targetIds, { ...quantize, gridBeat }));
          notify('퀀타이즈 적용');
        }}>Apply Quantize</Action>
        <Action onClick={() => {
          write(quantizeNotes(notes, targetIds, { ...quantize, gridBeat, quantizeLengths: true }));
          notify('길이 퀀타이즈');
        }}>Quantize Lengths</Action>
        <Action onClick={() => {
          write(quantizeNotes(notes, targetIds, { ...quantize, gridBeat, quantizeEnds: true }));
          notify('엔드 퀀타이즈');
        }}>Quantize Ends</Action>
      </Section>

      {/* ── Humanize ────────────────────────────────────────────────────── */}
      <Section title="Humanize">
        <Slider label="Timing" value={humanizeTimingMs} min={0} max={60} step={1} suffix="ms"
          onChange={(v) => setHumanize({ timingMs: v })} />
        <Slider label="Velocity" value={Math.round(humanizeVelocity * 127)} min={0} max={40} step={1}
          suffix="" onChange={(v) => setHumanize({ velocity: v / 127 })} />
        <Slider label="Seed" value={humanizeSeed} min={1} max={99} step={1} suffix=""
          onChange={(v) => setHumanize({ seed: v })} />
        <Action onClick={() => {
          write(humanizeNotes(notes, targetIds, {
            timingBeat: msToBeats(humanizeTimingMs),
            velocity: humanizeVelocity,
            gridBeat,
            seed: humanizeSeed,
          }));
          notify('휴머나이즈 적용 (시드 고정 — 바운스에서 그대로 재현)');
        }}>Apply Humanize</Action>
      </Section>

      {/* ── Transpose ───────────────────────────────────────────────────── */}
      <Section title="Transpose">
        <Slider label="Semitones" value={transposeSemitones} min={-24} max={24} step={1} suffix=""
          onChange={setTransposeSemitones} />
        <Check label="Scale Correction" checked={scaleCorrection} onChange={toggleScaleCorrection} />
        <Action onClick={() => {
          write(transposeNotes(notes, targetIds, {
            semitones: transposeSemitones,
            scale: scaleCorrection ? scale : null,
          }));
          notify(`${transposeSemitones > 0 ? '+' : ''}${transposeSemitones} 반음 이조`);
        }}>Apply Transpose</Action>
      </Section>

      {/* ── Length ──────────────────────────────────────────────────────── */}
      <Section title="Length">
        <Slider label="Scale Legato" value={legatoPercent} min={0} max={100} step={1} suffix="%"
          onChange={setLegatoPercent} />
        <Slider label="Overlap" value={overlapMs} min={-200} max={200} step={5} suffix="ms"
          onChange={setOverlapMs} />
        <Action onClick={() => {
          write(legatoPercent > 0
            ? scaleLegato(notes, targetIds, legatoPercent, msToBeats(overlapMs))
            : applyLegato(notes, targetIds, msToBeats(overlapMs)));
          notify('레가토 적용');
        }}>Apply Legato</Action>
        <Action onClick={() => { write(fixedLengths(notes, targetIds, gridBeat)); notify('고정 길이'); }}>
          Fixed Lengths
        </Action>
        <Action onClick={() => { write(extendToNextSelected(notes, targetIds)); notify('다음 선택 노트까지 연장'); }}>
          Extend to Next Selected
        </Action>
        <Action onClick={() => { write(deleteOverlapsMono(notes)); notify('겹침 제거 (mono)'); }}>
          Delete Overlaps (mono)
        </Action>
        <Action onClick={() => { write(deleteOverlapsPoly(notes)); notify('겹침 제거 (poly)'); }}>
          Delete Overlaps (poly)
        </Action>
        <Action onClick={() => { write(glueNotes(notes, targetIds)); notify('노트 결합'); }}>
          Glue Notes
        </Action>
      </Section>

      {/* ── Velocity ────────────────────────────────────────────────────── */}
      <Section title="Velocity">
        <div className="grid grid-cols-2 gap-1">
          <Action onClick={() => { write(setVelocity(notes, targetIds, from7bit(100))); notify('벨로시티 100'); }}>
            Set 100
          </Action>
          <Action onClick={() => { write(scaleVelocityRange(notes, targetIds, 0.5)); notify('벨로시티 압축'); }}>
            Compress
          </Action>
          <Action onClick={() => { write(velocityRamp(notes, targetIds, 0.35, 1)); notify('크레셴도'); }}>
            Cresc.
          </Action>
          <Action onClick={() => { write(velocityRamp(notes, targetIds, 1, 0.35)); notify('디크레셴도'); }}>
            Dim.
          </Action>
        </div>
      </Section>
    </aside>
  );
}

// ── Small controls ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="px-2 py-1 border-b border-zinc-800 bg-zinc-900/60">
        <span className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 font-semibold">{title}</span>
      </div>
      <div className="p-1.5 space-y-1">{children}</div>
    </div>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full h-6 rounded bg-zinc-800/70 border border-zinc-700 text-[10px]
                 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
    >{children}</button>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-indigo-500 w-3 h-3" />
      <span className="text-[10px] text-zinc-400">{label}</span>
    </label>
  );
}

function Slider({
  label, value, min, max, step, suffix, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  suffix: string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] text-zinc-600">{label}</span>
        <span className="text-[9px] font-mono text-zinc-400">{value}{suffix}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-indigo-500"
      />
    </div>
  );
}
