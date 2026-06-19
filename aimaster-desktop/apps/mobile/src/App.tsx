// App — stepped mobile flow, now fully ON-DEVICE.
//
// Three screens, driven by a small state machine, with a sticky stepper header
// and a sticky bottom action bar (thumb-reachable):
//   1) 파일 선택   2) 마스터링(로컬 실행 + 진행률)   3) 결과(미리듣기 + 저장/공유)
//
// Mastering runs ENTIRELY on the device (localMobileMastering.ts via the Web
// Audio API) — no server, no upload, no job polling, no Render. This file talks
// only to the native bridge (mobileApi) + the local engine. No payment /
// license / account / iOS code lives here.

import { useEffect, useRef, useState } from 'react';
import {
  isNative,
  pickAudioFile,
  isAllowedAudio,
  saveToDownloads,
  shareFile,
  reportError,
  CancelledError,
  type PickedAudio,
  type ErrorContext,
} from './mobileApi';
import {
  runLocalMastering,
  LocalMasteringError,
  LARGE_FILE_BYTES,
  MAX_FILE_BYTES,
  type LocalMasterResult,
  type LocalSignal,
} from './localMobileMastering';

// User-facing copy: never expose raw technical errors.
const GENERIC_ERR = '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

// mac-shell = the macOS Electron wrapper (apps/mac-shell). It serves this SPA
// over the app:// scheme and its preload sets window.__LOUI_MAC_SHELL__.
// Mastering + WAV export work there, but attaching the result Blob URL to an
// <audio> element SIGSEGVs the macOS renderer. So on mac-shell ONLY we skip
// preview playback (save/export still work). Android (capacitor/https) and the
// web build never match this flag → their behavior is unchanged.
const IS_MAC_SHELL: boolean =
  typeof window !== 'undefined' &&
  (((window as unknown as { __LOUI_MAC_SHELL__?: boolean }).__LOUI_MAC_SHELL__ === true) ||
    (typeof window.location !== 'undefined' && window.location.protocol === 'app:'));


// Map a local engine error to a clear, user-friendly Korean message.
function toUserError(step: string, e: unknown, ctx?: ErrorContext): string {
  reportError(step, e, ctx); // local console log only (no server)
  if (e instanceof LocalMasteringError) {
    switch (e.code) {
      case 'UNSUPPORTED_FORMAT':
      case 'FILE_DECODE_FAILED':
        return '이 파일 형식은 기기에서 열 수 없습니다. WAV / MP3 / M4A 파일을 사용해 주세요.';
      case 'INSUFFICIENT_MEMORY':
        return e.message; // already specific ("20분이 넘는 파일은…")
      case 'EXPORT_FAILED':
        return '마스터링 결과를 저장하는 중 문제가 발생했습니다. 다시 시도해 주세요.';
      case 'LOCAL_ENGINE_CRASHED':
        return '기기에서 오디오 처리를 완료하지 못했습니다. 다른 파일로 다시 시도해 주세요.';
      case 'CANCELLED':
        return ''; // not shown
    }
  }
  return GENERIC_ERR;
}

// ── Flow model ──────────────────────────────────────────────────────────────
type StepKey = 'pick' | 'master' | 'result';

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'pick', label: '파일' },
  { key: 'master', label: '마스터' },
  { key: 'result', label: '결과' },
];
const FIRST_STEP: StepKey = STEPS[0].key;

type RunPhase = 'idle' | 'running' | 'done' | 'error';

const STYLES = ['balanced', 'warm', 'bright', 'kpop_loud', 'club'];

interface PlayableResult {
  url: string;
  blob: Blob;
}

