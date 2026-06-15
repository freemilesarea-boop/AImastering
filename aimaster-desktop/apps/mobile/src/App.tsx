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
  setApiConfig,
  isNative,
  pickAudioFile,
  analyze,
  startMaster,
  pollMaster,
  downloadPlayable,
  saveOrShare,
  type PickedAudio,
  type MasterOptions,
} from './mobileApi';

// ── Flow model ──────────────────────────────────────────────────────────────
type StepKey = 'settings' | 'pick' | 'analyze' | 'master' | 'result';

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'settings', label: '서버' },
  { key: 'pick', label: '파일' },
  { key: 'analyze', label: '분석' },
  { key: 'master', label: '마스터' },
  { key: 'result', label: '결과' },
];

// Sub-state of the mastering run, so we can reassure the user during long uploads.
type RunPhase = 'idle' | 'uploading' | 'processing' | 'downloading' | 'done' | 'error';

const STYLES = ['balanced', 'warm', 'bright', 'kpop_loud', 'club'];

interface PlayableResult {
  url: string;
  blob: Blob;
}

export default function App() {
  // step / navigation
  const [step, setStep] = useState<StepKey>('settings');

  // 1) server settings (env is the source of truth; fields allow runtime override)
  const [apiUrl, setApiUrl] = useState(ENV_API_URL);
  const [apiKey, setApiKey] = useState(ENV_API_KEY);
  useEffect(() => {
    setApiConfig(apiUrl, apiKey);
  }, [apiUrl, apiKey]);

  // 2) file
  const [file, setFile] = useState<PickedAudio | null>(null);

  // 3) analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);
  const [analyzeError, setAnalyzeError] = useState('');
  const [showRawAnalysis, setShowRawAnalysis] = useState(false);

  // 4) mastering options + run
  const [style, setStyle] = useState('balanced');
  const [targetLufs, setTargetLufs] = useState(-14);
  const [targetTp, setTargetTp] = useState(-1);

  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [masterError, setMasterError] = useState('');

  // 5) result
  const [master, setMaster] = useState<PlayableResult | null>(null);
  const [preview, setPreview] = useState<PlayableResult | null>(null);
  const [shareError, setShareError] = useState('');

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
  const busy = analyzing || runPhase === 'uploading' || runPhase === 'processing' || runPhase === 'downloading';

  // ── actions ────────────────────────────────────────────────────────────────
  async function onPick() {
    try {
      const picked = await pickAudioFile();
      if (!picked) return;
      setFile(picked);
      // reset downstream state for the new file
      setAnalysis(null);
      setAnalyzeError('');
      setMaster(null);
      setPreview(null);
      setRunPhase('idle');
    } catch (e) {
      setAnalyzeError(msg(e));
    }
  }

  async function onAnalyze() {
    if (!file) return;
    setAnalyzing(true);
    setAnalyzeError('');
    try {
      const a = await analyze(file);
      setAnalysis(a);
    } catch (e) {
      setAnalyzeError(msg(e));
    } finally {
      setAnalyzing(false);
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
    setStage('');
    setElapsed(0);
    setRunPhase('uploading');

    const options: MasterOptions = { style, targetLufs, targetTp, applyAiCorrections: true };

    try {
      const jobId = await startMaster(file, options); // upload happens here
      if (stale()) return;
      setRunPhase('processing');

      const final = await pollMaster(jobId, (p, s) => {
        if (!stale()) {
          setPercent(p);
          setStage(s);
        }
      });
      if (stale()) return;
      if (final.status === 'error') throw new Error(final.error || '서버 마스터링 실패');

      setRunPhase('downloading');
      const m = await downloadPlayable(jobId, 'master');
      if (stale()) return;
      let p: PlayableResult | null = null;
      try {
        p = await downloadPlayable(jobId, 'preview');
      } catch {
        /* preview optional */
      }
      if (stale()) return;

      setMaster(m);
      setPreview(p);
      setRunPhase('done');
      setStep('result');
    } catch (e) {
      if (stale()) return;
      setMasterError(msg(e));
      setRunPhase('error');
    }
  }

  function cancelRun() {
    runRef.current++; // invalidate the in-flight run; stale guards stop UI updates
    setRunPhase('idle');
  }

  async function onShare(which: 'master' | 'preview') {
    const r = which === 'master' ? master : preview;
    if (!r) return;
    setShareError('');
    try {
      const ext = which === 'master' ? 'wav' : 'mp3';
      const base = (file?.name || 'audio').replace(/\.[^.]+$/, '');
      await saveOrShare(r.blob, `${base}_${which}.${ext}`);
    } catch (e) {
      setShareError(msg(e));
    }
  }

  function restart() {
    runRef.current++;
    setFile(null);
    setAnalysis(null);
    setAnalyzeError('');
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

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-row">
          <h1>Loui Mastering</h1>
          <span className="badge">{isNative() ? 'Android' : 'Web'} · test</span>
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

        {step === 'pick' && <PickStep file={file} onPick={onPick} />}

        {step === 'analyze' && (
          <AnalyzeStep
            file={file}
            analyzing={analyzing}
            analysis={analysis}
            error={analyzeError}
            onAnalyze={onAnalyze}
            showRaw={showRawAnalysis}
            toggleRaw={() => setShowRawAnalysis((v) => !v)}
          />
        )}

        {step === 'master' && (
          <MasterStep
            file={file}
            style={style}
            setStyle={setStyle}
            targetLufs={targetLufs}
            setTargetLufs={setTargetLufs}
            targetTp={targetTp}
            setTargetTp={setTargetTp}
            runPhase={runPhase}
            percent={percent}
            stage={stage}
            elapsed={elapsed}
            error={masterError}
            onMaster={onMaster}
            onCancel={cancelRun}
          />
        )}

        {step === 'result' && (
          <ResultStep
            master={master}
            preview={preview}
            shareError={shareError}
            onShare={onShare}
          />
        )}
      </main>

      <footer className="actionbar">
        <ActionBar
          step={step}
          busy={busy}
          urlLooksValid={urlLooksValid}
          hasFile={Boolean(file)}
          analyzing={analyzing}
          runPhase={runPhase}
          hasResult={Boolean(master)}
          goBack={() => goTo(STEPS[stepIndex - 1]?.key ?? 'settings')}
          next={(k) => setStep(k)}
          onMaster={onMaster}
          restart={restart}
        />
      </footer>
    </div>
  );
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
function PickStep({ file, onPick }: { file: PickedAudio | null; onPick: () => void }) {
  return (
    <section className="card">
      <h2>오디오 파일 선택</h2>
      <p className="hint">wav · mp3 · flac · m4a 등. 선택한 파일은 서버로 업로드되어 마스터링됩니다.</p>
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
    </section>
  );
}

// ── Step 3: Analyze ───────────────────────────────────────────────────────────
function AnalyzeStep(props: {
  file: PickedAudio | null;
  analyzing: boolean;
  analysis: Record<string, unknown> | null;
  error: string;
  onAnalyze: () => void;
  showRaw: boolean;
  toggleRaw: () => void;
}) {
  const { file, analyzing, analysis, error, onAnalyze, showRaw, toggleRaw } = props;
  const rows = analysis ? scalarRows(analysis) : [];
  return (
    <section className="card">
      <h2>분석 결과</h2>
      <p className="hint">서버가 원본을 분석합니다. 선택 사항이며, 바로 마스터링으로 넘어가도 됩니다.</p>

      <button className="btn ghost block" onClick={onAnalyze} disabled={!file || analyzing}>
        {analyzing ? '분석 중…' : analysis ? '다시 분석' : '분석 실행'}
      </button>

      {analyzing && <Spinner label="원본 분석 중…" />}

      {error && <ErrorBox message={error} onRetry={onAnalyze} retryLabel="분석 다시 시도" />}

      {analysis && !analyzing && (
        <>
          {rows.length > 0 && (
            <ul className="kv">
              {rows.map(([k, v]) => (
                <li key={k}>
                  <span className="k">{k}</span>
                  <span className="v">{v}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="link" onClick={toggleRaw}>
            {showRaw ? '원본 JSON 숨기기' : '원본 JSON 보기'}
          </button>
          {showRaw && <pre className="json">{JSON.stringify(analysis, null, 2)}</pre>}
        </>
      )}
    </section>
  );
}

// ── Step 4: Master ────────────────────────────────────────────────────────────
function MasterStep(props: {
  file: PickedAudio | null;
  style: string;
  setStyle: (v: string) => void;
  targetLufs: number;
  setTargetLufs: (v: number) => void;
  targetTp: number;
  setTargetTp: (v: number) => void;
  runPhase: RunPhase;
  percent: number;
  stage: string;
  elapsed: number;
  error: string;
  onMaster: () => void;
  onCancel: () => void;
}) {
  const {
    file, style, setStyle, targetLufs, setTargetLufs, targetTp, setTargetTp,
    runPhase, percent, stage, elapsed, error, onMaster, onCancel,
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
          {!file && <p className="inline-err">먼저 파일을 선택하세요.</p>}
        </>
      )}

      {running && (
        <div className="runpanel">
          {runPhase === 'uploading' && (
            <>
              <Spinner label="파일 업로드 중…" />
              <p className="hint center">큰 파일은 시간이 걸릴 수 있어요. 앱을 닫지 말고 기다려주세요.</p>
            </>
          )}
          {runPhase === 'processing' && (
            <>
              <div className="progress">
                <div className="bar" style={{ width: `${Math.max(percent, 3)}%` }} />
                <span className="ptext">
                  {percent}% · {stage || '처리 중'}
                </span>
              </div>
              <p className="hint center">서버에서 마스터링 중…</p>
            </>
          )}
          {runPhase === 'downloading' && <Spinner label="결과 내려받는 중…" />}
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
  shareError: string;
  onShare: (which: 'master' | 'preview') => void;
}) {
  const { master, preview, shareError, onShare } = props;
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
          <button className="btn block" onClick={() => onShare('master')}>
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
          <button className="btn ghost block" onClick={() => onShare('preview')}>
            프리뷰 저장 / 공유
          </button>
        </div>
      ) : (
        master && <p className="hint">프리뷰(MP3)는 제공되지 않았습니다.</p>
      )}

      {shareError && <ErrorBox message={shareError} />}
    </section>
  );
}

// ── Sticky action bar (per-step primary navigation) ───────────────────────────
function ActionBar(props: {
  step: StepKey;
  busy: boolean;
  urlLooksValid: boolean;
  hasFile: boolean;
  analyzing: boolean;
  runPhase: RunPhase;
  hasResult: boolean;
  goBack: () => void;
  next: (k: StepKey) => void;
  onMaster: () => void;
  restart: () => void;
}) {
  const { step, busy, urlLooksValid, hasFile, runPhase, hasResult, goBack, next, onMaster, restart } = props;
  const running = runPhase === 'uploading' || runPhase === 'processing' || runPhase === 'downloading';

  if (step === 'settings') {
    return (
      <button className="btn block" disabled={!urlLooksValid} onClick={() => next('pick')}>
        계속
      </button>
    );
  }
  if (step === 'pick') {
    return (
      <div className="bar-row">
        <button className="btn ghost" onClick={goBack}>
          뒤로
        </button>
        <button className="btn grow" disabled={!hasFile} onClick={() => next('analyze')}>
          다음
        </button>
      </div>
    );
  }
  if (step === 'analyze') {
    return (
      <div className="bar-row">
        <button className="btn ghost" onClick={goBack}>
          뒤로
        </button>
        <button className="btn grow" disabled={!hasFile} onClick={() => next('master')}>
          마스터링으로
        </button>
      </div>
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

// ── helpers ───────────────────────────────────────────────────────────────────
function msg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // WebView/browser network failures surface as terse strings ("Failed to
  // fetch" etc.) — translate to something actionable during on-device QA.
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(raw)) {
    return '서버에 연결할 수 없습니다. 서버 주소·네트워크 상태, 그리고 서버 CORS/HTTPS 설정을 확인하세요.';
  }
  return raw;
}

// Top-level primitive fields of the analysis dict → label/value rows.
function scalarRows(obj: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) continue;
    if (typeof v === 'number') out.push([k, Number.isInteger(v) ? String(v) : v.toFixed(2)]);
    else if (typeof v === 'string' || typeof v === 'boolean') out.push([k, String(v)]);
  }
  return out;
}
