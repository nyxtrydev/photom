#!/usr/bin/env node
// Publish a real model file in the catalog:
//   node scripts/catalog-fill.mjs <catalog.json> <model-id> <file> [--url https://...] [--version 1.0.1]
// Fills the hash and size from the file. Then sign: node scripts/sign-catalog.mjs <catalog.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { fillModel, hashFile, unpublished } from './lib/catalog.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [catalogPath, id, file] = positional;
if (!catalogPath || !id || !file) {
  console.error(
    'usage: catalog-fill.mjs <catalog.json> <model-id> <file> [--url https://...] [--version x.y.z]',
  );
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const { sha256, size } = await hashFile(file);
fillModel(catalog, id, { sha256, size, url: flag('--url'), version: flag('--version') });
catalog.signature = ''; // the old signature no longer matches
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`${id}: sha256 ${sha256}, ${size} bytes`);
const left = unpublished(catalog);
console.log(
  left.length ? `still unpublished: ${left.join(', ')}` : 'every downloadable model is published',
);
console.log(`now sign it: node scripts/sign-catalog.mjs ${catalogPath}`);
