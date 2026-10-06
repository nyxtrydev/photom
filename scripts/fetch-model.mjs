#!/usr/bin/env node
// Developer helper: downloads the bundled Fast model (ISNet general-use, Apache-2.0) and verifies its SHA-256.
// The app itself never downloads anything. Usage: node scripts/fetch-model.mjs
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx';
const SHA256 = '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a';
const dest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src-tauri/resources/models/isnet-general-use.onnx',
);

const sha = (p) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });

if (existsSync(dest) && (await sha(dest)) === SHA256) {
  console.log('Model already present and verified.');
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
console.log(`Downloading ${URL_} ...`);
const res = await fetch(URL_, { redirect: 'follow' });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const tmp = `${dest}.part`;
writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
if ((await sha(tmp)) !== SHA256) throw new Error('Checksum mismatch; download discarded.');
renameSync(tmp, dest);
console.log('Model downloaded and verified.');

// Build the smaller float16-weights model used by release builds, if Python + onnx are available.
import { spawnSync } from 'node:child_process';
const py = process.platform === 'win32' ? 'python' : 'python3';
const has = spawnSync(py, ['-c', 'import onnx, numpy'], { stdio: 'ignore' }).status === 0;
if (has) {
  const r = spawnSync(
    py,
    [resolve(dirname(fileURLToPath(import.meta.url)), 'make-fast-model.py')],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) console.warn('Could not build the fp16 model; the fp32 model will be used.');
} else {
  console.log(
    'Tip: pip install onnx numpy, then re-run to also build the smaller fp16 model (scripts/make-fast-model.py).',
  );
}
