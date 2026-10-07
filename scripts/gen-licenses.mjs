#!/usr/bin/env node
// Generates THIRD_PARTY_LICENSES.md (and the copy bundled with the app) from the local dependency
// trees. Works offline: it reads the cargo registry and node_modules that are already installed.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flattenNpmTree,
  normaliseLicense,
  parseCargoTree,
  renderMarkdown,
} from './lib/licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|notice)([-_.].*)?$/i;
function readLicenseText(dir) {
  if (!dir || !existsSync(dir)) return '';
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && !f.endsWith('.rs'));
  return files
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n\n');
}

// ---- Rust (every target we ship to, normal dependencies only) --------------------------------
const manifest = join(root, 'src-tauri', 'Cargo.toml');
const tree = run('cargo', [
  'tree',
  '--manifest-path',
  manifest,
  '--target',
  'all',
  '-e',
  'normal',
  '--prefix',
  'none',
  '--format',
  '{p}|{l}',
]);
const crates = parseCargoTree(tree).filter((c) => c.name !== 'photom');
const meta = JSON.parse(
  run('cargo', ['metadata', '--manifest-path', manifest, '--format-version', '1', '--locked']),
);
const crateDir = new Map(
  meta.packages.map((p) => [`${p.name}@${p.version}`, dirname(p.manifest_path)]),
);
for (const c of crates) c.text = readLicenseText(crateDir.get(`${c.name}@${c.version}`));

// ---- npm (production dependencies) ------------------------------------------------------------
let npmTree = {};
try {
  npmTree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json']));
} catch (e) {
  npmTree = JSON.parse(e.stdout ?? '{}'); // npm exits non-zero for extraneous packages but still prints the tree
}
const npmPkgs = flattenNpmTree(npmTree).map((p) => {
  const dir = join(root, 'node_modules', p.name);
  let license = 'UNKNOWN';
  try {
    license = normaliseLicense(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
  } catch {
    /* keep UNKNOWN */
  }
  return { ...p, license, ecosystem: 'npm', text: readLicenseText(dir) };
});

// ---- components that are not packages ---------------------------------------------------------
const mit = readLicenseText(join(root, 'node_modules', 'react')); // standard MIT text
const apache =
  crates.find((c) => /Apache-2\.0/.test(c.license) && c.text.includes('Apache License'))?.text ??
  '';
const extra = [
  {
    name: 'ONNX Runtime',
    version: '1.22',
    license: 'MIT',
    ecosystem: 'runtime',
    text: `${mit.replace(/Copyright \(c\) .*/m, 'Copyright (c) Microsoft Corporation')}`,
  },
  {
    name: 'ISNet general-use model (DIS, via rembg release v0.0.0)',
    version: 'fp16 weights',
    license: 'Apache-2.0',
    ecosystem: 'model',
    text: apache,
  },
  {
    name: 'Real-ESRGAN x2plus / x4plus models (Xintao Wang et al., ONNX export)',
    version: 'fp32 weights',
    license: 'BSD-3-Clause',
    ecosystem: 'model',
    text: `BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
  {
    name: 'BiRefNet (optional Quality model, supplied by the user)',
    version: '-',
    license: 'MIT',
    ecosystem: 'model',
    text: '',
  },
];

const md = renderMarkdown({
  entries: [...crates, ...npmPkgs],
  extra,
  generated: new Date().toISOString().slice(0, 10),
  standard: { MIT: mit, 'Apache-2.0': apache },
});
for (const target of [
  join(root, 'THIRD_PARTY_LICENSES.md'),
  join(root, 'src-tauri', 'resources', 'THIRD_PARTY_LICENSES.md'),
]) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, md);
}
console.log(
  `Wrote THIRD_PARTY_LICENSES.md: ${crates.length} crates, ${npmPkgs.length} npm packages, ${(md.length / 1024).toFixed(0)} KB`,
);
