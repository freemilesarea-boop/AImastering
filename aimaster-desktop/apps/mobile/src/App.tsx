// App — stepped mobile test flow (M3).
//
// Five screens, driven by a small state machine, with a sticky stepper header
// and a sticky bottom action bar (thumb-reachable). Each screen owns its
// primary action and its own error + retry. The flow:
//   1) 서버 설정   2) 파일 선택   3) 분석 결과   4) 마스터링(실행+진행률)
//   5) 결과(미리듣기 + 저장/공유)
//
// Self-contained on purpose: it talks ONLY to the mobileApi adapter + native
// plugins. No desktop guided components are imported (that is M3+ / later), and
// no payment / license / account / iOS code lives here.

import { useEffect, useRef, useState } from 'react';
import {
  ENV_API_URL,
  ENV_API_KEY,
  RELEASE_BUILD,
  hasServerConfig,
  setApiConfig,
  isNative,
  pickAudioFile,
  startMaster,
  pollMaster,
  downloadPlayable,
  saveToDownloads,
  shareFile,
  reportError,
  JobInterruptedError,
  CancelledError,
  type PickedAudio,
  type MasterOptions,
  type ErrorContext,
  type RetrySignal,
} from './mobileApi';

// User-facing copy: never expose raw technical errors; the detail is auto-filed.
const GENERIC_ERR =
  '처리 중 오류가 발생했습니다. 오류 내용은 자동으로 접수되었습니다. 잠시 후 다시 시도해 주세요.';
// Shown when the server restarted mid-job (e.g. OOM) and lost the job.
const INTERRUPTED_ERR =
  '서버 작업이 중단되어 자동으로 접수되었습니다. 잠시 후 다시 시도해 주세요.';

// Report the error and return a user-safe message (generic + receipt number).
async function toUserError(step: string, e: unknown, ctx?: ErrorContext): Promise<string> {
  const receipt = await reportError(step, e, ctx);
  const base = e instanceof JobInterruptedError ? INTERRUPTED_ERR : GENERIC_ERR;
  return receipt ? `${base}\n오류 접수번호: ${receipt}` : base;
}

// ── Flow model ──────────────────────────────────────────────────────────────
type StepKey = 'settings' | 'pick' | 'master' | 'result';

// Release builds drop the "서버" settings step entirely (env-injected server).
const ALL_STEPS: { key: StepKey; label: string }[] = [
  { key: 'settings', label: '서버' },
  { key: 'pick', label: '파일' },
  { key: 'master', label: '마스터' },
  { key: 'result', label: '결과' },
];
const STEPS = RELEASE_BUILD ? ALL_STEPS.filter((s) => s.key !== 'settings') : ALL_STEPS;
const FIRST_STEP: StepKey = STEPS[0].key; // 'pick' in release, 'settings' in test

// Sub-state of the mastering run, so we can reassure the user during long uploads.
type RunPhase = 'idle' | 'uploading' | 'processing' | 'downloading' | 'done' | 'error';

const STYLES = ['balanced', 'warm', 'bright', 'kpop_loud', 'club'];

interface PlayableResult {
  url: string;
  blob: Blob;
}

