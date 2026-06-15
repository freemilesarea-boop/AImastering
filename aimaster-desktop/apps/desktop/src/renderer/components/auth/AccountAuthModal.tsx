// AccountAuthModal (Phase A) — Supabase Auth login / signup / signed-in.
//
// Email/password + Google OAuth.  Phase A scope: account + session only; this
// modal does NOT show or change any paid-feature state.  Mobile-safe sizing
// (mirrors LicenseModal: width min(28rem,100vw-2rem), height-capped scroll).
import React, { useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';

export default function AccountAuthModal() {
  const { status, user, busy, error, modalOpen, setModalOpen, signIn, signUp, signInWithGoogle, signOut } =
    useAuthStore();

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (!modalOpen) return null;

  const signedIn = status === 'signed-in' && user;
  const unconfigured = status === 'unconfigured';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'login') void signIn(email.trim(), password);
    else void signUp(email.trim(), password);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
    >
      <div
        className="w-full max-w-md mx-4 max-h-[calc(100vh-2rem)] overflow-y-auto
                   rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl"
        role="dialog" aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">
            {signedIn ? '계정' : (mode === 'login' ? '로그인' : '회원가입')}
          </h2>
          <button onClick={() => setModalOpen(false)} aria-label="닫기"
                  className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {unconfigured ? (
            <p className="text-sm text-zinc-400 leading-relaxed">
              인증 서버가 아직 설정되지 않았습니다. (Phase A — 빌드 환경변수 미주입)
            </p>
          ) : signedIn ? (
            <div className="space-y-4">
              <div className="text-center py-2">
                <p className="text-sm text-zinc-300">로그인됨</p>
                <p className="mt-1 text-xs text-zinc-500 break-all">{user!.email}</p>
              </div>
              <button
                onClick={() => void signOut()}
                disabled={busy}
                className="w-full min-h-[48px] py-2.5 rounded-lg text-sm font-medium
                           bg-zinc-800 border border-zinc-700 text-zinc-200
                           hover:border-zinc-600 disabled:opacity-50"
              >
                {busy ? '처리 중…' : '로그아웃'}
              </button>
            </div>
          ) : (
            <>
              <form onSubmit={submit} className="space-y-3" noValidate>
                <label className="block text-xs text-zinc-400" htmlFor="auth-email">이메일</label>
                <input
                  id="auth-email" type="email" autoComplete="email" value={email}
                  onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                  className="w-full min-h-[48px] px-3 py-2.5 rounded-lg text-[16px] bg-zinc-800
                             border border-zinc-700 text-zinc-100 placeholder-zinc-600
                             outline-none focus:border-zinc-500"
                />
                <label className="block text-xs text-zinc-400" htmlFor="auth-pw">비밀번호</label>
                <input
                  id="auth-pw" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
                  className="w-full min-h-[48px] px-3 py-2.5 rounded-lg text-[16px] bg-zinc-800
                             border border-zinc-700 text-zinc-100 placeholder-zinc-600
                             outline-none focus:border-zinc-500"
                />

                {error && <p className="text-xs text-red-400 leading-snug break-words">{error}</p>}

                <button
                  type="submit" disabled={busy || !email || !password}
                  className="w-full min-h-[48px] py-2.5 rounded-lg text-[16px] font-semibold
                             bg-zinc-100 text-zinc-900 hover:bg-white
                             disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed"
                >
                  {busy ? '처리 중…' : (mode === 'login' ? '로그인' : '회원가입')}
                </button>
              </form>

              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-[11px] text-zinc-600">또는</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>

              <button
                onClick={() => void signInWithGoogle()} disabled={busy}
                className="w-full min-h-[48px] py-2.5 rounded-lg text-[15px] font-medium
                           bg-zinc-800 border border-zinc-700 text-zinc-200
                           hover:border-zinc-600 disabled:opacity-50"
              >
                Google로 계속
              </button>

              <p className="mt-4 text-center text-xs text-zinc-600">
                {mode === 'login' ? '계정이 없으신가요? ' : '이미 계정이 있으신가요? '}
                <button
                  type="button"
                  onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); }}
                  className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100"
                >
                  {mode === 'login' ? '회원가입' : '로그인'}
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
