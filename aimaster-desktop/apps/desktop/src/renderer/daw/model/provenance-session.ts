// The session's provenance record — read through here, never off the field.
//
// Sessions saved before provenance existed have none, so every reader goes
// through `provenanceOf`, which seeds one from what the session already
// knows.  That way an old project opened today still exports a file that
// says who made it, instead of one that says nothing.

import { emptyProvenance, withAiStep, type AiStep, type Provenance } from './provenance.js';
import type { DawSession } from './types.js';

/** The session's record, seeded from its name when it has none yet. */
export function provenanceOf(session: DawSession): Provenance {
  return session.provenance ?? emptyProvenance(session.name);
}

export function setProvenance(session: DawSession, provenance: Provenance): DawSession {
  return { ...session, provenance };
}

/**
 * Record something a machine did to this session.
 *
 * Called by the pipeline, not by a person: what the app did is not a claim
 * the user gets to edit, and a disclosure that can be quietly emptied is not
 * a disclosure.  Identical steps collapse, so running separation twice while
 * experimenting is still one fact about the track.
 */
export function recordAiStep(session: DawSession, step: AiStep): DawSession {
  const before = provenanceOf(session);
  const after = withAiStep(before, step);
  return after === before ? session : setProvenance(session, after);
}
