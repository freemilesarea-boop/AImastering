// 공간계는 센드로 — the aux every guide says to use, built for you.
//
// `instrument-chains.ts` puts the reverb and the delay IN THE CHANNEL, and
// says why: every guide says to put them on an aux, that is correct, and it
// is also the step a beginner gets wrong, so the chain hands you something
// that works in the channel at a low mix.  That argument has not changed and
// the insert chain is still what the picker loads by default.
//
// This is the same chain for the person who has outgrown it, and the reason
// to grow out of it is not style:
//
//   · SIX PLATES.  Load the vocal chain on six backing takes and you get six
//     plate reverbs — six times the CPU, and six different rooms for one
//     stack of voices.  A mix sounds like one place because everything in it
//     is in one place, and one aux is how that happens.
//   · ONE KNOB.  "A bit less reverb on everything" is one fader on the aux
//     return, not six mix controls that have to be moved by the same amount
//     and will not be.
//
// ── Where the send level comes from ─────────────────────────────────────────
//
// It is NOT typed here.  The chain already answers "how wet is a vocal
// plate" — 20 % — and a number typed in this file would be a second answer to
// that question, one click away from the first.  Same rule as
// `chainDeviceParams`: the preset wins, this file only converts.
//
// An insert at mix m plays dry (1 − m) and wet m.  A send feeds a fully-wet
// aux that is summed with the UNCHANGED dry channel, so the send gain has to
// carry the same ratio:
//
//   wet / dry = m / (1 − m)   →   levelDb = 20·log10( m / (1 − m) )
//
// At the vocal plate's 20 % that is a quarter as much wet as dry, −12.0 dB,
// and the result sounds like the insert version did — which is the only sane
// place to start from.  Unity falls at 50 %, not at 20 %: a send is summed
// with the whole dry channel, not blended against it.  The conversion is
// rounded to the 0.5 dB the send slider steps in, so the stored value and the
// displayed value are the same number.
//
// ── The 100× trap ───────────────────────────────────────────────────────────
//
// `reverb.mix` and `delay.mix` run 0…1.  `pingpong.mix` and `tapedelay.mix`
// are also called `mix` and run 0…100.  Reading the fraction off the
// parameter NAME gets the synth chain's ping-pong wrong by a factor of 100 —
// 35 becomes 3500 % — so the fraction is normalised against the range the
// DESCRIPTOR declares, and a selftest loads both kinds to prove it.

import { findPlugin } from '../engine/plugins.js';
import { fullyWet } from '../edit/region-live.js';
import { loadRack } from './rack-preset.js';
import { nextBusName } from './buses.js';
import { detectFeedback } from './routing.js';
import {
  addTrack, createBus, createSend, createTrack, findTrack, setSend, updateTrack,
} from './session-ops.js';
import { rackFromChain, type ChainDevice, type InstrumentChain } from './instrument-chains.js';
import { SEND_SLOTS, type BusId, type DawSession, type Track, type TrackId } from './types.js';

/**
 * The categories that belong on a send.
 *
 * Derived from the plugin's own category rather than a list of ids, so a
 * reverb added to the build later is routed without this file being edited.
 * Today that is exactly the five reverbs and the three delays.
 */
const SEND_ROUTE_CATEGORIES: readonly string[] = ['reverb', 'delay'];

/**
 * Track kinds a chain's tail cannot be thrown from, and what to say.
 *
 * Audio, instrument and aux tracks are routable; the three below are not, and
 * the reason differs for each so the message does too.
 */
const REFUSED_KINDS: Partial<Record<Track['kind'], string>> = {
  master: '마스터 트랙의 공간계는 센드로 보낼 수 없습니다 — 리턴이 다시 마스터로 들어와 피드백이 됩니다',
  vca: 'VCA 는 오디오가 지나가지 않는 트랙입니다',
  folder: '폴더 트랙에는 인서트가 없습니다',
};

/** The send slider's range, which is also the range a derived level is held to. */
const SEND_LEVEL_MIN_DB = -60;
const SEND_LEVEL_MAX_DB = 12;
/** The step the slider moves in; a derived level lands on it. */
const SEND_LEVEL_STEP_DB = 0.5;

