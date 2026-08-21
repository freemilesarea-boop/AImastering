/**
 * intel-selftest — the LOUI Intelligence Layer.
 *
 * An intelligent feature that moves faders on someone's mix has to earn trust,
 * and the way it earns it is by being provably conservative:
 *
 *   Every move is capped.  A wrong measurement can annoy; it must not wreck.
 *   Every move is describable.  If it cannot be said, it is not done.
 *   Nothing fires without evidence.  A clean mix produces no findings, an
 *   already-matching reference produces no suggestions, an unrecognised
 *   instruction produces an error and not a guess.
 *
 * The Riff Machine is held to a different bar, because "it produced notes" is
 * not a result: scale-correct noise is still noise.  So it is measured on the
 * rules that separate a riff from a random walk — chord tones on strong beats,
 * a contour that actually goes somewhere, leaps that resolve.
 *
 * The layer is pure from `MixAnalysis` onward, so all of that is testable with
 * synthetic measurements and no audio at all.
 *
 * Run: pnpm --filter @aimaster/desktop test:intel
 */

import {
  applyAction, applyActions, applySuggestions, describeAction, describeSuggestion,
  type IntelAction, type Suggestion,
} from '../src/renderer/daw/ai/actions.js';
import { guessRole, refineRole, ROLE_PROFILES, roleLabel } from '../src/renderer/daw/ai/roles.js';
import { shapeOf, type MixAnalysis, type TrackAnalysis } from '../src/renderer/daw/ai/analysis.js';
import { diagnose, summarise, fixable, type Finding } from '../src/renderer/daw/ai/diagnose.js';
import {
  autoMix, balanceSuggestions, findMasking, maskingSuggestions, panningSuggestions,
  resetSuggestionIds,
} from '../src/renderer/daw/ai/mix.js';
import {
  autoMaster, MASTER_PROFILES, findProfile, resolveTarget, resetMasterIds,
} from '../src/renderer/daw/ai/master.js';
import { matchActions, matchSummary, resetMatchIds } from '../src/renderer/daw/ai/reference-intel.js';
import {
  levelEnvelope, rideCurve, rideSuggestion, duckCurve, duckSuggestion,
} from '../src/renderer/daw/ai/auto-automation.js';
import { interpret, resolveTarget as resolveNlTarget, vocabulary } from '../src/renderer/daw/ai/language.js';
import {
  CONTOURS, RIFF_STYLES, VARIATIONS, contourAt, generateRhythm, generateRiff,
  nextScalePitch, varyRiff, describeRiff, contourLabel, styleLabel,
  type RiffOptions,
} from '../src/renderer/daw/ai/compose.js';
import {
  chordsForClip, riffSuggestion, variationSuggestion, resetRiffIds, variationLabel,
} from '../src/renderer/daw/ai/riff.js';
import { createMidiPart, updateClips, trackClips, setChordTrack as setChords } from '../src/renderer/daw/model/session-ops.js';
import { createNote, noteEnd } from '../src/renderer/daw/model/midi.js';
import { isInScale, scalePitchClasses, type Scale } from '../src/renderer/daw/model/scales.js';
import { chordAt, chordPitchClasses } from '../src/renderer/daw/model/chords.js';
import { captureAsPattern, clipNotes } from '../src/renderer/daw/model/patterns.js';
import { compareToReference, type ReferenceAnalysis, type SpectrumCurve } from '../src/renderer/daw/analysis/reference.js';
import {
  addTrack, createSession, createTrack, findTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { setChordTrack } from '../src/renderer/daw/model/session-ops.js';
import { makeChord } from '../src/renderer/daw/model/chords.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BANDS = 48;

/** Rhythm-only fixture: the pitch settings do not matter to generateRhythm. */
const DEFAULT_RIFF_FIXTURE: RiffOptions = {
  bars: 2, tempoBpm: 120, beatsPerBar: 4, style: 'melody', contour: 'arch',
  density: 0.5, syncopation: 0, lowPitch: 60, highPitch: 79,
  scale: { root: 0, scaleId: 'major' }, chords: [], seed: 1, stepsPerBeat: 4,
};

/** A spectrum curve with a bump at one frequency, level-normalised like the real one. */
function curve(bumps: { hz: number; db: number }[] = []): SpectrumCurve {
  const hz = new Float32Array(BANDS);
  const db = new Float32Array(BANDS);
  for (let i = 0; i < BANDS; i++) {
    hz[i] = 20 * Math.exp((Math.log(20000 / 20) * i) / BANDS);
    let value = 0;
    for (const bump of bumps) {
      const octaves = Math.log2((hz[i] ?? 20) / bump.hz);
      value += bump.db * Math.exp(-(octaves * octaves) / 0.5);
    }
    db[i] = value;
  }
  return { hz, db };
}

function referenceAnalysis(over: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis {
  return {
    name: 'REFERENCE',
    durationSec: 180,
    sampleRate: 48000,
    channels: 2,
    integratedLufs: -14,
    truePeakDbtp: -1.2,
    dr: 12.8,
    lra: 6,
    correlation: 0.2,
    widthPercent: 80,
    lowDb: 0,
    midDb: 0,
    highDb: 0,
    spectrum: curve(),
    stereo: [],
    shortTerm: new Float32Array([-14, -14, -14]),
    ...over,
  };
}

function trackAnalysis(
  trackId: string, name: string, over: Partial<TrackAnalysis> = {},
): TrackAnalysis {
  const spectrum = over.spectrum ?? curve();
  const crestDb = over.crestDb ?? 10;
  return {
    trackId,
    name,
    guess: guessRole(name, 'audio'),
    integratedLufs: -18,
    truePeakDbtp: -6,
    crestDb,
    spectrum,
    shape: shapeOf(spectrum, crestDb),
    correlation: 0.5,
    widthPercent: 50,
    silent: false,
    ...over,
  };
}

function mixAnalysis(
  tracks: TrackAnalysis[], master: Partial<ReferenceAnalysis> = {},
): MixAnalysis {
  return {
    master: referenceAnalysis({ name: 'YOUR MIX', ...master }),
    tracks,
    sampleRate: 48000,
    durationSec: 180,
  };
}

function sessionWith(names: string[]): { session: DawSession; ids: string[] } {
  resetIds();
  let session = createSession('intel test');
  const ids: string[] = [];
  for (const name of names) {
    const track = createTrack(name, 'audio');
    ids.push(track.id);
    session = addTrack(session, track);
  }
  return { session, ids };
}

// ── Actions ───────────────────────────────────────────────────────────────────

check('actions apply and clamp', () => {
  const { session, ids } = sessionWith(['Vox']);
  const id = ids[0]!;
  const louder = applyAction(session, { kind: 'trackVolume', trackId: id, db: 3 });
  close(findTrack(louder, id)?.volumeDb ?? 0, 3, 'fader moved', 1e-9);

  const absurd = applyAction(session, { kind: 'trackVolume', trackId: id, db: 999 });
  assert((findTrack(absurd, id)?.volumeDb ?? 0) <= 12, 'a runaway suggestion is clamped');

  const panned = applyAction(session, { kind: 'trackPan', trackId: id, pan: -5 });
  close(findTrack(panned, id)?.pan ?? 0, -1, 'pan clamped to hard left', 1e-9);
});

check('an insert parameter creates the plugin if the chain has none', () => {
  const { session, ids } = sessionWith(['Vox']);
  const id = ids[0]!;
  eq(findTrack(session, id)?.inserts.length, 0, 'no inserts to start');

  const next = applyAction(session, {
    kind: 'insertParam', trackId: id, pluginId: 'eq3', paramId: 'lowDb', value: -3,
  });
  const insert = findTrack(next, id)?.inserts.find((i) => i.pluginId === 'eq3');
  assert(!!insert, 'the EQ was created');
  close(insert!.params['lowDb'] ?? 0, -3, 'and the parameter written');
  // Its other parameters are the plugin's defaults, not zero.
  close(insert!.params['hpfHz'] ?? -1, 20, 'defaults filled in');

  // A second write reuses the same insert instead of stacking another EQ.
  const again = applyAction(next, {
    kind: 'insertParam', trackId: id, pluginId: 'eq3', paramId: 'highDb', value: 2,
  });
  eq(findTrack(again, id)?.inserts.filter((i) => i.pluginId === 'eq3').length, 1, 'one EQ only');
});

check('an insert parameter is clamped to what the plugin accepts', () => {
  const { session, ids } = sessionWith(['Vox']);
  const next = applyAction(session, {
    kind: 'insertParam', trackId: ids[0]!, pluginId: 'eq3', paramId: 'lowDb', value: -900,
  });
  const insert = findTrack(next, ids[0]!)?.inserts.find((i) => i.pluginId === 'eq3');
  close(insert?.params['lowDb'] ?? 0, -18, 'clamped to the plugin range', 1e-9);
});

check('automation writes a lane, and writing again replaces it', () => {
  const { session, ids } = sessionWith(['Vox']);
  const id = ids[0]!;
  const points = [{ timeSec: 0, value: 0 }, { timeSec: 1, value: -3 }];
  const first = applyAction(session, {
    kind: 'automation', trackId: id, target: { kind: 'volume' }, points,
  });
  eq(findTrack(first, id)?.automation.length, 1, 'one lane');
  eq(findTrack(first, id)?.automation[0]?.points.length, 2, 'two points');

  const second = applyAction(first, {
    kind: 'automation', trackId: id, target: { kind: 'volume' },
    points: [{ timeSec: 0, value: 1 }],
  });
  eq(findTrack(second, id)?.automation.length, 1, 'still one lane, not two');
  eq(findTrack(second, id)?.automation[0]?.points.length, 1, 'replaced');
});

check('every action describes itself in one sentence', () => {
  const { session, ids } = sessionWith(['Vox']);
  const id = ids[0]!;
  const actions: IntelAction[] = [
    { kind: 'trackVolume', trackId: id, db: -2 },
    { kind: 'trackPan', trackId: id, pan: -0.5 },
    { kind: 'macro', trackId: id, macroId: 'warmth', value: 0.4 },
    { kind: 'insertParam', trackId: id, pluginId: 'eq3', paramId: 'lowDb', value: -3 },
    { kind: 'addInsert', trackId: id, pluginId: 'limiter' },
    { kind: 'removeInsert', trackId: id, slot: 0 },
    { kind: 'bypassInsert', trackId: id, slot: 0, bypass: true },
    { kind: 'automation', trackId: id, target: { kind: 'volume' }, points: [{ timeSec: 0, value: 0 }] },
  ];
  for (const action of actions) {
    const text = describeAction(session, action);
    assert(text.length > 0 && !text.includes('undefined'), `describes ${action.kind}: "${text}"`);
    assert(text.includes('Vox'), `names the track: "${text}"`);
  }
  assert(describeAction(session, { kind: 'trackVolume', trackId: id, db: -2 }).includes('-2.0 dB'),
    'and states the number');
});

// ── Roles ─────────────────────────────────────────────────────────────────────

check('roles are guessed from names, in both languages', () => {
  eq(guessRole('Lead Vox', 'audio').role, 'vocal', 'English');
  eq(guessRole('보컬 1', 'audio').role, 'vocal', 'Korean');
  eq(guessRole('Kick In', 'audio').role, 'kick', 'kick');
  eq(guessRole('808', 'audio').role, 'bass', 'an 808 is a bass');
  eq(guessRole('Vox Double', 'audio').role, 'backing', 'a double is backing, not lead');
  eq(guessRole('Master', 'master').role, 'master', 'by kind');
  eq(guessRole('Bus 1', 'aux').role, 'bus', 'aux is a bus');
});

check('an unrecognised name gets no guess, not a wrong one', () => {
  const guess = guessRole('Audio 3', 'audio');
  eq(guess.role, 'other', 'no role');
  eq(guess.confidence, 0, 'and no confidence');
  eq(guess.matched, null, 'nothing matched');
});

check('measurement corrects a weak guess but never overrules a strong one', () => {
  const bassShape = { lowShare: 0.85, midShare: 0.1, highShare: 0.02, crestDb: 6 };
  const weak = refineRole(guessRole('Audio 3', 'audio'), bassShape);
  eq(weak.role, 'bass', 'the spectrum named it');
  assert(weak.matched?.includes('측정'), 'and says it was the measurement');

  // A user who typed "Vocal" meant it, even if the take is unusually dark.
  const strong = refineRole(guessRole('Vocal', 'audio'), bassShape);
  eq(strong.role, 'vocal', 'the name wins');
});

check('role profiles cover every role', () => {
  const roles = ['vocal', 'backing', 'kick', 'snare', 'hat', 'drums', 'bass',
    'guitar', 'keys', 'synth', 'pad', 'fx', 'bus', 'master', 'other'] as const;
  for (const role of roles) {
    assert(!!ROLE_PROFILES[role], `profile for ${role}`);
    assert(roleLabel(role).length > 0, `label for ${role}`);
  }
  assert(ROLE_PROFILES.vocal.priority > ROLE_PROFILES.pad.priority, 'a vocal beats a pad');
  eq(ROLE_PROFILES.kick.pan, 0, 'a kick is never panned');
});

// ── Diagnosis ─────────────────────────────────────────────────────────────────

function cleanMix(): { session: DawSession; analysis: MixAnalysis } {
  const { session, ids } = sessionWith(['Lead Vox', 'Kick']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { integratedLufs: -16 }),
    trackAnalysis(ids[1]!, 'Kick', { integratedLufs: -17 }),
  ], { integratedLufs: -14, truePeakDbtp: -1.2, dr: 11, correlation: 0.3, widthPercent: 70 });
  return { session, analysis };
}