export default function App() {
  // step / navigation
  const [step, setStep] = useState<StepKey>(FIRST_STEP);

  // 1) file
  const [file, setFile] = useState<PickedAudio | null>(null);
  const [pickError, setPickError] = useState('');

  // mastering options + run
  const [style, setStyle] = useState('balanced');
  const [targetLufs, setTargetLufs] = useState(-14);
  const [targetTp, setTargetTp] = useState(-1);

  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [masterError, setMasterError] = useState('');

  // 3) result
  const [master, setMaster] = useState<PlayableResult | null>(null);
  const [metrics, setMetrics] = useState<{ lufs: number | null; truePeak: number | null } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sheetFor, setSheetFor] = useState<'master' | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // run-id guard: lets the user cancel an in-flight run (we ignore stale results)
  const runRef = useRef(0);

  const busy = runPhase === 'running';

  // elapsed timer while a run is active
  useEffect(() => {
    if (runPhase !== 'running') return;
    const t0 = Date.now() - elapsed * 1000;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPhase]);

  // Background policy: OfflineAudioContext rendering is unreliable when the
  // WebView is backgrounded. If the user leaves the app mid-run, we cancel the
  // run cleanly and ask them to restart it (no silent half-finished output).
  useEffect(() => {
    if (runPhase !== 'running') return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        runRef.current++; // invalidate the in-flight run
        setRunPhase('error');
        setMasterError('마스터링 중 앱이 백그라운드로 전환되어 중단되었습니다. 다시 시도해 주세요.');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [runPhase]);

  // ── actions ────────────────────────────────────────────────────────────────
  async function onPick() {
    try {
      setPickError('');
      const picked = await pickAudioFile();
      if (!picked) return;
      // The picker filter is unreliable on iOS, so gate the type here.
      if (!isAllowedAudio(picked.name, picked.mimeType)) {
        setPickError('지원하지 않는 형식입니다. mp3 / wav / m4a / aac / flac 파일을 선택해 주세요.');
        return;
      }
      setFile(picked);
      // reset downstream state for the new file
      setMaster(null);
      setMetrics(null);
      setWarnings([]);
      setRunPhase('idle');
    } catch (e) {
      setPickError(toUserError('select', e, { file }));
    }
  }

  async function onMaster() {
    if (!file) return;
    // Concurrency: only one local mastering at a time (CPU/memory heavy).
    if (busy) {
      setMasterError('현재 마스터링이 진행 중입니다. 완료된 후 다시 시도해 주세요.');
      return;
    }
    // Hard size cap (before allocating any memory).
    if (file.size > MAX_FILE_BYTES) {
      setMasterError(`${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB가 넘는 파일은 기기에서 처리할 수 없습니다. 더 작은 파일을 선택해 주세요.`);
      setRunPhase('error');
      return;
    }

    const myRun = ++runRef.current;
    const stale = () => runRef.current !== myRun;

    setMasterError('');
    setMaster(null);
    setMetrics(null);
    setWarnings([]);
    setPercent(0);
    setStage('오디오를 준비하고 있습니다');
    setElapsed(0);
    setRunPhase('running');

    const sig: LocalSignal = { cancelled: stale };

    try {
      const result: LocalMasterResult = await runLocalMastering(
        file.blob,
        { style, targetLufs, targetTp },
        (p, s) => {
          if (!stale()) {
            setPercent(p);
            setStage(s);
          }
        },
        sig,
      );
      if (stale()) {
        URL.revokeObjectURL(result.previewUrl);
        return;
      }
      setMaster({ url: result.previewUrl, blob: result.blob });
      setMetrics({ lufs: result.lufs, truePeak: result.truePeak });
      setWarnings(result.warnings);
      setRunPhase('done');
      setStep('result');
    } catch (e) {
      if (stale() || e instanceof CancelledError) return; // cancelled → no error UI
      if (e instanceof LocalMasteringError && e.code === 'CANCELLED') return;
      setMasterError(toUserError('master', e, { file }));
      setRunPhase('error');
    }
  }

  function cancelRun() {
    runRef.current++; // invalidate the in-flight run; stale guards stop UI updates
    setRunPhase('idle');
  }

  function openSheet(which: 'master') {
    setActionMsg(null);
    setSheetFor(which);
  }

  function fileNameFor(): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const base = safeBaseName(file?.name || 'audio');
    return `${base}_Mastering_${ymd}.wav`;
  }

  async function doSave() {
    setSheetFor(null);
    if (!master) return;
    try {
      const where = await saveToDownloads(master.blob, fileNameFor());
      setActionMsg({ ok: true, text: `저장 완료: ${where}` });
    } catch (e) {
      setActionMsg({ ok: false, text: toUserError('save', e, { file }) });
    }
  }

  async function doShare() {
    setSheetFor(null);
    if (!master) return;
    try {
      await shareFile(master.blob, fileNameFor(), 'Loui 마스터 (WAV)');
    } catch (e) {
      setActionMsg({ ok: false, text: toUserError('share', e, { file }) });
    }
  }

  function restart() {
    runRef.current++;
    if (master) URL.revokeObjectURL(master.url);
    setFile(null);
    setPickError('');
    setMaster(null);
    setMetrics(null);
    setWarnings([]);
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
          <span className="badge">{isNative() ? 'Android' : 'Web'} · 로컬</span>
        </div>
        <Stepper current={stepIndex} onJump={goTo} />
      </header>

      <main className="content">
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
            metrics={metrics}
            warnings={warnings}
            actionMsg={actionMsg}
            onOpenSheet={openSheet}
          />
        )}
      </main>

      <footer className="actionbar">
        <ActionBar
          step={step}
          busy={busy}
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
          title="마스터 (WAV)"
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

