// Where the assistant's API key comes from, in order.
//
// Pulled out of `ipc/assistantHandlers.ts` so the order can be tested: that
// file imports `safeStorage` from electron, so none of this was reachable.
//
// The rules, and the one that was unreachable:
//
//   1. A key held for this session only, because the OS could not encrypt it.
//   2. The stored key, decrypted through the OS keychain.
//   3. `ANTHROPIC_API_KEY` from the environment.
//
// Rule 3 could not be reached whenever a stored key existed and the platform
// had no encryption — a machine whose keyring went away after a key was
// saved, which is the ordinary Linux case.  The old code returned `null`
// there and the app said "API 키가 설정되지 않았습니다" at a user who had
// just exported the variable to work around exactly that.  A stored key that
// cannot be decrypted is not a key; it must not shadow one that works.
//
// A key that decrypts to something that is not a key is also refused, so a
// corrupted entry reads as absent rather than being sent to the API.

/** The shape every Anthropic key has.  Also enforced when one is set. */
export const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export function looksLikeKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value.trim());
}

export type KeySource = 'session' | 'keychain' | 'env' | null;

export interface KeyInputs {
  /** Held in memory when the OS cannot encrypt. */
  sessionKey: string | null;
  /** What `electron-store` has, base64 of the encrypted bytes. */
  stored: unknown;
  canEncrypt: boolean;
  /** Throws, or returns a non-key, when the entry is not ours to read. */
  decrypt: (stored: string) => string;
  env: string | undefined;
}

export interface KeyResolution {
  key: string | null;
  source: KeySource;
  /** True when a stored entry exists that this machine cannot use. */
  storedUnusable: boolean;
}

export function resolveAssistantKey(inputs: KeyInputs): KeyResolution {
  if (looksLikeKey(inputs.sessionKey)) {
    return { key: inputs.sessionKey.trim(), source: 'session', storedUnusable: false };
  }

  const stored = typeof inputs.stored === 'string' && inputs.stored.length > 0
    ? inputs.stored
    : null;

  if (stored !== null && inputs.canEncrypt) {
    try {
      const plain = inputs.decrypt(stored);
      if (looksLikeKey(plain)) {
        return { key: plain.trim(), source: 'keychain', storedUnusable: false };
      }
    } catch {
      // A key encrypted on a different machine or under a different OS user.
      // The caller drops it: it can never be decrypted here again.
    }
    return envOr(inputs.env, true);
  }

  // No stored key, or one this platform cannot decrypt at all.
  return envOr(inputs.env, stored !== null);
}

function envOr(env: string | undefined, storedUnusable: boolean): KeyResolution {
  if (looksLikeKey(env)) return { key: env.trim(), source: 'env', storedUnusable };
  return { key: null, source: null, storedUnusable };
}