check('a clean mix produces no critical findings', () => {
  const { session, analysis } = cleanMix();
  const findings = diagnose(session, analysis);
  eq(findings.filter((f) => f.severity === 'critical').length, 0, 'nothing critical');
  assert(summarise(findings).length > 0, 'still summarises');
  eq(summarise([]), '문제를 찾지 못했습니다', 'and says so when there is nothing');
});

check('a true peak over the ceiling is caught, with a fix', () => {
  const { session, analysis } = cleanMix();
  const hot = { ...analysis, master: { ...analysis.master, truePeakDbtp: 0.6 } };
  const finding = diagnose(session, hot).find((f) => f.id === 'truepeak');
  assert(!!finding, 'found');
  eq(finding!.severity, 'critical', 'over 0 dBTP is critical');
  assert(finding!.measurement.includes('0.60'), 'states the measurement');
  assert(finding!.actions.length > 0, 'and ships a fix');
  eq(finding!.actions[0]?.kind, 'insertParam', 'which sets the limiter ceiling');
});

check('phase cancellation is reported but not "fixed" by guessing', () => {
  const { session, analysis } = cleanMix();
  const broken = { ...analysis, master: { ...analysis.master, correlation: -0.5, widthPercent: 150 } };
  const finding = diagnose(session, broken).find((f) => f.id === 'phase');
  assert(!!finding, 'found');
  eq(finding!.severity, 'critical', 'critical');
  eq(finding!.actions.length, 0, 'no automatic fix — the cause could be anywhere');
  assert(!!finding!.manual, 'but it says what to check');
});

