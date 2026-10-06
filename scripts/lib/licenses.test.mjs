import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flattenNpmTree, normaliseLicense, parseCargoTree, renderMarkdown } from './licenses.mjs';

test('parses cargo tree output and de-duplicates', () => {
  const out =
    'serde v1.0.219|MIT OR Apache-2.0\nserde v1.0.219|MIT OR Apache-2.0\nzip v4.6.1 (proc-macro)|MIT\n\nweird line';
  const got = parseCargoTree(out);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], {
    name: 'serde',
    version: '1.0.219',
    license: 'MIT OR Apache-2.0',
    ecosystem: 'rust',
  });
});

test("strips cargo's duplicate marker from the licence", () => {
  assert.equal(
    parseCargoTree('image v0.25.10|MIT OR Apache-2.0 (*)')[0].license,
    'MIT OR Apache-2.0',
  );
});

test('missing licence becomes UNKNOWN', () => {
  assert.equal(parseCargoTree('foo v0.1.0|')[0].license, 'UNKNOWN');
});

test('flattens a nested npm tree', () => {
  const tree = {
    dependencies: {
      a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' }, a: { version: '1.0.0' } } },
    },
  };
  assert.deepEqual(
    flattenNpmTree(tree)
      .map((p) => `${p.name}@${p.version}`)
      .sort(),
    ['a@1.0.0', 'b@2.0.0'],
  );
});

test('normalises the different package.json licence spellings', () => {
  assert.equal(normaliseLicense({ license: 'MIT' }), 'MIT');
  assert.equal(normaliseLicense({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(
    normaliseLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    'MIT OR Apache-2.0',
  );
  assert.equal(normaliseLicense({}), 'UNKNOWN');
});

test('renders each distinct licence text once and lists components without one', () => {
  const md = renderMarkdown({
    generated: '2026-10-05',
    extra: [],
    entries: [
      { name: 'a', version: '1', license: 'MIT', ecosystem: 'rust', text: 'MIT TEXT' },
      { name: 'b', version: '2', license: 'MIT', ecosystem: 'npm', text: 'MIT   TEXT\n' },
      { name: 'c', version: '3', license: 'ISC', ecosystem: 'npm', text: '' },
    ],
  });
  assert.equal((md.match(/MIT TEXT/g) ?? []).length, 1);
  assert.match(md, /Used by: a 1, b 2/);
  assert.match(md, /\| c \| 3 \| ISC \| npm \|/);
  assert.match(md, /without a bundled licence file[\s\S]*c 3 \(ISC\)/);
});

test('adds the standard text for identifiers whose package shipped no licence file', () => {
  const md = renderMarkdown({
    generated: 'x',
    extra: [],
    standard: { MIT: 'STANDARD MIT', ISC: 'STANDARD ISC' },
    entries: [
      { name: 'd', version: '1', license: 'MIT OR Apache-2.0', ecosystem: 'rust', text: '' },
    ],
  });
  assert.match(md, /Standard MIT text[\s\S]*STANDARD MIT/);
  assert.doesNotMatch(md, /STANDARD ISC/);
});