function isSendRoutable(pluginId: string): boolean {
  const descriptor = findPlugin(pluginId);
  return descriptor !== undefined && SEND_ROUTE_CATEGORIES.includes(descriptor.category);
}

/**
 * How much of this device's output is the effect, as a fraction.
 *
 * Normalised against the declared range — see the 100× trap above.  `null`
 * when the device has no mix control at all, which for a reverb or a delay
 * would mean the build changed under this file and the caller should leave
 * the device where it is rather than guess.
 */
function wetFraction(pluginId: string, params: Record<string, number>): number | null {
  const descriptor = findPlugin(pluginId);
  if (!descriptor) return null;
  const def = descriptor.params.find((p) => p.id === 'mix' || p.id === 'mixPct');
  if (!def) return null;
  const raw = params[def.id];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const span = def.max - def.min;
  if (span <= 0) return null;
  return Math.max(0, Math.min(1, (raw - def.min) / span));
}

/** The send gain that puts a fully-wet aux at the same wet/dry ratio. */
function sendLevelDbForWet(wet: number): number {
  if (wet <= 0) return SEND_LEVEL_MIN_DB;
  if (wet >= 1) return SEND_LEVEL_MAX_DB;
  const db = 20 * Math.log10(wet / (1 - wet));
  const stepped = Math.round(db / SEND_LEVEL_STEP_DB) * SEND_LEVEL_STEP_DB;
  return Math.max(SEND_LEVEL_MIN_DB, Math.min(SEND_LEVEL_MAX_DB, stepped));
}

export interface PlannedSend {
  /**
   * The chain's own entry, carried whole.
   *
   * Not a copy of its `pluginId` and `why`: a `ChainDevice` may also hold
   * `params`, which is what a chain with no instrument profile uses, and a
   * rebuilt device would silently drop them and put the aux's reverb on its
   * factory defaults.  Nothing has `profile: null` today, which is exactly
   * why a reconstruction here would have gone unnoticed.
   */
  device: ChainDevice;
  /** The device's own name, which is what the aux and its bus are called. */
  name: string;
  /** The fraction the insert chain would have used. */
  wet: number;
  levelDb: number;
}

export interface ChainSendPlan {
  /** What stays in the channel, in order, repacked from slot A. */
  inserts: readonly ChainDevice[];
  /** What leaves the channel for an aux. */
  sends: readonly PlannedSend[];
}

/**
 * Split a chain into what stays and what is thrown, without touching a
 * session.
 *
 * Pure, because two callers need it before anything is applied: the picker
 * tooltip, which has to say what the toggle is about to do, and
 * `loadChainWithSends`, which does it.
 */
export function chainSendPlan(chain: InstrumentChain): ChainSendPlan {
  const inserts: ChainDevice[] = [];
  const sends: PlannedSend[] = [];
  for (const device of chain.devices) {
    const descriptor = findPlugin(device.pluginId);
    const wet = descriptor ? wetFraction(device.pluginId, chainDeviceParamsOf(chain, device)) : null;
    // A device with no mix control cannot be converted to a ratio, so it is
    // left in the channel rather than thrown at a level nobody derived.
    if (!descriptor || !isSendRoutable(device.pluginId) || wet === null) {
      inserts.push(device);
      continue;
    }
    sends.push({ device, name: descriptor.name, wet, levelDb: sendLevelDbForWet(wet) });
  }
  return { inserts, sends };
}

/**
 * The chain's settings for one device.
 *
 * Imported through `rackFromChain` rather than called directly so there is
 * one path that answers "what does this device load with" — the rack this
 * builds is the same object `loadRack` is given, and reading the params off
 * it cannot drift away from what is actually loaded.
 */
function chainDeviceParamsOf(
  chain: InstrumentChain, device: ChainDevice,
): Record<string, number> {
  const rack = rackFromChain(chain, [device]);
  return rack.devices[0]?.params ?? {};
}