export default function App() {
  // step / navigation
  const [step, setStep] = useState<StepKey>(FIRST_STEP);

  // 1) server settings (env is the source of truth; fields allow runtime override)
  const [apiUrl, setApiUrl] = useState(ENV_API_URL);
  const [apiKey, setApiKey] = useState(ENV_API_KEY);
  useEffect(() => {
    setApiConfig(apiUrl, apiKey);
  }, [apiUrl, apiKey]);

  // 2) file
  const [file, setFile] = useState<PickedAudio | null>(null);
  const [pickError, setPickError] = useState('');

  // mastering options + run
  const [style, setStyle] = useState('balanced');
  const [targetLufs, setTargetLufs] = useState(-14);
  const [targetTp, setTargetTp] = useState(-1);
  const [fastMode, setFastMode] = useState(true); // test app default: fast

  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  const [retrying, setRetrying] = useState(false); // auto-retry in progress
  const [percent, setPercent] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [masterError, setMasterError] = useState('');

  // 5) result
  const [master, setMaster] = useState<PlayableResult | null>(null);
  const [preview, setPreview] = useState<PlayableResult | null>(null);
  // save/share action sheet target + last action result message
  const [sheetFor, setSheetFor] = useState<'master' | 'preview' | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // run-id guard: lets the user cancel an in-flight run (we ignore stale results)
  const runRef = useRef(0);

  // elapsed timer while a run is active
  useEffect(() => {
    if (runPhase !== 'uploading' && runPhase !== 'processing' && runPhase !== 'downloading') {
      return;
    }
    const t0 = Date.now() - elapsed * 1000;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPhase]);

  const effectiveUrl = (apiUrl || ENV_API_URL).replace(/\/+$/, '');
  const urlLooksValid = /^https?:\/\/.+/i.test(effectiveUrl);
  const busy = runPhase === 'uploading' || runPhase === 'processing' || runPhase === 'downloading';

  // ── actions ────────────────────────────────────────────────────────────────
  async function onPick() {
    try {
      setPickError('');
      const picked = await pickAudioFile();
      if (!picked) return;
      setFile(picked);
      // reset downstream state for the new file
      setMaster(null);
      setPreview(null);
      setRunPhase('idle');
    } catch (e) {
      setPickError(await toUserError('select', e, { file }));
    }
  }

  async function onMaster() {
    if (!file) return;
    const myRun = ++runRef.current;
    const stale = () => runRef.current !== myRun;

    setMasterError('');
    setMaster(null);
    setPreview(null);
    setPercent(0);
    setElapsed(0);
    setRunPhase('uploading');

    const options: MasterOptions = {
      style,
      targetLufs,
      targetTp,
      // Fast mode = server preconverts the input to stereo PCM up front (handles
      // 6ch/EAC3, marginal speed). AI corrections stay on (no speed cost).
      mode: fastMode ? 'fast' : 'quality',
    };

    // Auto-retry transient failures; only surface a red error on final failure.
    setRetrying(false);
    const sig: RetrySignal = {
      cancelled: stale,
      onRetry: () => {
        if (!stale()) setRetrying(true);
      },
    };

    let step = 'master';
    let jobId = '';
    try {
      jobId = await startMaster(file, options, sig); // upload happens here
      if (stale()) return;
      setRunPhase('processing');

      step = 'poll';
      const final = await pollMaster(jobId, (p) => {
        if (!stale()) {
          setPercent(p);
          setRetrying(false); // a successful poll means the server responded
        }
      }, {}, sig);
      if (stale()) return;
      if (final.status === 'error') throw new Error(final.error || 'server mastering failed');

      step = 'download';
      setRunPhase('downloading');
      const m = await downloadPlayable(jobId, 'master', sig);
      if (stale()) return;
      let p: PlayableResult | null = null;
      try {
        p = await downloadPlayable(jobId, 'preview', sig);
      } catch {
        /* preview optional */
      }
      if (stale()) return;

      setRetrying(false);
      setMaster(m);
      setPreview(p);
      setRunPhase('done');
      setStep('result');
    } catch (e) {
      if (stale() || e instanceof CancelledError) return; // cancelled → no error UI
      setRetrying(false);
      // Final failure only: one error report + user-friendly message.
      setMasterError(await toUserError(step, e, { file, jobId }));
      setRunPhase('error');
    }
  }

  function cancelRun() {
    runRef.current++; // invalidate the in-flight run; stale guards stop UI updates
    setRetrying(false);
    setRunPhase('idle');
  }

  function openSheet(which: 'master' | 'preview') {
    setActionMsg(null);
    setSheetFor(which);
  }

  function fileNameFor(which: 'master' | 'preview'): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const base = safeBaseName(file?.name || 'audio');
    return which === 'master' ? `${base}_Mastering_${ymd}.wav` : `${base}_Preview_${ymd}.mp3`;
  }

  async function doSave() {
    const which = sheetFor;
    setSheetFor(null);
    if (!which) return;
    const r = which === 'master' ? master : preview;
    if (!r) return;
    try {
      const where = await saveToDownloads(r.blob, fileNameFor(which));
      setActionMsg({ ok: true, text: `저장 완료: ${where}` });
    } catch (e) {
      setActionMsg({ ok: false, text: await toUserError('save', e, { file }) });
    }
  }

  async function doShare() {
    const which = sheetFor;
    setSheetFor(null);
    if (!which) return;
    const r = which === 'master' ? master : preview;
    if (!r) return;
    try {
      const title = which === 'master' ? 'Loui 마스터 (WAV)' : 'Loui 프리뷰 (MP3)';
      await shareFile(r.blob, fileNameFor(which), title);
    } catch (e) {
      setActionMsg({ ok: false, text: await toUserError('share', e, { file }) });
    }
  }

  function restart() {
    runRef.current++;
    setFile(null);
    setPickError('');
    setMaster(null);
    setPreview(null);
    setMasterError('');
    setRunPhase('idle');
    setStep('pick');
  }

  // ── navigation helpers ───────────────────────────────────────────────────────
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  function goTo(key: StepKey) {
    const target = STEPS.findIndex((s) => s.key === key);
    if (target <= stepIndex && !busy) setStep(key); // only jump back, and not mid-run
  }

  // Release build with no server injected → a self-contained config-error screen
  // (never exposes the env/key). Test/dev builds guide the user to the settings.
  if (RELEASE_BUILD && !hasServerConfig()) {
    return (
      <div className="app">
        <header className="hdr">
          <div className="hdr-row">
            <h1>Loui Mastering</h1>
          </div>
        </header>
        <main className="content">
          <section className="card">
            <div className="notice error">
              <strong>앱 설정 오류가 발생했습니다.</strong>
              <p>고객센터에 문의해 주세요.</p>
            </div>
          </section>
        </main>
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-row">
          <h1>Loui Mastering</h1>
          <span className="badge">{isNative() ? 'Android' : 'Web'} · {RELEASE_BUILD ? 'release' : 'test'}</span>
        </div>
        <Stepper current={stepIndex} onJump={goTo} />
      </header>

      <main className="content">
        {step === 'settings' && (
          <SettingsStep
            apiUrl={apiUrl}
            apiKey={apiKey}
            setApiUrl={setApiUrl}
            setApiKey={setApiKey}
            envConfigured={Boolean(ENV_API_URL)}
            envKeySet={Boolean(ENV_API_KEY)}
            effectiveUrl={effectiveUrl}
            urlLooksValid={urlLooksValid}
          />
        )}

        {step === 'pick' && <PickStep file={file} onPick={onPick} error={pickError} />}

        {step === 'master' && (
          <MasterStep
            file={file}
            style={style}
            setStyle={setStyle}
            targetLufs={targetLufs}
            setTargetLufs={setTargetLufs}
            targetTp={targetTp}
            setTargetTp={setTargetTp}
            fastMode={fastMode}
            setFastMode={setFastMode}
            runPhase={runPhase}
            percent={percent}
            elapsed={elapsed}
            retrying={retrying}
            error={masterError}
            onMaster={onMaster}
            onCancel={cancelRun}
          />
        )}

        {step === 'result' && (
          <ResultStep
            master={master}
            preview={preview}
            actionMsg={actionMsg}
            onOpenSheet={openSheet}
          />
        )}
      </main>

      <footer className="actionbar">
        <ActionBar
          step={step}
          busy={busy}
          urlLooksValid={urlLooksValid}
          hasFile={Boolean(file)}
          runPhase={runPhase}
          hasResult={Boolean(master)}
          canBack={stepIndex > 0}
          goBack={() => goTo(STEPS[stepIndex - 1]?.key ?? FIRST_STEP)}
          next={(k) => setStep(k)}
          onMaster={onMaster}
          restart={restart}
        />
      </footer>

      {sheetFor && (
        <ActionSheet
          title={sheetFor === 'master' ? '마스터 (WAV)' : '프리뷰 (MP3)'}
          onSave={doSave}
          onShare={doShare}
          onCancel={() => setSheetFor(null)}
        />
      )}
    </div>
  );
}

