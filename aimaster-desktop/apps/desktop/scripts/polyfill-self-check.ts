import { WORKLET_TEXTCODEC_POLYFILL } from '../src/renderer/audio/worklet-textcodec-polyfill.js';
import vm from 'node:vm';
// Mimic an AudioWorkletGlobalScope WITHOUT TextDecoder/TextEncoder.
const sandbox: { globalThis: object; Uint8Array: typeof Uint8Array } = { globalThis: {}, Uint8Array };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(WORKLET_TEXTCODEC_POLYFILL, ctx);
const enc = vm.runInContext(
  "new TextEncoder().encode('한글 EQ +24dB · ABC')",
  ctx,
) as Uint8Array;
const dec = vm.runInContext(
  `new TextDecoder('utf-8',{ignoreBOM:true,fatal:true}).decode(new Uint8Array([${Array.from(enc).join(',')}]))`,
  ctx,
) as string;
const ok = dec === '한글 EQ +24dB · ABC';
console.log(`[${ok ? 'PASS' : 'FAIL'}] polyfill round-trip in isolated scope → "${dec}"`);
process.exit(ok ? 0 : 1);
