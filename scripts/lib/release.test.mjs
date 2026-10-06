import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bump,
  parseCommit,
  prependRelease,
  renderRelease,
  setCargoVersion,
  suggestedBump,
} from './release.mjs';

test('bumps semantic versions', () => {
  assert.equal(bump('0.1.0', 'patch'), '0.1.1');
  assert.equal(bump('0.1.9', 'minor'), '0.2.0');
  assert.equal(bump('1.4.2', 'major'), '2.0.0');
  assert.equal(bump('1.0.0', '2.5.1'), '2.5.1');
  assert.equal(bump('1.0.0', '2.0.0-beta.1'), '2.0.0-beta.1');
  assert.throws(() => bump('1.0.0', 'huge'), /unknown bump/);
  assert.throws(() => bump('nope', 'patch'), /not a semantic version/);
});

test('only touches the [package] version in Cargo.toml', () => {
  const toml =
    '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\nfoo = "2"\n\n[dependencies.bar]\nversion = "3"\n';
  const out = setCargoVersion(toml, '0.2.0');
  assert.match(out, /\[package\]\nname = "x"\nversion = "0.2.0"/);
  assert.match(out, /serde = \{ version = "1" \}/);
  assert.match(out, /\[dependencies\.bar\]\nversion = "3"/);
});

test('parses conventional commit subjects', () => {
  assert.deepEqual(parseCommit('feat(editor): add brush'), {
    type: 'feat',
    scope: 'editor',
    breaking: false,
    text: 'add brush',
  });
  assert.equal(parseCommit('fix!: drop old format').breaking, true);
  assert.equal(parseCommit('Merge branch main'), null);
  assert.equal(parseCommit('WIP stuff'), null);
});

test('suggests the right bump', () => {
  assert.equal(suggestedBump(['fix: a', 'docs: b']), 'patch');
  assert.equal(suggestedBump(['fix: a', 'feat: b']), 'minor');
  assert.equal(suggestedBump(['feat: a', 'refactor!: b']), 'major');
  assert.equal(suggestedBump(['Merge x']), null);
});

test('renders grouped release notes and skips noise', () => {
  const md = renderRelease('0.2.0', '2026-10-05', [
    'feat(export): add presets',
    'fix: crash on empty batch',
    'Merge pull request #1',
    'chore(release): 0.2.0',
    'feat!: new project format',
  ]);
  assert.match(md, /^## 0\.2\.0 \(2026-10-05\)/);
  assert.match(md, /### Breaking changes\n\n- new project format/);
  assert.match(md, /### Features\n\n- \*\*export:\*\* add presets/);
  assert.match(md, /### Fixes\n\n- crash on empty batch/);
  assert.doesNotMatch(md, /Merge pull request|chore\(release\)/);
});

test('an empty release still says something', () => {
  assert.match(renderRelease('0.1.1', '2026-10-05', ['Merge x']), /No notable changes/);
});

test('prepends newest first and replaces a re-generated version', () => {
  const first = prependRelease('', '## 0.1.0 (2026-01-01)\n\n- a\n', '0.1.0');
  const second = prependRelease(first, '## 0.2.0 (2026-02-01)\n\n- b\n', '0.2.0');
  assert.ok(second.indexOf('0.2.0') < second.indexOf('0.1.0'));
  const regenerated = prependRelease(second, '## 0.2.0 (2026-02-02)\n\n- b2\n', '0.2.0');
  assert.equal((regenerated.match(/## 0\.2\.0/g) ?? []).length, 1);
  assert.match(regenerated, /b2/);
  assert.doesNotMatch(regenerated, /\n- b\n/);
  assert.match(regenerated, /## 0\.1\.0/);
});