check('a clipping track is caught and the fix pulls it below zero', () => {
  const { session, ids } = sessionWith(['Lead Vox']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { truePeakDbtp: 2.5, integratedLufs: -9 }),
  ]);
  const finding = diagnose(session, analysis).find((f) => f.id.startsWith('clip:'));
  assert(!!finding, 'found');
  const applied = applyActions(session, finding!.actions);
  const moved = findTrack(applied, ids[0]!)?.volumeDb ?? 0;
  assert(moved <= -3.5, `the fader comes down past the overshoot, got ${moved}`);
});

check('muddiness is measured against the mix\'s own mid, not an absolute', () => {
  const { session, analysis } = cleanMix();
  const muddy = {
    ...analysis,
    master: { ...analysis.master, spectrum: curve([{ hz: 300, db: 9 }]) },
  };
  const finding = diagnose(session, muddy).find((f) => f.id === 'mud');
  assert(!!finding, 'found');
  const cut = finding!.actions.find((a) => a.kind === 'insertParam' && a.paramId === 'midDb');
  assert(cut?.kind === 'insertParam' && cut.value < 0, 'the fix is a cut');
  assert(cut?.kind === 'insertParam' && cut.value >= -4, 'and it is capped at 4 dB');
  eq(diagnose(session, analysis).find((f) => f.id === 'mud'), undefined, 'a flat mix is not muddy');
});

check('a silent track is reported without a fix', () => {
  const { session, ids } = sessionWith(['Gtr']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Gtr', { silent: true, integratedLufs: -Infinity }),
  ]);
  const findings = diagnose(session, analysis);
  const finding = findings.find((f) => f.id.startsWith('silent:'));
  assert(!!finding, 'found');
  eq(finding!.actions.length, 0, 'nothing to apply');
  assert(!!finding!.manual, 'says what to check');
  // A silent track produces exactly one finding, not a cascade.
  eq(findings.filter((f) => f.trackId === ids[0]).length, 1, 'and only one');
});

check('findings are ordered by severity, and the fixable ones are separable', () => {
  const { session, analysis } = cleanMix();
  const bad: MixAnalysis = {
    ...analysis,
    master: { ...analysis.master, truePeakDbtp: 1, integratedLufs: -20, correlation: -0.4 },
  };
  const findings = diagnose(session, bad);
  const ranks = findings.map((f) => f.severity);
  const order = { critical: 0, warning: 1, info: 2 } as const;
  for (let i = 1; i < ranks.length; i++) {
    assert(order[ranks[i - 1] as Finding['severity']] <= order[ranks[i] as Finding['severity']],
      'sorted by severity');
  }
  assert(fixable(findings).length < findings.length, 'not everything has a fix');
  for (const f of fixable(findings)) assert(f.actions.length > 0, 'and the fixable ones do');
});

// ── AI Mix ────────────────────────────────────────────────────────────────────

check('balance moves a buried vocal up and a loud pad down', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Lead Vox', 'Pad']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { integratedLufs: -24 }),
    trackAnalysis(ids[1]!, 'Pad', { integratedLufs: -14 }),
  ]);
  const suggestions = balanceSuggestions(session, analysis);
  const vox = suggestions.find((s) => s.title.startsWith('Lead Vox'));
  const pad = suggestions.find((s) => s.title.startsWith('Pad'));
  assert(!!vox && !!pad, 'both moved');

  const applied = applySuggestions(session, suggestions);
  assert((findTrack(applied, ids[0]!)?.volumeDb ?? 0) > 0, 'the vocal came up');
  assert((findTrack(applied, ids[1]!)?.volumeDb ?? 0) < 0, 'the pad went down');
  assert(vox!.reason.includes('LUFS'), 'and says which measurement drove it');
});

check('balance never moves further than its cap', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Lead Vox', 'Pad']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { integratedLufs: -60 }),
    trackAnalysis(ids[1]!, 'Pad', { integratedLufs: -6 }),
  ]);
  const applied = applySuggestions(session, balanceSuggestions(session, analysis, { maxMoveDb: 6 }));
  for (const id of ids) {
    assert(Math.abs(findTrack(applied, id)?.volumeDb ?? 0) <= 6, 'capped at 6 dB');
  }
  // A capped move is a move the estimate does not fully back.
  const capped = balanceSuggestions(session, analysis, { maxMoveDb: 6 })[0];
  assert((capped?.confidence ?? 1) < 0.7, 'and it says it is less sure');
});

check('balance leaves tracks it cannot identify alone', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Audio 3', 'Audio 4']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Audio 3', { integratedLufs: -40, guess: guessRole('Audio 3', 'audio') }),
    trackAnalysis(ids[1]!, 'Audio 4', { integratedLufs: -8, guess: guessRole('Audio 4', 'audio') }),
  ]);
  eq(balanceSuggestions(session, analysis).length, 0, 'no guesses on unnamed tracks');
});

check('masking finds the fight and cuts the loser', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Lead Vox', 'Pad']);
  const shared = curve([{ hz: 1000, db: 10 }]);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { spectrum: shared }),
    trackAnalysis(ids[1]!, 'Pad', { spectrum: shared }),
  ]);
  const overlaps = findMasking(analysis);
  assert(overlaps.length > 0, 'a fight was found');
  assert(Math.abs((overlaps[0]?.hz ?? 0) - 1000) < 300, `centred near 1 kHz, got ${overlaps[0]?.hz}`);

  const suggestions = maskingSuggestions(session, analysis);
  eq(suggestions.length, 1, 'one cut');
  assert(suggestions[0]!.title.startsWith('Pad'), 'the pad loses to the vocal');

  const applied = applySuggestions(session, suggestions);
  const eq3 = findTrack(applied, ids[1]!)?.inserts.find((i) => i.pluginId === 'eq3');
  assert(!!eq3, 'the pad got an EQ');
  assert((eq3!.params['midDb'] ?? 0) < 0, 'with a cut');
  assert((eq3!.params['midDb'] ?? 0) >= -4, 'capped at 4 dB');
  eq(findTrack(applied, ids[0]!)?.inserts.length, 0, 'and the vocal was left alone');
});

check('masking cuts a track once, not once per fight', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Lead Vox', 'Kick', 'Pad']);
  const shared = curve([{ hz: 800, db: 10 }]);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { spectrum: shared }),
    trackAnalysis(ids[1]!, 'Kick', { spectrum: shared }),
    trackAnalysis(ids[2]!, 'Pad', { spectrum: shared }),
  ]);
  const suggestions = maskingSuggestions(session, analysis);
  const targets = suggestions.map((s) => s.title.split(' ')[0]);
  eq(new Set(targets).size, targets.length, 'one cut per track — a second would overwrite the first');
});

check('panning spreads duplicated roles and never moves a kick', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Gtr L', 'Gtr R', 'Kick']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Gtr L'),
    trackAnalysis(ids[1]!, 'Gtr R'),
    trackAnalysis(ids[2]!, 'Kick'),
  ]);
  const suggestions = panningSuggestions(session, analysis);
  eq(suggestions.length, 2, 'both guitars, not the kick');
  const applied = applySuggestions(session, suggestions);
  const left = findTrack(applied, ids[0]!)?.pan ?? 0;
  const right = findTrack(applied, ids[1]!)?.pan ?? 0;
  assert(left * right < 0, 'they went to opposite sides');
  close(findTrack(applied, ids[2]!)?.pan ?? -1, 0, 'the kick stayed centred', 1e-9);
});

