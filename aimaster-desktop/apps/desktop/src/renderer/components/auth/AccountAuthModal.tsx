// Entitlement display (Phase B) — READ-ONLY.  Shows the account's plan/status
// purely for visibility; it is NOT connected to the WAV-export gate.
function EntitlementRow() {
  const ent = useEntitlementStore((s) => s.entitlement);
  const status = useEntitlementStore((s) => s.status);
  if (status === 'loading' && !ent) {
    return <p className="text-center text-xs text-zinc-600">구독 상태 확인 중…</p>;
  }
  if (!ent) return null;
  return (
    <div className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-center">
      <p className="text-[11px] text-zinc-500 uppercase tracking-wider">구독 상태</p>
      <p className="mt-0.5 text-sm text-zinc-200">
        {ent.isPro ? `Pro · ${ent.plan}` : '무료'}{ent.status !== 'free' ? ` (${ent.status})` : ''}
      </p>
      {ent.expiresAt && (
        <p className="text-[11px] text-zinc-600 mt-0.5">만료 {new Date(ent.expiresAt).toLocaleDateString()}</p>
      )}
      <p className="text-[10px] text-zinc-700 mt-1">Phase B · Export 권한과 무관(표시 전용)</p>
    </div>
  );
}

// DevicesSection (Phase D2) — account device management (<=2 active).
// Shows registered devices, marks the current one, and revokes others.
function DevicesSection() {
  const devices = useDeviceStore((s) => s.devices);
  const currentId = useDeviceStore((s) => s.currentDeviceId);
  const deviceAllowed = useDeviceStore((s) => s.deviceAllowed);
  const lastCode = useDeviceStore((s) => s.lastCode);
  const revoke = useDeviceStore((s) => s.revoke);
  const list = useDeviceStore((s) => s.list);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => { void list(); }, [list]);

  const onRevoke = async (id: string) => {
    setBusyId(id);
    await revoke(id);
    setBusyId(null);
  };

  return (
    <div className="rounded-lg bg-zinc-800/60 border border-zinc-700 p-3 space-y-2">
      <p className="text-[11px] text-zinc-500 uppercase tracking-wider">기기 (최대 2대)</p>
      {!deviceAllowed && lastCode === 'device_limit_exceeded' && (
        <p className="text-xs text-amber-400 leading-snug break-words">
          기기 한도(2대)를 초과했습니다. 사용하지 않는 기기를 해제해 주세요.
        </p>
      )}
      {devices.length === 0 ? (
        <p className="text-xs text-zinc-600">등록된 기기가 없습니다.</p>
      ) : devices.map((d) => {
        const isCurrent = d.device_id === currentId;
        return (
          <div key={d.device_id} className="flex items-center gap-2 py-1">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200 truncate">
                {d.device_name || d.device_id.slice(0, 8)}
                {isCurrent && <span className="ml-1.5 text-[10px] text-emerald-400">(현재 기기)</span>}
              </p>
              <p className="text-[10px] text-zinc-600">
                {(d.platform ?? '').toString()} · {new Date(d.last_seen_at).toLocaleDateString()}
              </p>
            </div>
            {!isCurrent && (
              <button
                onClick={() => void onRevoke(d.device_id)}
                disabled={busyId === d.device_id}
                className="text-[12px] px-2.5 min-h-[36px] rounded-lg bg-zinc-700 text-zinc-200
                           hover:bg-zinc-600 disabled:opacity-50"
              >
                {busyId === d.device_id ? '…' : '해제'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ClaimSection (Phase D1) — link an existing license key to the account.
// Reuses the existing license key (server validates against license_keys);
// does NOT remove the key or change the license/export flow.
function ClaimSection() {
  const claim = useEntitlementStore((s) => s.claim);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const codeMessage = (code?: string): string => {
    switch (code) {
      case 'not_found':      return '존재하지 않는 라이선스 키입니다.';
      case 'already_claimed':return '이미 다른 계정에 연결된 키입니다.';
      case 'expired':        return '만료된 라이선스 키입니다.';
      case 'invalid_status': return '사용할 수 없는 키입니다 (환불/해제됨).';
      case 'unconfigured':   return '인증 서버가 설정되지 않았습니다.';
      default:               return '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true); setMsg(null);
    const r = await claim(key);
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: '라이선스가 계정에 연결되었습니다.' }); setKey(''); }
    else setMsg({ ok: false, text: codeMessage(r.code) });
  };

  return (
    <form onSubmit={submit} className="rounded-lg bg-zinc-800/60 border border-zinc-700 p-3 space-y-2">
      <p className="text-[11px] text-zinc-500 uppercase tracking-wider">기존 라이선스 연결</p>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value.toUpperCase())}
        placeholder="AIMASTER-XXXX-XXXX-XXXX"
        spellCheck={false} autoComplete="off" maxLength={22}
        className="w-full min-h-[44px] px-3 py-2 rounded-lg text-[15px] font-mono
                   bg-zinc-900 border border-zinc-700 text-zinc-100 placeholder-zinc-600
                   outline-none focus:border-zinc-500"
      />
      {msg && (
        <p className={`text-xs leading-snug break-words ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {msg.text}
        </p>
      )}
      <button
        type="submit" disabled={busy || !key.trim()}
        className="w-full min-h-[44px] py-2 rounded-lg text-[15px] font-medium
                   bg-zinc-700 text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
      >
        {busy ? '연결 중…' : '키 연결'}
      </button>
    </form>
  );
}

// AccountAuthModal (Phase A) — Supabase Auth login / signup / signed-in.
//
// Email/password + Google OAuth.  Phase A scope: account + session only; this
// modal does NOT show or change any paid-feature state.  Mobile-safe sizing
// (mirrors LicenseModal: width min(28rem,100vw-2rem), height-capped scroll).
import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useEntitlementStore } from '../../stores/entitlementStore.js';
import { useDeviceStore } from '../../stores/deviceStore.js';

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
              <EntitlementRow />
              <DevicesSection />
              <ClaimSection />
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