// ── Step 1: Pick ──────────────────────────────────────────────────────────────
function PickStep({ file, onPick, error }: { file: PickedAudio | null; onPick: () => void; error: string }) {
  return (
    <section className="card">
      <h2>오디오 파일 선택</h2>
      <p className="hint">wav · mp3 · m4a 등. 마스터링은 모두 이 기기 안에서 처리됩니다 (인터넷 불필요).</p>
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

// ── Step 2: Master ────────────────────────────────────────────────────────────
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

  const running = runPhase === 'running';
  const big = file ? file.size > LARGE_FILE_BYTES : false; // 60MB → warn
  const tooBig = file ? file.size > MAX_FILE_BYTES : false; // 150MB → block

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

          {tooBig ? (
            <div className="notice error">
              <strong>파일이 너무 큽니다.</strong>
              <p>{Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 이하의 파일만 기기에서 처리할 수 있어요. 더 작은 파일을 선택해 주세요.</p>
            </div>
          ) : big ? (
            <div className="notice warn">
              <strong>큰 파일입니다.</strong>
              <p>기기에서 처리하는 데 시간이 오래 걸리고 메모리를 많이 사용할 수 있어요. (권장: 6분 이하)</p>
            </div>
          ) : null}

          {!file && <p className="inline-err">먼저 파일을 선택하세요.</p>}
        </>
      )}

      {running && (
        <div className="runpanel">
          <div className="progress">
            <div className="bar" style={{ width: `${Math.max(percent, 3)}%` }} />
            <span className="ptext">{stage || '처리 중'} {percent}%</span>
          </div>
          <p className="hint center">기기에서 처리 중입니다. 앱을 벗어나지 말고 잠시만 기다려주세요.</p>
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

// ── Step 3: Result ────────────────────────────────────────────────────────────
function ResultStep(props: {
  master: PlayableResult | null;
  metrics: { lufs: number | null; truePeak: number | null } | null;
  warnings: string[];
  actionMsg: { ok: boolean; text: string } | null;
  onOpenSheet: (which: 'master') => void;
}) {
  const { master, metrics, warnings, actionMsg, onOpenSheet } = props;
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
          {IS_MAC_SHELL ? (
            <p className="hint">
              macOS 미리듣기는 현재 비활성화되어 있습니다. 저장 후 Finder에서 재생해 주세요.
            </p>
          ) : (
            <audio src={master.url} controls className="player" preload="metadata" />
          )}
          {metrics && (
            <p className="hint small">
              측정값(근사): LUFS {metrics.lufs ?? '—'} · True Peak {metrics.truePeak ?? '—'} dBFS
            </p>
          )}
          <button className="btn block" onClick={() => onOpenSheet('master')}>
            저장 / 공유
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="notice warn">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
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
  hasFile: boolean;
  runPhase: RunPhase;
  hasResult: boolean;
  canBack: boolean;
  goBack: () => void;
  next: (k: StepKey) => void;
  onMaster: () => void;
  restart: () => void;
}) {
  const { step, busy, hasFile, runPhase, hasResult, canBack, goBack, next, onMaster, restart } = props;
  const running = runPhase === 'running';

  if (step === 'pick') {
    // 'pick' is the first step → no back button.
    return (
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
      <button className="btn ghost" onClick={goBack} disabled={!canBack}>
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
