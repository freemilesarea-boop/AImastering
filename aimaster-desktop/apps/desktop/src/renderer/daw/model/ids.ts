// Deterministic id generation.
//
// crypto.randomUUID would work, but a monotonic counter keeps selftests
// readable ("clip-3" instead of a UUID) and makes session diffs stable.

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Test hook — restarts numbering so expectations stay stable. */
export function resetIds(): void { counter = 0; }