// Derive a safe file-name base from the user's original file name: strip the
// last extension, replace illegal chars (/ \ : * ? " < > |) with _, keep
// spaces, and truncate. e.g. "test.audio.final.wav" → "test.audio.final".
function safeBaseName(name: string): string {
  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name; // strip only the last extension
  base = base.replace(/[/\\:*?"<>|]/g, '_'); // illegal filename chars → _
  base = base.replace(/\s+/g, ' ').trim(); // collapse/trim whitespace (spaces kept)
  if (base.length > 80) base = base.slice(0, 80).trim();
  return base || 'audio';
}

// ── Stepper ─────────────────────────────────────────────────────────────────
function Stepper({ current, onJump }: { current: number; onJump: (k: StepKey) => void }) {
  return (
    <nav className="stepper" aria-label="진행 단계">
      {STEPS.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        return (
          <button
            key={s.key}
            className={`dot ${state}`}
            onClick={() => onJump(s.key)}
            disabled={i > current}
            aria-current={i === current}
          >
            <span className="num">{i < current ? '✓' : i + 1}</span>
            <span className="lbl">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ── Step 1: Settings ──────────────────────────────────────────────────────────
function SettingsStep(props: {
  apiUrl: string;
  apiKey: string;
  setApiUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  envConfigured: boolean;
  envKeySet: boolean;
  effectiveUrl: string;
  urlLooksValid: boolean;
}) {
  const { apiUrl, apiKey, setApiUrl, setApiKey, envConfigured, envKeySet, effectiveUrl, urlLooksValid } = props;
  return (
    <section className="card">
      <h2>서버 설정</h2>
      {envConfigured ? (
        <p className="hint">
          빌드 env에 서버가 설정되어 있습니다{envKeySet ? ' (API Key 포함).' : ' (Key 없음).'} 필요하면 아래에서 덮어쓸 수 있어요.
        </p>
      ) : (
        <div className="notice warn">
          <strong>서버 주소가 설정되지 않았습니다.</strong>
          <p>아래에 마스터링 API URL을 입력해야 분석/마스터링이 동작합니다. (예: Render 배포 주소)</p>
        </div>
      )}

      <label>API URL</label>
      <input
        value={apiUrl}
        onChange={(e) => setApiUrl(e.target.value)}
        placeholder="https://your-app.onrender.com"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {!urlLooksValid && apiUrl.length > 0 && (
        <p className="inline-err">http:// 또는 https:// 로 시작하는 올바른 주소를 입력하세요.</p>
      )}

      <label>API Key (X-API-Key, 선택)</label>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="서버에 키가 설정된 경우에만 입력"
        type="password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <p className="hint small">적용될 주소: {effectiveUrl || '(없음)'}</p>
    </section>
  );
}

// ── Step 2: Pick ──────────────────────────────────────────────────────────────
function PickStep({ file, onPick, error }: { file: PickedAudio | null; onPick: () => void; error: string }) {
  return (
    <section className="card">
      <h2>오디오 파일 선택</h2>
      <p className="hint">wav · mp3 · flac · m4a 등. 선택하면 바로 마스터링 단계로 진행합니다.</p>
      <button className="btn block" onClick={onPick}>
        {file ? '다른 파일 선택' : '파일 선택'}
      </button>
      {file ? (
        <div className="filecard">
          <div className="fileicon">♪</div>
          <div className="filemeta">
            <div className="fn">{file.name}</div>
            <div className="fd">
              {(file.size / 1024 / 1024).toFixed(2)} MB · {file.mimeType}
            </div>
          </div>
        </div>
      ) : (
        <p className="empty">아직 선택된 파일이 없습니다.</p>
      )}
      {error && <ErrorBox message={error} />}
    </section>
  );
}

// ── Step 3: Master ────────────────────────────────────────────────────────────
function MasterStep(props: {
  file: PickedAudio | null;
  style: string;
  setStyle: (v: string) => void;
  targetLufs: number;
  setTargetLufs: (v: number) => void;
  targetTp: number;
  setTargetTp: (v: number) => void;
  fastMode: boolean;
  setFastMode: (v: boolean) => void;
  runPhase: RunPhase;
  percent: number;
  elapsed: number;
  retrying: boolean;
  error: string;
  onMaster: () => void;
  onCancel: () => void;
}) {
  const {
    file, style, setStyle, targetLufs, setTargetLufs, targetTp, setTargetTp,
    fastMode, setFastMode, runPhase, percent, elapsed, retrying, error, onMaster, onCancel,
  } = props;

  const running = runPhase === 'uploading' || runPhase === 'processing' || runPhase === 'downloading';

  return (
    <section className="card">
      <h2>마스터링</h2>

      {!running && (
        <>
          <label>스타일</label>
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <div className="row">
            <div className="col">
              <label>목표 LUFS: {targetLufs}</label>
              <input
                type="range"
                min={-24}
                max={-6}
                step={0.5}
                value={targetLufs}
                onChange={(e) => setTargetLufs(Number(e.target.value))}
              />
            </div>
            <div className="col">
              <label>True Peak: {targetTp} dB</label>
              <input
                type="range"
                min={-3}
                max={0}
                step={0.1}
                value={targetTp}
                onChange={(e) => setTargetTp(Number(e.target.value))}
              />
            </div>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
            />
            <span>빠른 처리 (테스트) — 입력 사전변환(6ch/EAC3 호환)</span>
          </label>

          {!file && <p className="inline-err">먼저 파일을 선택하세요.</p>}
        </>
      )}

      {running && (
        <div className="runpanel">
          {runPhase === 'uploading' && (
            <>
              <Spinner label="업로드 중" />
              <p className="hint center">큰 파일은 시간이 걸릴 수 있어요. 앱을 닫지 말고 기다려주세요.</p>
            </>
          )}
          {runPhase === 'processing' && (
            <>
              <div className="progress">
                <div className="bar" style={{ width: `${Math.max(percent, 3)}%` }} />
                <span className="ptext">마스터링 중 {percent}%</span>
              </div>
              {elapsed >= 45 && (
                <p className="hint center">긴 곡(3분 이상)은 조금 오래 걸릴 수 있어요. 잠시만 기다려주세요.</p>
              )}
            </>
          )}
          {runPhase === 'downloading' && <Spinner label="결과 준비 중" />}
          {retrying && (
            <div className="notice warn">
              <strong>서버 응답이 지연되고 있어요. 자동으로 다시 확인 중입니다.</strong>
              <p>마스터링은 계속 진행 중일 수 있습니다. 잠시만 기다려 주세요.</p>
            </div>
          )}
          <p className="elapsed">경과 {elapsed}s</p>
          <button className="btn ghost block" onClick={onCancel}>
            취소
          </button>
        </div>
      )}

      {error && !running && (
        <ErrorBox message={error} onRetry={onMaster} retryLabel="마스터링 다시 시도" />
      )}
    </section>
  );
}

// ── Step 5: Result ────────────────────────────────────────────────────────────
function ResultStep(props: {
  master: PlayableResult | null;
  preview: PlayableResult | null;
  actionMsg: { ok: boolean; text: string } | null;
  onOpenSheet: (which: 'master' | 'preview') => void;
}) {
  const { master, preview, actionMsg, onOpenSheet } = props;
  return (
    <section className="card">
      <h2>결과</h2>
      {!master && <p className="empty">아직 결과가 없습니다.</p>}

      {master && (
        <div className="result-item">
          <div className="ri-head">
            <span className="ri-title">마스터 (WAV)</span>
            <span className="tag ok">완료</span>
          </div>
          <audio src={master.url} controls className="player" preload="metadata" />
          <button className="btn block" onClick={() => onOpenSheet('master')}>
            저장 / 공유
          </button>
        </div>
      )}

      {preview ? (
        <div className="result-item">
          <div className="ri-head">
            <span className="ri-title">프리뷰 (MP3)</span>
            <span className="tag">참고용</span>
          </div>
          <audio src={preview.url} controls className="player" preload="metadata" />
          <button className="btn ghost block" onClick={() => onOpenSheet('preview')}>
            프리뷰 저장 / 공유
          </button>
        </div>
      ) : (
        master && <p className="hint">빠른 처리에서는 마스터(WAV)만 제공됩니다.</p>
      )}

      {actionMsg &&
        (actionMsg.ok ? (
          <p className="save-ok">✓ {actionMsg.text}</p>
        ) : (
          <ErrorBox message={actionMsg.text} />
        ))}
    </section>
  );
}

// ── Sticky action bar (per-step primary navigation) ───────────────────────────
function ActionBar(props: {
  step: StepKey;
  busy: boolean;
  urlLooksValid: boolean;
  hasFile: boolean;
  runPhase: RunPhase;
  hasResult: boolean;
  canBack: boolean;
  goBack: () => void;
  next: (k: StepKey) => void;
  onMaster: () => void;
  restart: () => void;
}) {
  const { step, busy, urlLooksValid, hasFile, runPhase, hasResult, canBack, goBack, next, onMaster, restart } = props;
  const running = runPhase === 'uploading' || runPhase === 'processing' || runPhase === 'downloading';

  if (step === 'settings') {
    return (
      <button className="btn block" disabled={!urlLooksValid} onClick={() => next('pick')}>
        계속
      </button>
    );
  }
  if (step === 'pick') {
    // In release builds 'pick' is the first step → no back button.
    return canBack ? (
      <div className="bar-row">
        <button className="btn ghost" onClick={goBack}>
          뒤로
        </button>
        <button className="btn grow" disabled={!hasFile} onClick={() => next('master')}>
          마스터링으로
        </button>
      </div>
    ) : (
      <button className="btn block" disabled={!hasFile} onClick={() => next('master')}>
        마스터링으로
      </button>
    );
  }
  if (step === 'master') {
    return (
      <div className="bar-row">
        <button className="btn ghost" onClick={goBack} disabled={running}>
          뒤로
        </button>
        <button className="btn grow" disabled={!hasFile || busy} onClick={onMaster}>
          {running ? '진행 중…' : '마스터링 시작'}
        </button>
      </div>
    );
  }
  // result
  return (
    <div className="bar-row">
      <button className="btn ghost" onClick={goBack}>
        뒤로
      </button>
      <button className="btn grow" disabled={!hasResult} onClick={restart}>
        새 파일로 다시
      </button>
    </div>
  );
}

// ── Action sheet (custom bottom sheet — no extra Capacitor plugin) ────────────
function ActionSheet(props: {
  title: string;
  onSave: () => void;
  onShare: () => void;
  onCancel: () => void;
}) {
  const { title, onSave, onShare, onCancel } = props;
  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-title">{title}</div>
        <button className="sheet-item" onClick={onSave}>
          파일에 저장
        </button>
        <button className="sheet-item" onClick={onShare}>
          공유하기
        </button>
        <button className="sheet-item cancel" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

// ── Small shared UI ───────────────────────────────────────────────────────────
function Spinner({ label }: { label: string }) {
  return (
    <div className="spinner-row">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

function ErrorBox({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="notice error">
      <strong>문제가 발생했습니다</strong>
      <p>{message}</p>
      {onRetry && (
        <button className="btn block" onClick={onRetry}>
          {retryLabel || '다시 시도'}
        </button>
      )}
    </div>
  );
}