check('autoMix orders by confidence and every suggestion can be described', () => {
  resetSuggestionIds();
  const { session, ids } = sessionWith(['Lead Vox', 'Pad']);
  const analysis = mixAnalysis([
    trackAnalysis(ids[0]!, 'Lead Vox', { integratedLufs: -24, spectrum: curve([{ hz: 1000, db: 10 }]) }),
    trackAnalysis(ids[1]!, 'Pad', { integratedLufs: -14, spectrum: curve([{ hz: 1000, db: 10 }]) }),
  ]);
  const suggestions = autoMix(session, analysis);
  assert(suggestions.length >= 2, 'more than one move');
  for (let i = 1; i < suggestions.length; i++) {
    assert((suggestions[i - 1]?.confidence ?? 0) >= (suggestions[i]?.confidence ?? 0), 'sorted');
  }
  for (const s of suggestions) {
    assert(s.reason.length > 0, 'has a reason');
    assert(describeSuggestion(session, s).length > 0, 'and describes its actions');
  }
});

// ── AI Master ─────────────────────────────────────────────────────────────────

check('master profiles are complete and findable', () => {
  for (const profile of MASTER_PROFILES) {
    assert(profile.lufs < 0 && profile.ceilingDbtp <= 0, `${profile.id} has sane targets`);
    assert(profile.note.length > 0, `${profile.id} explains itself`);
    eq(findProfile(profile.id)?.id, profile.id, 'findable');
  }
  eq(findProfile('reference' as never), undefined, 'reference is not a preset');
});

check('a reference beats a preset as the target', () => {
  const preset = resolveTarget({ target: 'club' });
  eq(preset.lufs, -8, 'the club preset');
  const measured = resolveTarget({
    target: 'reference',
    reference: referenceAnalysis({ integratedLufs: -9.3, truePeakDbtp: -0.9, dr: 8, widthPercent: 118 }),
  });
  close(measured.lufs, -9.3, 'the reference’s own loudness', 1e-9);
  close(measured.widthPercent, 118, 'and its own width', 1e-9);
  assert(measured.ceilingDbtp <= -0.3, 'the ceiling never goes above −0.3 dBTP');
});

check('auto-master always ends in a limiter, and only adds what is needed', () => {
  resetMasterIds();
  const { session } = sessionWith(['Vox']);
  const analysis = mixAnalysis([], { integratedLufs: -20, dr: 11, widthPercent: 95 });
  const suggestions = autoMaster(session, analysis, { target: 'streaming' });

  const limiter = suggestions.find((s) => s.id.includes('limit'));
  assert(!!limiter, 'a limiter is always proposed');
  eq(suggestions[suggestions.length - 1]?.id, limiter!.id, 'and it comes last');
  // Dynamics and width already match the target, so nothing is proposed for them.
  eq(suggestions.find((s) => s.id.includes('comp')), undefined, 'no needless compressor');
  eq(suggestions.find((s) => s.id.includes('width')), undefined, 'no needless widener');
});

check('auto-master compresses only a mix that is more dynamic than the target', () => {
  resetMasterIds();
  const { session } = sessionWith(['Vox']);
  const dynamic = autoMaster(session, mixAnalysis([], { dr: 20 }), { target: 'club' });
  assert(!!dynamic.find((s) => s.id.includes('comp')), 'a 20 dB PLR against a 7 dB target compresses');
  const squashed = autoMaster(session, mixAnalysis([], { dr: 6 }), { target: 'streaming' });
  eq(squashed.find((s) => s.id.includes('comp')), undefined, 'an already-flat mix is left alone');
});

check('auto-master builds the chain in the order that works', () => {
  resetMasterIds();
  const { session } = sessionWith(['Vox']);
  const analysis = mixAnalysis([], { integratedLufs: -22, dr: 18, widthPercent: 40 });
  const suggestions = autoMaster(session, analysis, {
    target: 'reference',
    reference: referenceAnalysis({ spectrum: curve([{ hz: 80, db: 6 }]), widthPercent: 100 }),
  });
  const applied = applySuggestions(session, suggestions);
  const master = applied.tracks.find((t) => t.kind === 'master');
  const order = (master?.inserts ?? []).slice().sort((a, b) => a.slot - b.slot).map((i) => i.pluginId);
  const positionOf = (id: string): number => order.indexOf(id);
  assert(positionOf('eq3') < positionOf('comp'), 'EQ before the compressor');
  assert(positionOf('comp') < positionOf('widener'), 'compressor before the widener');
  assert(positionOf('limiter') === order.length - 1, 'the limiter is last');
});

// ── Reference intelligence ────────────────────────────────────────────────────

check('a mix that already matches produces no suggestions', () => {
  resetMatchIds();
  const { session } = sessionWith(['Vox']);
  const analysis = referenceAnalysis();
  const comparison = compareToReference(analysis, { ...analysis, name: 'YOUR MIX' });
  const suggestions = matchActions(session, comparison);
  eq(suggestions.length, 0, 'nothing to close');
  assert(matchSummary(comparison, suggestions).includes('고칠 것이 없습니다'), 'and says so');
});

check('a dark, quiet mix gets tone and level moves in the right direction', () => {
  resetMatchIds();
  const { session } = sessionWith(['Vox']);
  const reference = referenceAnalysis({ integratedLufs: -9, highDb: 2, lowDb: 0 });
  const mix = referenceAnalysis({
    name: 'YOUR MIX', integratedLufs: -16, highDb: -4, lowDb: 3, truePeakDbtp: -4,
  });
  const comparison = compareToReference(reference, mix);
  const suggestions = matchActions(session, comparison);
  const applied = applySuggestions(session, suggestions);
  const master = applied.tracks.find((t) => t.kind === 'master');
  const eq3 = master?.inserts.find((i) => i.pluginId === 'eq3');

  assert(!!eq3, 'an EQ was placed');
  assert((eq3!.params['highDb'] ?? 0) > 0, 'highs come up — the mix was darker');
  assert((eq3!.params['lowDb'] ?? 0) < 0, 'lows come down — the mix had more');
  assert((master?.volumeDb ?? 0) > 0, 'and the master comes up toward the reference');
});

check('reference matching is capped so a bad reference cannot wreck a mix', () => {
  resetMatchIds();
  const { session } = sessionWith(['Vox']);
  const reference = referenceAnalysis({ integratedLufs: -4, highDb: 20, lowDb: -20 });
  const mix = referenceAnalysis({ name: 'YOUR MIX', integratedLufs: -30, highDb: -20, lowDb: 20 });
  const applied = applySuggestions(session, matchActions(session, compareToReference(reference, mix), {
    maxEqDb: 4, maxGainDb: 9,
  }));
  const master = applied.tracks.find((t) => t.kind === 'master');
  const eq3 = master?.inserts.find((i) => i.pluginId === 'eq3');
  assert(Math.abs(eq3?.params['highDb'] ?? 0) <= 4, 'EQ capped');
  assert(Math.abs(eq3?.params['lowDb'] ?? 0) <= 4, 'EQ capped both ways');
  assert(Math.abs(master?.volumeDb ?? 0) <= 9, 'gain capped');
});

check('toneOnly leaves the loudness alone', () => {
  resetMatchIds();
  const { session } = sessionWith(['Vox']);
  const reference = referenceAnalysis({ integratedLufs: -8, highDb: 3 });
  const mix = referenceAnalysis({ name: 'YOUR MIX', integratedLufs: -18, highDb: -3 });
  const suggestions = matchActions(session, compareToReference(reference, mix), { toneOnly: true });
  const applied = applySuggestions(session, suggestions);
  close(applied.tracks.find((t) => t.kind === 'master')?.volumeDb ?? -1, 0, 'the fader did not move', 1e-9);
  assert(suggestions.some((s) => s.title.includes('톤')), 'but the tone did');
});

// ── Auto automation ───────────────────────────────────────────────────────────

