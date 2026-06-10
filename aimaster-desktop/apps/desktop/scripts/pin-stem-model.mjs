#!/usr/bin/env node
// pin-stem-model — compute sha256 + byte size for a stem-separation model and
// write the `stem-model.manifest.json` sidecar that flips the precise tier on.
//
// The model weights are NOT bundled and (in CI/sandbox) the upstream weight
// hosts may be unreachable.  Run this on a machine/host that can read the
// exported .onnx, then drop the emitted sidecar next to the app's userData
// `models/` dir (or commit it as a packaged resource).
//
// Usage:
//   node scripts/pin-stem-model.mjs --file ./htdemucs.onnx --url https://host/htdemucs.onnx [--out ./stem-model.manifest.json]
//   node scripts/pin-stem-model.mjs --url https://host/htdemucs.onnx   # download + hash in one shot
//
// Options:
//   --file <path>      local .onnx to hash (skips download)
//   --url  <url>       runtime download URL recorded in the manifest (and the
//                      source to fetch when --file is omitted)
//   --id   <id>        model id / cache subdir            (default htdemucs-v4)
//   --name <fileName>  cached filename                    (default htdemucs.onnx)
//   --rate <hz>        model sample rate                  (default 44100)
//   --out  <path>      sidecar output path  (default ./stem-model.manifest.json)

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; }
  }
  return a;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function buildManifest({ id, fileName, url, bytes, sha256, modelSampleRate }) {
  return { id, fileName, url, sha256, bytes, modelSampleRate };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = typeof a.url === 'string' ? a.url : '';
  if (!a.file && !url) {
    console.error('error: provide --file <path> and/or --url <url>');
    process.exit(2);
  }
  const data = a.file ? new Uint8Array(await readFile(a.file)) : await fetchBytes(url);
  const sha256 = createHash('sha256').update(data).digest('hex');

  const manifest = buildManifest({
    id: typeof a.id === 'string' ? a.id : 'htdemucs-v4',
    fileName: typeof a.name === 'string' ? a.name : 'htdemucs.onnx',
    url, // may be '' if only hashing a local file — fill before shipping
    bytes: data.byteLength,
    sha256,
    modelSampleRate: a.rate ? Number(a.rate) : 44100,
  });

  const out = typeof a.out === 'string' ? a.out : './stem-model.manifest.json';
  await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`✓ ${out}`);
  console.log(JSON.stringify(manifest, null, 2));
  if (!url) console.warn('\n⚠  url is empty — set the runtime download URL before shipping (re-run with --url).');
  console.log('\nPaste into HTDEMUCS_MANIFEST (stem-model-manager.ts) or place this sidecar at userData/models/stem-model.manifest.json');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
