// App — self-contained mobile test flow (M1). Wires the 8 initial features:
//   1) server URL / API key (env display + override)  2) audio file select
//   3) /v1/analyze  4) /v1/master  5) /v1/jobs/{id} poll
//   6) master/preview download  7) result playback  8) share / save
//
// Intentionally standalone — does NOT import desktop guided components yet
// (that wiring is M3). Only the mobileApi adapter + native plugins are used.

import { useEffect, useMemo, useRef, useState } from 'react';
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

type Phase = 'idle' | 'analyzing' | 'mastering' | 'done' | 'error';

interface ResultUrls {
  master?: { url: string; blob: Blob };
  preview?: { url: string; blob: Blob };
}

const STYLES = ['balanced', 'warm', 'bright', 'kpop_loud', 'club'];

export default function App() {
  // Settings (env is the source of truth; fields allow a local override for testing)
  const [apiUrl, setApiUrl] = useState(ENV_API_URL);
  const [apiKey, setApiKey] = useState(ENV_API_KEY);

  // Push overrides into the adapter whenever the fields change.
  useEffect(() => {
    setApiConfig(apiUrl, apiKey);
  }, [apiUrl, apiKey]);

  // Mastering options
  const [style, setStyle] = useState<string>('balanced');
  const [targetLufs, setTargetLufs] = useState<number>(-14);
  const [targetTp, setTargetTp] = useState<number>(-1);

  const [file, setFile] = useState<PickedAudio | null>(null);
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ResultUrls>({});

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const envConfigured = useMemo(() => Boolean(ENV_API_URL), []);

  function effectiveUrl(): string {
    return (apiUrl || ENV_API_URL).replace(/\/+$/, '');
  }

  async function onPick() {
    try {
      setError('');
      const picked = await pickAudioFile();
      if (!picked) return;
      setFile(picked);
      setAnalysis(null);
      setResult({});
      setPhase('idle');
    } catch (e) {
      fail(e);
    }
  }

  async function onAnalyze() {
    if (!file) return;
    try {
      setPhase('analyzing');
      setError('');
      const a = await analyze(file);
      setAnalysis(a);
      setPhase('idle');
    } catch (e) {
      fail(e);
    }
  }

  async function onMaster() {
    if (!file) return;
    try {
      setError('');
      setResult({});
      setPhase('mastering');
      setPercent(0);
      setStage('queued');

      const options: MasterOptions = {
        style,
        targetLufs,
        targetTp,
        applyAiCorrections: true,
      };
      const jobId = await startMaster(file, options);
      const final = await pollMaster(jobId, (p, s) => {
        setPercent(p);
        setStage(s);
      });
      if (final.status === 'error') {
        throw new Error(final.error || 'mastering failed');
      }

      const master = await downloadPlayable(jobId, 'master');
      let preview: { url: string; blob: Blob } | undefined;
      try {
        preview = await downloadPlayable(jobId, 'preview');
      } catch {
        /* preview is optional */
      }
      setResult({ master, preview });
      setPhase('done');
    } catch (e) {
      fail(e);
    }
  }

  async function onShare(which: 'master' | 'preview') {
    const r = result[which];
    if (!r) return;
    try {
      const ext = which === 'master' ? 'wav' : 'mp3';
      const base = (file?.name || 'audio').replace(/\.[^.]+$/, '');
      await saveOrShare(r.blob, `${base}_${which}.${ext}`);
    } catch (e) {
      fail(e);
    }
  }

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    setPhase('error');
  }

  const playbackUrl = result.preview?.url || result.master?.url;
  const busy = phase === 'analyzing' || phase === 'mastering';

  return (
    <div className="app">
      <header className="hdr">
        <h1>Loui Mastering</h1>
        <span className="badge">{isNative() ? 'Android' : 'Web'} · test</span>
      </header>

      {/* 1) Server settings */}
      <section className="card">
        <h2>Server</h2>
        {envConfigured ? (
          <p className="hint">
            API URL from env: <code>{ENV_API_URL}</code>
            {ENV_API_KEY ? ' · key set' : ' · no key'}
          </p>
        ) : (
          <p className="warn">VITE_MASTERING_API_URL not set — enter it below for testing.</p>
        )}
        <label>API URL</label>
        <input
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://your-app.onrender.com"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <label>API Key (X-API-Key)</label>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="(optional)"
          type="password"
        />
        <p className="hint small">Effective: {effectiveUrl() || '(none)'}</p>
      </section>

      {/* 2) File select */}
      <section className="card">
        <h2>Audio</h2>
        <button className="btn" onClick={onPick} disabled={busy}>
          {file ? 'Choose another file' : 'Select audio file'}
        </button>
        {file && (
          <p className="hint">
            {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB · {file.mimeType}
          </p>
        )}
      </section>

      {/* Mastering options + 3/4 actions */}
      <section className="card">
        <h2>Master</h2>
        <label>Style</label>
        <select value={style} onChange={(e) => setStyle(e.target.value)}>
          {STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="row">
          <div className="col">
            <label>Target LUFS: {targetLufs}</label>
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
        <div className="row">
          <button className="btn ghost" onClick={onAnalyze} disabled={!file || busy}>
            {phase === 'analyzing' ? 'Analyzing…' : 'Analyze'}
          </button>
          <button className="btn" onClick={onMaster} disabled={!file || busy}>
            {phase === 'mastering' ? 'Mastering…' : 'Master'}
          </button>
        </div>

        {/* 5) Progress */}
        {phase === 'mastering' && (
          <div className="progress">
            <div className="bar" style={{ width: `${percent}%` }} />
            <span className="ptext">
              {percent}% · {stage}
            </span>
          </div>
        )}
      </section>

      {/* Analysis output */}
      {analysis && (
        <section className="card">
          <h2>Analysis</h2>
          <pre className="json">{JSON.stringify(analysis, null, 2)}</pre>
        </section>
      )}

      {/* 6/7/8 Result: download done above, playback + share/save */}
      {phase === 'done' && (
        <section className="card">
          <h2>Result</h2>
          {playbackUrl && (
            <audio ref={audioRef} src={playbackUrl} controls className="player" />
          )}
          <div className="row">
            <button className="btn" onClick={() => onShare('master')} disabled={!result.master}>
              Share / Save master (WAV)
            </button>
            <button
              className="btn ghost"
              onClick={() => onShare('preview')}
              disabled={!result.preview}
            >
              Share preview (MP3)
            </button>
          </div>
        </section>
      )}

      {error && (
        <section className="card error">
          <strong>Error</strong>
          <p>{error}</p>
        </section>
      )}

      <footer className="ftr">M1 test app · server-side mastering · Android first</footer>
    </div>
  );
}