/** A signal whose level steps up halfway through. */
function stepped(sampleRate: number, seconds: number, quietDb: number, loudDb: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const half = out.length / 2;
  for (let i = 0; i < out.length; i++) {
    const amp = Math.pow(10, (i < half ? quietDb : loudDb) / 20);
    out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  return out;
}

check('the ride curve pushes the quiet half up and the loud half down', () => {
  const sampleRate = 8000;
  const envelope = levelEnvelope(stepped(sampleRate, 8, -30, -12), sampleRate, 0.4);
  const points = rideCurve(envelope, { maxMoveDb: 6, maxSlewDbPerSec: 20 });
  assert(points.length >= 2, 'a curve was produced');

  const at = (t: number): number => {
    let value = 0;
    for (const p of points) { if (p.timeSec <= t) value = p.value; }
    return value;
  };
  assert(at(3) > 1, `the quiet half is lifted, got ${at(3).toFixed(2)} dB`);
  assert(at(7) < -1, `the loud half is pulled down, got ${at(7).toFixed(2)} dB`);
  for (const p of points) assert(Math.abs(p.value) <= 6.001, `capped at 6 dB, saw ${p.value}`);
});

check('the ride is slew limited, so it rides phrases and not syllables', () => {
  const sampleRate = 8000;
  const envelope = levelEnvelope(stepped(sampleRate, 8, -40, -6), sampleRate, 0.2);
  const slow = rideCurve(envelope, { maxSlewDbPerSec: 2, toleranceDb: 0 });
  for (let i = 1; i < slow.length; i++) {
    const dt = (slow[i]?.timeSec ?? 0) - (slow[i - 1]?.timeSec ?? 0);
    const dv = Math.abs((slow[i]?.value ?? 0) - (slow[i - 1]?.value ?? 0));
    assert(dv <= 2 * dt + 1e-6, `moved ${dv.toFixed(2)} dB in ${dt.toFixed(3)} s`);
  }
});

check('a steady track needs no ride', () => {
  const sampleRate = 8000;
  const steady = new Float32Array(sampleRate * 4);
  for (let i = 0; i < steady.length; i++) steady[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  const points = rideCurve(levelEnvelope(steady, sampleRate));
  eq(rideSuggestion('t1', 'Vox', 0, points), null, 'nothing worth writing');
});

check('the ride suggestion writes absolute fader values', () => {
  const sampleRate = 8000;
  const envelope = levelEnvelope(stepped(sampleRate, 8, -30, -12), sampleRate, 0.4);
  const points = rideCurve(envelope, { maxMoveDb: 6, maxSlewDbPerSec: 20 });
  const suggestion = rideSuggestion('t1', 'Vox', -3, points);
  assert(!!suggestion, 'produced');
  const action = suggestion!.actions[0];
  assert(action?.kind === 'automation', 'writes automation');
  if (action?.kind === 'automation') {
    // The lane is the fader position, not an offset — the engine reads it as dB.
    const values = action.points.map((p) => p.value);
    assert(Math.min(...values) > -3 - 6.001 && Math.max(...values) < -3 + 6.001,
      'centred on the fader it was given');
  }
});

check('ducking dips at every trigger and recovers between them', () => {
  const points = duckCurve([1, 2, 3], 4, { depthDb: 6, attackSec: 0.01, releaseSec: 0.2 });
  const at = (t: number): number => {
    let value = 0;
    for (const p of points) { if (p.timeSec <= t) value = p.value; }
    return value;
  };
  close(at(0.5), 0, 'no duck before the first trigger', 1e-9);
  close(at(1), -6, 'down at the trigger', 1e-9);
  close(at(1.5), 0, 'and back up before the next', 1e-9);
  close(at(3.9), 0, 'recovered at the end', 1e-9);
});

check('a fast trigger train does not produce a curve that never recovers', () => {
  const triggers = Array.from({ length: 16 }, (_, i) => i * 0.125);
  const points = duckCurve(triggers, 2, { depthDb: 6, releaseSec: 0.5 });
  // The release is longer than the gap, so it must be cut short each time.
  for (let i = 1; i < points.length; i++) {
    assert((points[i]?.timeSec ?? 0) >= (points[i - 1]?.timeSec ?? 0), 'points stay in order');
  }
  const recovered = points.filter((p) => Math.abs(p.value) < 1e-9).length;
  assert(recovered >= 8, `the curve keeps coming back up, saw ${recovered} zero points`);
});

check('triggers too close together are treated as one', () => {
  const points = duckCurve([1, 1.01, 1.02, 2], 3, { minSpacingSec: 0.1 });
  const dips = points.filter((p) => p.value < 0).length;
  eq(dips, 2, 'a flam of triggers is one duck');
  eq(duckCurve([], 3).length, 0, 'no triggers, no curve');
  assert(duckSuggestion('t1', 'Bass', 'Kick', 0, points, 6) !== null, 'and it becomes a suggestion');
});

// ── Natural language ──────────────────────────────────────────────────────────

function nlSession(): { session: DawSession; ids: string[] } {
  return sessionWith(['Lead Vox', 'Kick', 'Pad']);
}

check('a plain level instruction is understood, in Korean', () => {
  const { session, ids } = nlSession();
  const result = interpret(session, '보컬 2dB 올려');
  eq(result.error, undefined, 'no error');
  eq(result.actions.length, 1, 'one action');
  const action = result.actions[0];
  assert(action?.kind === 'trackVolume', 'a fader move');
  if (action?.kind === 'trackVolume') {
    close(action.db, 2, 'by two dB', 1e-9);
    eq(action.trackId, ids[0], 'on the vocal');
  }
  assert(result.understood.includes('2.0 dB'), 'and it reads back the amount');
});

check('the same instruction works in English', () => {
  const { session, ids } = nlSession();
  const result = interpret(session, 'turn the kick down 3db');
  const action = result.actions[0];
  assert(action?.kind === 'trackVolume', 'a fader move');
  if (action?.kind === 'trackVolume') {
    close(action.db, -3, 'down three', 1e-9);
    eq(action.trackId, ids[1], 'on the kick');
  }
});

check('qualifiers scale the default move', () => {
  const { session } = nlSession();
  const little = interpret(session, '보컬 조금 올려').actions[0];
  const lot = interpret(session, '보컬 많이 올려').actions[0];
  assert(little?.kind === 'trackVolume' && lot?.kind === 'trackVolume', 'both are fader moves');
  if (little?.kind === 'trackVolume' && lot?.kind === 'trackVolume') {
    assert(lot.db > little.db, `"많이" moves further than "조금": ${little.db} vs ${lot.db}`);
  }
});

check('"앞으로" is more than one control, because that is what it means', () => {
  const { session } = nlSession();
  const result = interpret(session, '보컬 좀 더 앞으로');
  assert(result.actions.length >= 2, 'level and tone move together');
  assert(result.actions.some((a) => a.kind === 'trackVolume'), 'a little louder');
  assert(result.actions.some((a) => a.kind === 'macro' && a.macroId === 'clarity'), 'a little clearer');
  assert(result.understood.includes('앞으로'), 'and it says what it did');
});

check('a band word turns a level move into an EQ move', () => {
  const { session, ids } = nlSession();
  const result = interpret(session, '보컬 저역 좀 줄여');
  assert(result.actions.every((a) => a.kind === 'insertParam'), 'EQ, not the fader');
  const action = result.actions[0];
  if (action?.kind === 'insertParam') {
    eq(action.paramId, 'lowDb', 'the low band');
    assert(action.value < 0, 'cut');
    eq(action.trackId, ids[0], 'on the vocal');
  }
  assert(result.understood.includes('저역'), 'and it reads back the band');
});

check('an unknown instruction says so instead of guessing', () => {
  const { session } = nlSession();
  const nonsense = interpret(session, '음 그거 좀 그렇게 해줘');
  eq(nonsense.actions.length, 0, 'nothing applied');
  assert(!!nonsense.error, 'an error');
  assert(!!nonsense.hint, 'and an example of what would work');

  const noTrack = interpret(session, '트럼펫 올려');
  eq(noTrack.actions.length, 0, 'a missing track produces nothing');
  assert(!!noTrack.error, 'and says which part failed');
});

check('a track is found by its own name before any role word', () => {
  const { session, ids } = sessionWith(['Kick', 'Kick Sub']);
  const target = resolveNlTarget(session, 'Kick Sub 올려');
  eq(target?.track.id, ids[1], 'the longer exact name wins');
  assert(target?.how.includes('이름'), 'and it says it matched by name');
});

check('"여기" uses the focused track', () => {
  const { session, ids } = nlSession();
  const result = interpret(session, '여기 좀 밝게', ids[2]!);
  eq(result.actions.length, 1, 'one action');
  const action = result.actions[0];
  if (action?.kind === 'macro') {
    eq(action.trackId, ids[2], 'on the focused track');
    eq(action.macroId, 'clarity', 'clarity');
  }
  eq(interpret(session, '여기 좀 밝게', null).actions.length, 0, 'with nothing focused it declines');
});

check('the jazz request reaches the chord track, and refuses when it is empty', () => {
  const { session } = nlSession();
  const empty = interpret(session, '여기 코드 좀 재즈스럽게 바꿔');
  eq(empty.actions.length, 0, 'no chords, no reharmonisation');
  assert(empty.error?.includes('코드'), 'and it says why');

  const withChords = setChordTrack(session, [
    { id: 'c1', timeSec: 0, chord: makeChord(0, 'maj') },
    { id: 'c2', timeSec: 2, chord: makeChord(7, 'dom7') },
  ]);
  const result = interpret(withChords, '코드 재즈스럽게');
  eq(result.actions.length, 1, 'one action');
  eq(result.actions[0]?.kind, 'reharmonize', 'a reharmonisation');
  const applied = applyActions(withChords, result.actions);
  assert(applied.chordTrack.length >= 2, 'and it produced a progression');
});

check('nothing the parser produces is applied by the parser', () => {
  const { session } = nlSession();
  const before = JSON.stringify(session);
  interpret(session, '보컬 6dB 올려');
  interpret(session, '마스터 넓게');
  eq(JSON.stringify(session), before, 'interpret() is pure — the caller decides');
});

check('a keyword never fires from inside another word', () => {
  const { session } = nlSession();
  // "스" used to be a de-esser keyword and sits inside "재즈스럽게" — a
  // single-character keyword matches almost everything.
  const jazz = interpret(session, '코드 재즈스럽게 바꿔');
  assert(!jazz.actions.some((a) => a.kind === 'addInsert' && a.pluginId === 'deesser'),
    'the jazz request must not reach for a de-esser');

  // "up" sits inside "output"; Latin keywords are matched on word boundaries.
  const output = interpret(session, '보컬 output 확인');
  assert(!output.actions.some((a) => a.kind === 'trackVolume'),
    '"output" is not an instruction to turn anything up');

  // And the real words still work.
  const deess = interpret(session, '보컬 치찰음 잡아줘');
  assert(deess.actions.some((a) => a.kind === 'addInsert' && a.pluginId === 'deesser'),
    'the de-esser still responds to its own word');
  assert(interpret(session, 'vocal up 2db').actions.length > 0, 'and "up" on its own still works');
});

check('the vocabulary is reportable, for the help panel', () => {
  const vocab = vocabulary();
  assert(vocab.verbs.length > 8, 'verbs listed');
  assert(vocab.targets.length > 5, 'targets listed');
  eq(vocab.macros.length, 7, 'and the seven macros');
});

// ── Riff Machine ──────────────────────────────────────────────────────────────

const C_MAJOR: Scale = { root: 0, scaleId: 'major' };

function riff(over: Partial<RiffOptions> = {}): ReturnType<typeof generateRiff> {
  return generateRiff({
    bars: 4, tempoBpm: 120, beatsPerBar: 4, scale: C_MAJOR,
    lowPitch: 60, highPitch: 79, seed: 5, chromaticism: 0, ...over,
  });
}

/** Mean pitch of a slice of the phrase, for measuring shape. */
function meanPitch(notes: ReturnType<typeof generateRiff>, fromFraction: number, toFraction: number): number {
  const end = Math.max(...notes.map(noteEnd));
  const slice = notes.filter((n) => n.startSec >= end * fromFraction && n.startSec < end * toFraction);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, n) => sum + n.pitch, 0) / slice.length;
}

