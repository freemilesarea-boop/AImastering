// Setting up the model — the small, boring half of the feature.
//
// It is separate from nl-assistant.ts because the two have different
// audiences.  `ask` is called on every instruction and must work with no key,
// no Electron and no network.  This file is only ever touched by the settings
// row, and every function in it is allowed to fail loudly.
//
// The key never comes BACK across this bridge.  There is a set and a clear and
// a "do you have one", and deliberately no getter: a renderer that cannot read
// the key cannot leak it, and no feature needs to.

interface ElectronInvoke { invoke(channel: string, ...args: unknown[]): Promise<unknown> }

const api = (): ElectronInvoke | null =>
  (globalThis as { electronAPI?: ElectronInvoke }).electronAPI ?? null;

export interface AssistantStatus {
  ok: boolean;
  reason?: string;
  model?: string;
  /**
   * False when the OS could not encrypt the key, so it is held for this run
   * only.  Surfaced rather than hidden — "왜 또 물어보지" deserves an answer.
   */
  persisted?: boolean;
  encryptionAvailable?: boolean;
}

export async function assistantStatus(): Promise<AssistantStatus> {
  const bridge = api();
  if (!bridge) return { ok: false, reason: '데스크톱 앱에서만 쓸 수 있습니다' };
  try {
    const raw = await bridge.invoke('assistant:status');
    if (typeof raw === 'object' && raw !== null && 'ok' in raw) return raw as AssistantStatus;
    return { ok: false, reason: '상태를 확인하지 못했습니다' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '상태를 확인하지 못했습니다' };
  }
}

export async function setAssistantKey(key: string): Promise<AssistantStatus> {
  const bridge = api();
  if (!bridge) return { ok: false, reason: '데스크톱 앱에서만 쓸 수 있습니다' };
  try {
    const raw = await bridge.invoke('assistant:set-key', key);
    return { ...(raw as AssistantStatus) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '키를 저장하지 못했습니다' };
  }
}

export async function clearAssistantKey(): Promise<void> {
  await api()?.invoke('assistant:clear-key').catch(() => undefined);
}
