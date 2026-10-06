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
