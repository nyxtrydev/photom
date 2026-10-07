#!/usr/bin/env node
// Sign a model catalog: node scripts/sign-catalog.mjs <catalog.json> [--key .keys/catalog-dev.pem]
// Rewrites the file with `signature` set. The private key never lives in the repo (*.pem is ignored).
import { readFileSync, writeFileSync } from 'node:fs';
import { signCatalog } from './lib/catalog.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const keyIdx = args.indexOf('--key');
const keyPath = keyIdx >= 0 ? args[keyIdx + 1] : '.keys/catalog-dev.pem';
if (!file) {
  console.error('usage: sign-catalog.mjs <catalog.json> [--key <private.pem>]');
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(file, 'utf8'));
catalog.signature = signCatalog(catalog, readFileSync(keyPath, 'utf8'));
writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`signed ${file}`);
