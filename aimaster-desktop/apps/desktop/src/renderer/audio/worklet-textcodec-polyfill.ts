// worklet-textcodec-polyfill — TextEncoder/TextDecoder shim injected into the
// wasm-bindgen glue blob before it runs in AudioWorkletGlobalScope.
//
// The Rust mastering chain's glue (`loui-mastering-wasm.nomodules.js`) calls
// `new TextDecoder('utf-8', ...)` and `new TextEncoder()` bare (no guard).
// Some Electron/Chromium AudioWorkletGlobalScope versions do NOT expose those
// globals, so the glue throws `ReferenceError: TextDecoder is not defined`
// and the realtime mastering chain never loads.  Polyfilling once in the
// glue's own module scope (which runs first) makes them available to every
// subsequent worklet in the same context.
//
// Both encoders/decoders are UTF-8 only (which is all wasm-bindgen uses).

export const WORKLET_TEXTCODEC_POLYFILL = `
// ── AudioWorkletGlobalScope TextEncoder/TextDecoder polyfill (Loui) ──
(() => {
  const g = globalThis;
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = class TextDecoder {
      constructor() {}
      decode(buf) {
        if (!buf) return '';
        const bytes = buf instanceof Uint8Array ? buf
          : (buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength)
                        : new Uint8Array(buf));
        let s = '', i = 0;
        const n = bytes.length;
        while (i < n) {
          const c = bytes[i++];
          if (c < 0x80) { s += String.fromCharCode(c); }
          else if (c < 0xC0) { /* invalid lead, skip */ }
          else if (c < 0xE0 && i < n) {
            s += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
          } else if (c < 0xF0 && i + 1 < n) {
            s += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
          } else if (i + 2 < n) {
            const cp = (((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12)
                      | ((bytes[i++] & 0x3F) << 6)  | (bytes[i++] & 0x3F)) - 0x10000;
            s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
          }
        }
        return s;
      }
    };
  }
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class TextEncoder {
      constructor() {}
      encode(str) {
        if (!str) return new Uint8Array(0);
        const out = [];
        for (let i = 0; i < str.length; i++) {
          let c = str.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
            const c2 = str.charCodeAt(i + 1);
            if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
              c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
              i++;
            }
          }
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
          else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
          else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        return new Uint8Array(out);
      }
      encodeInto(str, dest) {
        const enc = this.encode(str);
        const written = Math.min(enc.length, dest.length);
        dest.set(enc.subarray(0, written));
        return { read: str.length, written };
      }
    };
  }
})();
`;