/**
 * The aux already carrying this device, if the session has one.
 *
 * Matched STRUCTURALLY — an aux fed by a bus, carrying exactly this one
 * device — rather than by a name or a marker this file wrote.  So loading the
 * vocal chain with sends on six tracks builds one plate aux and five sends to
 * it, and a plate aux the user built by hand is reused instead of being
 * duplicated next to itself.
 */
function findChainAux(
  session: DawSession, pluginId: string,
): { trackId: TrackId; busId: BusId } | null {
  for (const track of session.tracks) {
    if (track.kind !== 'aux' || track.input === null) continue;
    if (track.inserts.length !== 1) continue;
    const only = track.inserts[0];
    if (!only || only.pluginId !== pluginId) continue;
    if (!session.buses.some((b) => b.id === track.input)) continue;
    return { trackId: track.id, busId: track.input };
  }
  return null;
}

export interface ChainSendResult {
  session: DawSession;
  /** Every aux the chain now feeds, whether this call built it or found it. */
  auxTrackIds: readonly TrackId[];
  /** Device names, split by what actually happened, for the message. */
  created: readonly string[];
  reused: readonly string[];
  /** What could not be done, in the voice `loadRack` uses. */
  problems: readonly string[];
  message: string;
}

/**
 * Load the chain with its tail on auxes instead of in the channel.
 *
 * The insert half goes through `loadRack`, the same path the insert-only
 * picker and a saved rack use — so the slot rules, the parameter sanitising
 * and the report of anything this build cannot provide are not reimplemented
 * here.  The aux half goes through it too, one device at a time, and is then
 * pinned fully wet by `fullyWet` for the reason that function documents: a
 * send into a device at 25 % mix returns three quarters dry signal through a
 * second path, which is a comb filter rather than a reverb.
 */
export function loadChainWithSends(
  session: DawSession, trackId: TrackId, chain: InstrumentChain,
): ChainSendResult {
  const track = findTrack(session, trackId);
  if (!track) {
    return {
      session, auxTrackIds: [], created: [], reused: [],
      problems: ['트랙을 찾을 수 없습니다'], message: '트랙을 찾을 수 없습니다',
    };
  }
  // The master is the one that has to be refused rather than merely hidden.
  // Its picker is hidden in the mixer, but the insert rack opens on every row
  // the edit window lists and the master is one of them — and a reverb aux
  // fed FROM the master returns TO the master, which is a feedback loop that
  // builds itself the moment somebody presses play.  A VCA and a folder carry
  // no audio at all, so a chain on either is a chain on nothing.
  const refused = REFUSED_KINDS[track.kind];
  if (refused !== undefined) {
    return {
      session, auxTrackIds: [], created: [], reused: [],
      problems: [refused], message: refused,
    };
  }

  const plan = chainSendPlan(chain);
  const problems: string[] = [];

  // ── The channel ───────────────────────────────────────────────────────────
  let next = session;
  if (plan.inserts.length > 0) {
    const loaded = loadRack(next, trackId, rackFromChain(chain, plan.inserts), 'replace');
    next = loaded.session;
    problems.push(...loaded.problems);
  } else {
    // Nothing stays in the channel — an all-tail chain, which none of the
    // twelve is today.  The old inserts still have to go, or the chain would
    // be the previous track's chain plus some sends.
    next = updateTrack(next, trackId, (t) => ({ ...t, inserts: [] }));
  }

  // ── The auxes ─────────────────────────────────────────────────────────────
  const auxTrackIds: TrackId[] = [];
  const created: string[] = [];
  const reused: string[] = [];

  // Auxes land below the track in CHAIN order — delay then plate for a vocal,
  // the order the chain reads in — which means each new one goes one row
  // further down than the last rather than all of them at the same index.
  let placed = 0;

  for (const planned of plan.sends) {
    const existing = findChainAux(next, planned.device.pluginId);
    let busId: BusId;
    let auxId: TrackId;

    if (existing) {
      busId = existing.busId;
      auxId = existing.trackId;
      reused.push(planned.name);
    } else {
      const bus = createBus(freeBusName(next, planned.name));
      const aux = createTrack(planned.name, 'aux', { input: bus.id });
      next = addTrack({ ...next, buses: [...next.buses, bus] }, aux,
        indexAfter(next, trackId, placed));
      placed++;
      // Through loadRack so the aux's device is sanitised the same way the
      // channel's are, then pinned wet.
      const onAux = loadRack(next, aux.id, rackFromChain(chain, [planned.device]), 'replace');
      next = onAux.session;
      problems.push(...onAux.problems);
      next = updateTrack(next, aux.id, (t) => ({ ...t, inserts: t.inserts.map(fullyWet) }));
      busId = bus.id;
      auxId = aux.id;
      created.push(planned.name);
    }

    auxTrackIds.push(auxId);

    // ── The send ──────────────────────────────────────────────────────────
    // Post-fader, so pulling the channel down pulls its reverb down with it.
    const already = findTrack(next, trackId)?.sends.find((s) => s.target === busId);
    if (already) {
      // Pressing the toggle twice must not stack a second send to the same
      // aux; the level is re-derived instead, and an unrelated mute is lifted
      // because a send this call just asked for should be open.
      next = setSend(next, trackId, { ...already, levelDb: planned.levelDb, mute: false });
      continue;
    }
    const slot = firstFreeSendSlot(next, trackId);
    if (slot === null) {
      problems.push(`${planned.name} — 센드 슬롯이 모두 찼습니다`);
      continue;
    }
    const candidate = setSend(next, trackId, createSend(slot, busId, {
      levelDb: planned.levelDb, preFader: false,
    }));
    // Reusing an aux is reusing whatever it is already wired to, so the one
    // case this cannot assume away is an aux that feeds this track back.
    // Asked of `detectFeedback` rather than reasoned about here, so there is
    // one answer to "is this a loop" in the codebase.
    if (detectFeedback(candidate).length > 0) {
      problems.push(`${planned.name} — 이 Aux 로 보내면 피드백이 생깁니다`);
      continue;
    }
    next = candidate;
  }

  return {
    session: next,
    auxTrackIds,
    created,
    reused,
    problems,
    message: describe(chain, plan, created, reused),
  };
}