check('the contour shapes are what their names say', () => {
  close(contourAt('rise', 0), 0, 'rise starts low', 1e-9);
  close(contourAt('rise', 1), 1, 'and ends high', 1e-9);
  close(contourAt('fall', 0), 1, 'fall starts high', 1e-9);
  close(contourAt('arch', 0.5), 1, 'an arch peaks in the middle', 1e-9);
  close(contourAt('arch', 0), 0, 'and starts at the bottom', 1e-9);
  close(contourAt('valley', 0.5), 0, 'a valley bottoms out in the middle', 1e-9);
  close(contourAt('flat', 0.3), 0.5, 'flat is flat', 1e-9);
  for (const contour of CONTOURS) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = contourAt(contour, t);
      assert(v >= -1e-9 && v <= 1 + 1e-9, `${contour} stays in range at ${t}: ${v}`);
    }
    assert(contourLabel(contour).length > 0, `${contour} has a label`);
  }
});

check('the rhythm puts the bar line first and fills evenly', () => {
  const sparse = generateRhythm({
    ...DEFAULT_RIFF_FIXTURE, bars: 2, density: 0.12, syncopation: 0,
  });
  // 32 steps at density 0.12 is 4 notes — they must be the four downbeats,
  // not four random pokes.
  eq(sparse.length, 4, `four onsets, got ${sparse.length}`);
  eq(sparse.map((o) => o.step).join(','), '0,4,8,16', 'bar lines and beats first');
  for (const onset of sparse) assert(onset.weight >= 0.75, 'all on strong positions');

  const dense = generateRhythm({ ...DEFAULT_RIFF_FIXTURE, bars: 2, density: 1, syncopation: 0 });
  eq(dense.length, 32, 'full density fills the grid');
});

check('syncopation never moves the downbeat', () => {
  const syncopated = generateRhythm({
    ...DEFAULT_RIFF_FIXTURE, bars: 4, density: 0.6, syncopation: 1,
  });
  const stepsPerBar = 16;
  for (let bar = 0; bar < 4; bar++) {
    assert(syncopated.some((o) => o.step === bar * stepsPerBar),
      `bar ${bar + 1} keeps its one — a riff that loses it loses its shape`);
  }
  const straight = generateRhythm({
    ...DEFAULT_RIFF_FIXTURE, bars: 4, density: 0.6, syncopation: 0,
  });
  assert(syncopated.map((o) => o.step).join(',') !== straight.map((o) => o.step).join(','),
    'and syncopation does something');
});

check('every note lands in the requested range and scale', () => {
  const notes = riff({ lowPitch: 55, highPitch: 72 });
  assert(notes.length > 0, 'notes were produced');
  for (const note of notes) {
    assert(note.pitch >= 55 && note.pitch <= 72, `in range: ${note.pitch}`);
    assert(isInScale(note.pitch, C_MAJOR), `in key: ${note.pitch}`);
  }
});

