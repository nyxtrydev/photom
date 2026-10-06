#!/usr/bin/env node
// Generates a CHANGELOG.md section from conventional commits since the last tag.
// Usage: node scripts/changelog.mjs <version> [--suggest]   (--suggest prints the implied bump instead)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prependRelease, renderRelease, suggestedBump } from './lib/release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

let range = 'HEAD';
try {
  range = `${git('describe', '--tags', '--abbrev=0', '--match', 'v*')}..HEAD`;
} catch {
  /* no tag yet: the whole history */
}
const subjects = git('log', range, '--no-merges', '--pretty=format:%s').split('\n').filter(Boolean);

if (process.argv.includes('--suggest')) {
  console.log(suggestedBump(subjects) ?? 'patch');
  process.exit(0);
}
const version = process.argv[2];
if (!version) {
  console.error('usage: changelog.mjs <version> [--suggest]');
  process.exit(2);
}
const file = resolve(root, 'CHANGELOG.md');
const section = renderRelease(version, new Date().toISOString().slice(0, 10), subjects);
writeFileSync(
  file,
  prependRelease(existsSync(file) ? readFileSync(file, 'utf8') : '', section, version),
);
// The release workflow also uses this as the GitHub release body.
writeFileSync(resolve(root, 'RELEASE_NOTES.md'), `${section}\n`);
console.log(`CHANGELOG.md updated for ${version} (${subjects.length} commits)`);