function describe(
  chain: InstrumentChain, plan: ChainSendPlan,
  created: readonly string[], reused: readonly string[],
): string {
  const head = `${chain.label} 기본 체인 — 인서트 ${plan.inserts
    .map((d) => findPlugin(d.pluginId)?.name ?? d.pluginId).join(' → ')}`;
  if (plan.sends.length === 0) return `${head} · 센드로 보낼 공간계가 없습니다`;
  const tail = plan.sends.map((s) => {
    const how = created.includes(s.name) ? '새 Aux' : reused.includes(s.name) ? 'Aux 공유' : '';
    return `${s.name} ${s.levelDb.toFixed(1)} dB${how ? ` (${how})` : ''}`;
  }).join(' · ');
  return `${head} · 센드 ${tail}`;
}

/** Right below the track it is a send from, so the pair reads as a pair. */
function indexAfter(
  session: DawSession, trackId: TrackId, offset: number,
): number | undefined {
  const at = session.tracks.findIndex((t) => t.id === trackId);
  return at === -1 ? undefined : at + 1 + offset;
}

/**
 * The device's name if no bus has it, else that name with a number.
 *
 * `nextBusName` always appends one, which would make the first plate aux
 * "Plate Reverb 1" and read like there are others.  A collision only happens
 * when a bus is already called this and no aux carrying the device was found
 * to reuse — a bus somebody renamed, or deleted the aux from.
 */
function freeBusName(session: DawSession, name: string): string {
  return session.buses.some((b) => b.name === name) ? nextBusName(session, name) : name;
}

function firstFreeSendSlot(session: DawSession, trackId: TrackId): number | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  for (let slot = 0; slot < SEND_SLOTS; slot++) {
    if (!track.sends.some((s) => s.slot === slot)) return slot;
  }
  return null;
}
