/**
 * LicenseModal — license key activation dialog.
 *
 * UX principles:
 *   - Shows remaining free trials without being pushy
 *   - Key field auto-formats to AIMASTER-XXXX-XXXX-XXXX as user types
 *   - Clear, specific error messages from the backend
 *   - Success feedback before auto-close
 *   - Upgrade prompt is present but minimal; one action line only
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLicenseStore, selectRemainingTrials } from '../stores/licenseStore.js';

// ── Key formatter ─────────────────────────────────────────────────────────────

const PREFIX = 'AIMASTER-';

/** Reformat raw input into AIMASTER-XXXX-XXXX-XXXX (uppercase, dashes inserted). */
function formatKey(raw: string): string {
  // Strip everything that isn't alphanumeric or dash, uppercase
  const clean = raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');

  // If the user typed the prefix manually, use it; otherwise prepend
  const body = clean.startsWith(PREFIX) ? clean.slice(PREFIX.length) : clean;

  // Strip any dashes from the body, then re-insert them every 4 chars
  const digits = body.replace(/-/g, '').slice(0, 12); // max 12 chars: XXXXXXXXXXxx
  const parts: string[] = [];
  for (let i = 0; i < digits.length; i += 4) {
    parts.push(digits.slice(i, i + 4));
  }
  return PREFIX + parts.join('-');
}

function isComplete(key: string): boolean {
  return /^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
}

// ── TrialBadge ────────────────────────────────────────────────────────────────

function TrialBadge({ remaining, total }: { remaining: number; total: number }) {
  const used = total - remaining;
  const pct  = (used / total) * 100;

  const barColor =
    remaining === 0 ? 'bg-red-500'
    : remaining === 1 ? 'bg-amber-500'
    : 'bg-emerald-500';

  return (
    <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3 mb-5">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-zinc-400">무료 체험 사용 현황</span>
        <span className="text-xs font-medium text-zinc-200">
          {remaining === 0
            ? '횟수 소진'
            : `${remaining}회 남음 (총 ${total}회)`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {remaining === 0 && (
        <p className="mt-2 text-xs text-red-400">
          무료 체험 횟수를 모두 사용했습니다. 라이선스 키를 입력해 계속 사용하세요.
        </p>
      )}
    </div>
  );
}

// ── LicenseModal ──────────────────────────────────────────────────────────────

export default function LicenseModal() {
  const { licenseInfo, isLoading, error, showModal, setShowModal, activate } =
    useLicenseStore();
  const remaining = useLicenseStore(selectRemainingTrials);
  const total     = licenseInfo?.trialMax ?? 3;
  const isPro     = licenseInfo?.tier === 'pro';

  const [key, setKey]         = useState('');
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (showModal) {
      setKey('');
      setSuccess(false);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [showModal]);

  const handleKeyChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setKey(formatKey(e.target.value));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isComplete(key) || isLoading) return;
    try {
      await activate(key);
      setSuccess(true);
      // Auto-close after brief success display
      setTimeout(() => setShowModal(false), 1200);
    } catch {
      // Error is already in store; modal stays open
    }
  }, [key, isLoading, activate, setShowModal]);

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) setShowModal(false);
  }, [setShowModal]);

  if (!showModal) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Dialog — mobile-safe: width = min(28rem, 100vw−2rem), height capped
          to the viewport with internal scroll so nothing is clipped at 390px. */}
      <div
        className="w-full max-w-md mx-4 max-h-[calc(100vh-2rem)] overflow-y-auto
                   rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-zinc-800">
          <h2 id="license-modal-title" className="text-sm font-semibold text-zinc-100">
            {isPro ? '라이선스 정보' : '라이선스 활성화'}
          </h2>
          <button
            onClick={() => setShowModal(false)}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800
                       transition-colors"
            aria-label="닫기"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {isPro ? (
            // ── Pro user info ──────────────────────────────────────────────
            <div className="text-center py-4">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                              bg-emerald-500/10 border border-emerald-500/30 mb-3">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">활성화됨</span>
              </div>
              <p className="text-sm text-zinc-300">
                라이선스가 활성화되어 있습니다.
              </p>
              {licenseInfo?.key && (
                <p className="mt-1 text-xs text-zinc-500 font-mono">
                  {licenseInfo.key}
                </p>
              )}
            </div>
          ) : (
            // ── Free user activation form ──────────────────────────────────
            <>
              <TrialBadge remaining={remaining === Infinity ? 3 : remaining} total={total} />

              {success ? (
                <div className="text-center py-3">
                  <p className="text-sm text-emerald-400 font-medium">
                    라이선스가 활성화되었습니다 ✓
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate>
                  <label className="block text-xs text-zinc-400 mb-1.5" htmlFor="license-key-input">
                    라이선스 키
                  </label>
                  <input
                    ref={inputRef}
                    id="license-key-input"
                    type="text"
                    value={key}
                    onChange={handleKeyChange}
                    placeholder="AIMASTER-XXXX-XXXX-XXXX"
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={22}   // PREFIX(9) + 3×4 + 2 dashes = 22
                    className="w-full px-3 py-2.5 rounded-lg text-sm font-mono
                               bg-zinc-800 border border-zinc-700 text-zinc-100
                               placeholder-zinc-600 outline-none
                               focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500/50
                               transition-colors"
                  />

                  {/* Error */}
                  {error && (
                    <p className="mt-2 text-xs text-red-400 leading-snug">
                      {error}
                    </p>
                  )}

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={!isComplete(key) || isLoading}
                    className="mt-4 w-full py-2.5 rounded-lg text-sm font-medium
                               bg-zinc-100 text-zinc-900
                               disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed
                               hover:bg-white active:bg-zinc-200
                               transition-colors"
                  >
                    {isLoading ? '확인 중…' : '활성화'}
                  </button>
                </form>
              )}

              {/* Subtle upgrade CTA — one line, no pressure */}
              <p className="mt-4 text-center text-xs text-zinc-600">
                라이선스 키가 없으신가요?{' '}
                <a
                  href={__PADDLE_CHECKOUT_URL__}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200
                             transition-colors"
                >
                  구매하기
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