check('strong beats take chord tones, which is what "on the chord" means', () => {
  const chords = [
    { id: 'c1', timeSec: 0, chord: makeChord(0, 'maj') },       // C
    { id: 'c2', timeSec: 2, chord: makeChord(5, 'maj') },       // F
    { id: 'c3', timeSec: 4, chord: makeChord(7, 'dom7') },      // G7
  ];
  const notes = riff({ bars: 3, chords, density: 0.7 });
  const beatSec = 0.5;

  let strong = 0;
  let onChord = 0;
  for (const note of notes) {
    const beats = note.startSec / beatSec;
    if (Math.abs(beats - Math.round(beats)) > 1e-6) continue;    // off the beat
    strong++;
    const chord = chordAt(chords, note.startSec);
    if (chord && chordPitchClasses(chord.chord).has(((note.pitch % 12) + 12) % 12)) onChord++;
  }
  assert(strong > 4, `there are strong beats to check, found ${strong}`);
  eq(onChord, strong, `every strong beat is a chord tone (${onChord}/${strong})`);
});

check('a rising contour actually rises, and a falling one falls', () => {
  const rising = riff({ contour: 'rise', bars: 4, density: 0.5 });
  assert(meanPitch(rising, 0.6, 1) > meanPitch(rising, 0, 0.4) + 3,
    `the line goes somewhere: ${meanPitch(rising, 0, 0.4).toFixed(1)} → ${meanPitch(rising, 0.6, 1).toFixed(1)}`);

  const falling = riff({ contour: 'fall', bars: 4, density: 0.5 });
  assert(meanPitch(falling, 0.6, 1) < meanPitch(falling, 0, 0.4) - 3, 'and back down when asked');

  const arch = riff({ contour: 'arch', bars: 4, density: 0.5 });
  const middle = meanPitch(arch, 0.35, 0.65);
  assert(middle > meanPitch(arch, 0, 0.2) && middle > meanPitch(arch, 0.8, 1),
    'an arch peaks in the middle');
});

check('the line is singable — mostly steps, no wild leaps', () => {
  const notes = riff({ bars: 4, density: 0.6, contour: 'wave' });
  const intervals: number[] = [];
  for (let i = 1; i < notes.length; i++) {
    intervals.push(Math.abs((notes[i]?.pitch ?? 0) - (notes[i - 1]?.pitch ?? 0)));
  }
  const steps = intervals.filter((v) => v <= 2).length;
  assert(steps / intervals.length > 0.4,
    `most motion is stepwise: ${((steps / intervals.length) * 100).toFixed(0)} %`);
  assert(Math.max(...intervals) <= 12, `nothing leaps more than an octave: ${Math.max(...intervals)}`);
});

check('a leap is answered by a step in the other direction', () => {
  const notes = riff({ bars: 8, density: 0.7, contour: 'wave', seed: 11 });
  let leaps = 0;
  let resolved = 0;
  for (let i = 1; i < notes.length - 1; i++) {
    const before = (notes[i]?.pitch ?? 0) - (notes[i - 1]?.pitch ?? 0);
    if (Math.abs(before) <= 4) continue;
    leaps++;
    const after = (notes[i + 1]?.pitch ?? 0) - (notes[i]?.pitch ?? 0);
    if (Math.sign(after) !== Math.sign(before) && Math.abs(after) <= 4) resolved++;
  }
  assert(leaps > 0, `the phrase contains leaps to resolve, found ${leaps}`);
  assert(resolved / leaps > 0.55,
    `most leaps resolve: ${resolved}/${leaps}`);
});

check('a riff is reproducible, and a different seed is a different riff', () => {
  const signature = (n: ReturnType<typeof generateRiff>): string =>
    n.map((x) => `${x.startSec.toFixed(4)}:${x.pitch}`).join(',');
  eq(signature(riff({ seed: 3 })), signature(riff({ seed: 3 })), 'the same seed is the same riff');
  assert(signature(riff({ seed: 3 })) !== signature(riff({ seed: 4 })), 'a different seed is not');
});

check('density controls how many notes there are', () => {
  const sparse = riff({ density: 0.2, bars: 4 }).length;
  const busy = riff({ density: 0.9, bars: 4 }).length;
  assert(busy > sparse * 2, `density does something: ${sparse} vs ${busy}`);
});

check('a bass line stays low and on the chord', () => {
  const chords = [{ id: 'c1', timeSec: 0, chord: makeChord(0, 'maj') }];
  const notes = riff({ style: 'bass', lowPitch: 33, highPitch: 52, chords, bars: 2 });
  assert(notes.length > 0, 'notes produced');
  const tones = chordPitchClasses(chords[0]!.chord);
  for (const note of notes) {
    assert(note.pitch >= 33 && note.pitch <= 52, `low register: ${note.pitch}`);
    assert(tones.has(((note.pitch % 12) + 12) % 12), `on the chord: ${note.pitch}`);
  }
});

check('the chord style stacks a voicing at each hit', () => {
  const chords = [{ id: 'c1', timeSec: 0, chord: makeChord(0, 'maj7') }];
  const notes = riff({ style: 'chords', chords, bars: 1, density: 0.25, lowPitch: 48, highPitch: 84 });
  const byTime = new Map<number, number>();
  for (const note of notes) byTime.set(note.startSec, (byTime.get(note.startSec) ?? 0) + 1);
  assert([...byTime.values()].every((count) => count >= 3), 'every hit is a chord, not a note');
  for (const style of RIFF_STYLES) assert(styleLabel(style).length > 0, `${style} has a label`);
});

check('with no chord track the riff still stays in the scale', () => {
  const notes = riff({ chords: [], bars: 2 });
  assert(notes.length > 0, 'notes produced');
  for (const note of notes) assert(isInScale(note.pitch, C_MAJOR), `in key: ${note.pitch}`);
  assert(describeRiff({ bars: 2 }, notes.length).includes('스케일만'), 'and it says it had no harmony');
});

check('chromaticism is the only thing that leaves the scale', () => {
  const strict = riff({ chromaticism: 0, bars: 4, density: 0.8 });
  eq(strict.filter((n) => !isInScale(n.pitch, C_MAJOR)).length, 0, 'none without it');
  const coloured = riff({ chromaticism: 0.9, bars: 4, density: 0.8, seed: 21 });
  assert(coloured.filter((n) => !isInScale(n.pitch, C_MAJOR)).length > 0, 'some with it');
});

// ── Variations ────────────────────────────────────────────────────────────────

check('inversion turns every rise into a fall', () => {
  const source = riff({ bars: 2, density: 0.6, contour: 'rise' });
  const inverted = varyRiff(source, { kind: 'invert', scale: C_MAJOR });
  eq(inverted.length, source.length, 'same number of notes');
  for (let i = 1; i < source.length; i++) {
    const up = (source[i]?.pitch ?? 0) - (source[i - 1]?.pitch ?? 0);
    const flipped = (inverted[i]?.pitch ?? 0) - (inverted[i - 1]?.pitch ?? 0);
    if (up !== 0) assert(Math.sign(flipped) !== Math.sign(up) || flipped === 0,
      `interval ${up} became ${flipped}`);
  }
  for (const note of inverted) assert(isInScale(note.pitch, C_MAJOR), 'and it stays in key');
});

check('retrograde reverses the pitches and keeps the rhythm', () => {
  const source = riff({ bars: 2, density: 0.5 });
  const reversed = varyRiff(source, { kind: 'retrograde', scale: C_MAJOR });
  eq(reversed.map((n) => n.startSec).join(','), source.map((n) => n.startSec).join(','),
    'the rhythm is the riff’s identity — reversing it would make a different riff');
  eq(reversed.map((n) => n.pitch).join(','),
    source.map((n) => n.pitch).reverse().join(','), 'the pitches run backwards');
});

