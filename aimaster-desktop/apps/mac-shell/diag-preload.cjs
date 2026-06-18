// diag-preload.cjs — mac-shell DIAGNOSTIC instrument (root-cause of the macOS
// renderer SIGSEGV during on-device mastering).
//
// Runs in the page's MAIN WORLD (main.cjs sets contextIsolation:false +
// sandbox:false) BEFORE the SPA's scripts, so it can wrap the exact globals the
// mobile engine uses — WITHOUT modifying any apps/mobile source. Every
// checkpoint is written SYNCHRONOUSLY to ~/loui-diag.log via fs.appendFileSync,
// so the LAST line on disk is the call immediately before the crash (item 8).
//
// Instruments: OfflineAudioContext construction (item 4) + startRendering,
// decodeAudioData → AudioBuffer dur/ch/sampleRate/length (item 7), Blob creation
// = WAV export (item 5), URL.createObjectURL (item 6), <audio> src + media
// errors (result-screen entry, item 3), and global error/unhandledrejection.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG = path.join(os.homedir(), 'loui-diag.log');
let seq = 0;
function D(msg) {
  const line = `[${new Date().toISOString()}] #${++seq} ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch { /* ignore */ }
  try { console.log('[DIAG]', msg); } catch { /* ignore */ }
}

try {
  // Fresh log per launch.
  try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }
  D(`preload loaded (main world). diag log = ${LOG}`);

  const W = window;

  // ── 1) OfflineAudioContext: construction + startRendering ───────────────────
  function wrapOAC(name) {
    const Orig = W[name];
    if (typeof Orig !== 'function') return;
    // Patch startRendering once on the prototype (shared by all instances).
    if (Orig.prototype && typeof Orig.prototype.startRendering === 'function') {
      const origRender = Orig.prototype.startRendering;
      Orig.prototype.startRendering = function patchedStartRendering() {
        D(`${name}.startRendering BEGIN len=${this.length} ch=${this.numberOfChannels} sr=${this.sampleRate}`);
        let r;
        try {
          r = origRender.apply(this, arguments);
        } catch (e) {
          D(`${name}.startRendering THREW ${e && e.message}`);
          throw e;
        }
        if (r && typeof r.then === 'function') {
          return r.then(
            (buf) => { D(`${name}.startRendering DONE -> len=${buf && buf.length}`); return buf; },
            (e) => { D(`${name}.startRendering REJECT ${e && e.message}`); throw e; },
          );
        }
        return r;
      };
    }
    // Wrap the constructor to log args at creation time.
    function Wrapped(...args) {
      D(`new ${name}(${safeArgs(args)})`);
      let inst;
      try {
        inst = Reflect.construct(Orig, args, new.target || Wrapped);
      } catch (e) {
        D(`new ${name} THREW ${e && e.message}`);
        throw e;
      }
      D(`new ${name} OK len=${inst.length} ch=${inst.numberOfChannels} sr=${inst.sampleRate}`);
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    W[name] = Wrapped;
  }
  wrapOAC('OfflineAudioContext');
  wrapOAC('webkitOfflineAudioContext');

  // ── 2) decodeAudioData → AudioBuffer params ─────────────────────────────────
  function wrapDecode(name) {
    const AC = W[name];
    if (typeof AC !== 'function' || !AC.prototype || typeof AC.prototype.decodeAudioData !== 'function') return;
    const orig = AC.prototype.decodeAudioData;
    AC.prototype.decodeAudioData = function patchedDecode(data, onOk, onErr) {
      D(`${name}.decodeAudioData START bytes=${data && data.byteLength}`);
      const logBuf = (buf) => {
        try { D(`decoded AudioBuffer dur=${buf.duration}s ch=${buf.numberOfChannels} sr=${buf.sampleRate} len=${buf.length}`); } catch { /* ignore */ }
      };
      let r;
      try {
        r = orig.call(
          this,
          data,
          onOk ? (buf) => { logBuf(buf); return onOk(buf); } : undefined,
          onErr ? (e) => { D(`decodeAudioData ERROR cb ${e && e.message}`); return onErr(e); } : undefined,
        );
      } catch (e) {
        D(`decodeAudioData THREW ${e && e.message}`);
        throw e;
      }
      if (r && typeof r.then === 'function') {
        return r.then(
          (buf) => { logBuf(buf); return buf; },
          (e) => { D(`decodeAudioData REJECT ${e && e.message}`); throw e; },
        );
      }
      return r;
    };
  }
  wrapDecode('AudioContext');
  wrapDecode('webkitAudioContext');

  // ── 3) Blob creation (WAV export point) ─────────────────────────────────────
  const OrigBlob = W.Blob;
  if (typeof OrigBlob === 'function') {
    function BlobW(parts, opts) {
      const b = new OrigBlob(parts, opts);
      try {
        // Only log audio/large blobs to avoid noise.
        if ((b.type && /audio|wav|octet/i.test(b.type)) || b.size > 500000) {
          D(`Blob created type=${b.type || '?'} size=${b.size}`);
        }
      } catch { /* ignore */ }
      return b;
    }
    BlobW.prototype = OrigBlob.prototype;
    Object.setPrototypeOf(BlobW, OrigBlob);
    W.Blob = BlobW;
  }

  // ── 4) URL.createObjectURL (preview/export url) ─────────────────────────────
  if (W.URL && typeof W.URL.createObjectURL === 'function') {
    const orig = W.URL.createObjectURL;
    W.URL.createObjectURL = function patchedCOU(obj) {
      try { D(`URL.createObjectURL type=${obj && obj.type} size=${obj && obj.size}`); } catch { /* ignore */ }
      return orig.call(this, obj);
    };
  }

  // ── 5) <audio> src assignment + media errors (result screen) ────────────────
  const mediaProto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
  if (mediaProto) {
    const d = Object.getOwnPropertyDescriptor(mediaProto, 'src');
    if (d && typeof d.set === 'function') {
      Object.defineProperty(mediaProto, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(v) {
          try { D(`<media>.src = ${String(v).slice(0, 48)}`); } catch { /* ignore */ }
          return d.set.call(this, v);
        },
      });
    }
    W.addEventListener('error', (e) => {
      const t = e && e.target;
      if (t && (t.tagName === 'AUDIO' || t.tagName === 'VIDEO')) {
        D(`media element error code=${t.error && t.error.code}`);
      }
    }, true);
  }

  // ── 6) Global errors / rejections ───────────────────────────────────────────
  W.addEventListener('error', (e) => {
    D(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  W.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    D(`unhandledrejection: ${(r && (r.stack || r.message)) || r}`);
  });

  D('instrumentation installed');
} catch (e) {
  D(`preload setup failed: ${e && (e.stack || e.message)}`);
}

function safeArgs(args) {
  try { return JSON.stringify(args); } catch { return String(args && args.length); }
}
