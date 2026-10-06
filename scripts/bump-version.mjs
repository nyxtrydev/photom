#!/usr/bin/env node
// Keeps package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json on one version.
// Usage: node scripts/bump-version.mjs <major|minor|patch|x.y.z>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bump, setCargoVersion } from './lib/release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (!arg) {
  console.error('usage: bump-version.mjs <major|minor|patch|x.y.z>');
  process.exit(2);
}

const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bump(pkg.version, arg);

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const cargoPath = resolve(root, 'src-tauri/Cargo.toml');
writeFileSync(cargoPath, setCargoVersion(readFileSync(cargoPath, 'utf8'), next));

const confPath = resolve(root, 'src-tauri/tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = next;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

console.log(next);