check('transposition moves by scale degrees, not semitones', () => {
  const source = riff({ bars: 2, density: 0.5 });
  const up = varyRiff(source, { kind: 'transpose', scale: C_MAJOR, degrees: 2, highPitch: 96 });
  for (const note of up) assert(isInScale(note.pitch, C_MAJOR), `still in key: ${note.pitch}`);
  // Two scale degrees up from C major is a third — 3 or 4 semitones, never a
  // fixed interval, which is exactly the point.
  const intervals = up.map((n, i) => n.pitch - (source[i]?.pitch ?? 0));
  assert(intervals.every((v) => v >= 3 && v <= 4), `thirds, not a constant: ${[...new Set(intervals)]}`);
  assert(new Set(intervals).size > 1, 'and the interval varies with the degree — that is diatonic');
});

check('displacement, thinning and densifying do what they say', () => {
  const source = riff({ bars: 2, density: 0.6 });
  const moved = varyRiff(source, { kind: 'displace', scale: C_MAJOR, shiftSec: 0.125 });
  close((moved[0]?.startSec ?? 0) - (source[0]?.startSec ?? 0), 0.125, 'shifted', 1e-9);

  const thin = varyRiff(source, { kind: 'thin', scale: C_MAJOR, seed: 3 });
  assert(thin.length <= source.length, 'thinning removes notes');

  const dense = varyRiff(source, { kind: 'densify', scale: C_MAJOR, seed: 3 });
  assert(dense.length >= source.length, 'densifying adds them');
  for (const note of dense) assert(isInScale(note.pitch, C_MAJOR), 'and stays in key');

  for (const kind of VARIATIONS) assert(variationLabel(kind).length > 0, `${kind} has a label`);
  eq(varyRiff([], { kind: 'invert', scale: C_MAJOR }).length, 0, 'an empty riff varies to nothing');
});

check('nextScalePitch walks the scale, not the chromatic ladder', () => {
  eq(nextScalePitch(60, C_MAJOR, 1), 62, 'C to D');
  eq(nextScalePitch(64, C_MAJOR, 1), 65, 'E to F is a semitone — that is the scale');
  eq(nextScalePitch(60, C_MAJOR, -1), 59, 'C down to B');
});

// ── As an intelligence feature ────────────────────────────────────────────────

function riffSession(): { session: DawSession; trackId: string; clipId: string } {
  resetIds();
  let session = createSession('riff test');
  const track = createTrack('Keys', 'instrument');
  session = addTrack(session, track);
  const part = createMidiPart('Verse', { startSec: 4, durationSec: 4 });
  session = updateClips(session, track.id, () => [part]);
  session = setChords(session, [
    { id: 'k1', timeSec: 0, chord: makeChord(0, 'maj') },        // before the part
    { id: 'k2', timeSec: 6, chord: makeChord(5, 'maj') },        // inside it
  ]);
  return { session, trackId: track.id, clipId: part.id };
}

check('chords are carried into the part\'s own clock, including the one already sounding', () => {
  const { session, trackId, clipId } = riffSession();
  const track = findTrack(session, trackId)!;
  const clip = trackClips(track)[0]!;
  const chords = chordsForClip(session, clip);

  eq(chords.length, 2, 'both chords');
  close(chords[0]?.timeSec ?? -1, 0, 'the one already sounding is carried in at zero', 1e-9);
  close(chords[1]?.timeSec ?? -1, 2, 'and the one inside is shifted by the part start', 1e-9);
});

check('a riff arrives as a suggestion, unticked, and fills the part', () => {
  resetRiffIds();
  const { session, trackId, clipId } = riffSession();
  const result = riffSuggestion(session, { trackId, clipId, options: { seed: 9 } });
  assert(!!result.suggestion, result.reason);
  const suggestion = result.suggestion!;

  // A generator is a starting point, never an answer.
  assert(suggestion.confidence < 0.5, 'it arrives unticked');
  assert(suggestion.reason.includes('C') || suggestion.reason.includes('코드'), 'it names the harmony');

  const applied = applySuggestions(session, [suggestion]);
  const clip = trackClips(findTrack(applied, trackId)!)[0]!;
  const notes = clipNotes(applied, clip);
  assert(notes.length > 0, 'notes landed');
  // The riff fills the part, and the part still covers the riff.
  const last = Math.max(...notes.map(noteEnd));
  assert(last <= clip.durationSec + 1e-6, `nothing hangs off the end: ${last} vs ${clip.durationSec}`);
});

check('generating into a part that has notes can add instead of replace', () => {
  resetRiffIds();
  const { session, trackId, clipId } = riffSession();
  const seeded = applyActions(session, [{
    kind: 'writeNotes', trackId, clipId, notes: [createNote({ pitch: 48, startSec: 0 })],
  }]);
  eq(clipNotes(seeded, trackClips(findTrack(seeded, trackId)!)[0]!).length, 1, 'one note to start');

  const replaced = riffSuggestion(seeded, { trackId, clipId, options: { seed: 2 } });
  const afterReplace = applySuggestions(seeded, [replaced.suggestion!]);
  assert(!clipNotes(afterReplace, trackClips(findTrack(afterReplace, trackId)!)[0]!)
    .some((n) => n.pitch === 48 && n.startSec === 0), 'replace wipes what was there');

  const added = riffSuggestion(seeded, { trackId, clipId, options: { seed: 2 }, add: true });
  const afterAdd = applySuggestions(seeded, [added.suggestion!]);
  assert(clipNotes(afterAdd, trackClips(findTrack(afterAdd, trackId)!)[0]!)
    .some((n) => n.pitch === 48), 'add keeps it');
});

check('a variation needs something to vary, and says so', () => {
  resetRiffIds();
  const { session, trackId, clipId } = riffSession();
  const empty = variationSuggestion(session, { trackId, clipId, kind: 'invert', options: {} });
  eq(empty.suggestion, null, 'nothing to vary');
  assert(empty.reason.includes('리프'), 'and it says to generate one first');

  const withRiff = applySuggestions(
    session, [riffSuggestion(session, { trackId, clipId, options: { seed: 4 } }).suggestion!]);
  const varied = variationSuggestion(withRiff, { trackId, clipId, kind: 'retrograde', options: {} });
  assert(!!varied.suggestion, varied.reason);
  assert(varied.suggestion!.title.includes('역행'), 'and it names the variation');
});

check('a riff written through a pattern link changes every placement', () => {
  resetRiffIds();
  const { session, trackId, clipId } = riffSession();
  const captured = captureAsPattern(session, trackId, clipId, 'Riff', 120)!;
  const placed = updateClips(captured.session, trackId, (clips) => [
    ...clips,
    { ...clips[0]!, id: 'clip-2', startSec: 12 },
  ]);

  const result = riffSuggestion(placed, { trackId, clipId, options: { seed: 6 } });
  const applied = applySuggestions(placed, [result.suggestion!]);
  const clips = trackClips(findTrack(applied, trackId)!);
  eq(clips.length, 2, 'two placements');
  const first = clipNotes(applied, clips[0]!).length;
  const second = clipNotes(applied, clips[1]!).length;
  assert(first > 0, 'notes were written');
  eq(first, second, 'and both placements play them — one copy of the phrase');
});

check('a MIDI part is required, and an audio clip is refused', () => {
  resetRiffIds();
  const { session, trackId } = riffSession();
  const missing = riffSuggestion(session, { trackId, clipId: 'nope', options: {} });
  eq(missing.suggestion, null, 'no part, no riff');
  assert(missing.reason.includes('MIDI'), 'and it says what is needed');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Intelligence Layer ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
