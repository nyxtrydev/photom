import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize, signCatalog, verifyCatalog } from './catalog.mjs';

// Same vector as the Rust test `canonical_form_matches_the_node_signer`.
test('canonical form sorts keys and drops whitespace', () => {
  const v = { b: [1, { z: true, a: null }], a: 'x"y', c: { k: 2 } };
  assert.equal(canonicalize(v), '{"a":"x\\"y","b":[1,{"a":null,"z":true}],"c":{"k":2}}');
});

test('sign then verify; tampering is detected', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const catalog = { models: [{ id: 'a', sizeBytes: 1 }] };
  catalog.signature = signCatalog(catalog, priv);
  assert.equal(verifyCatalog(catalog, pub), true);
  catalog.models[0].sizeBytes = 2;
  assert.equal(verifyCatalog(catalog, pub), false);
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillModel, hashFile, unpublished } from './catalog.mjs';

const sample = () => ({
  models: [
    {
      id: 'a',
      version: '1.0.0',
      sha256: '0'.repeat(64),
      sizeBytes: 5,
      urls: ['https://models.photom.example/a/model.onnx'],
      files: [{ path: 'model.onnx', sizeBytes: 5, sha256: '0'.repeat(64) }],
    },
    { id: 'bundled', sha256: 'ab'.repeat(32), urls: [], files: [{ sha256: 'ab'.repeat(32) }] },
  ],
});

test('hashFile gives the SHA-256 and size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const f = join(dir, 'f.bin');
  writeFileSync(f, 'abc');
  assert.deepEqual(await hashFile(f), {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    size: 3,
  });
});

test('fillModel publishes a real file and unpublished() stops listing it', () => {
  const c = sample();
  assert.deepEqual(unpublished(c), ['a']);
  fillModel(c, 'a', {
    sha256: 'ab'.repeat(32),
    size: 1234,
    url: 'https://cdn.photom.dev/a/1.0.0/model.onnx',
    version: '1.0.1',
  });
  assert.equal(c.models[0].sizeBytes, 1234);
  assert.equal(c.models[0].files[0].sha256, 'ab'.repeat(32));
  assert.equal(c.models[0].version, '1.0.1');
  assert.deepEqual(c.models[0].urls, ['https://cdn.photom.dev/a/1.0.0/model.onnx']);
  assert.deepEqual(unpublished(c), []);
});

test('fillModel refuses bad input', () => {
  const ok = { sha256: 'ab'.repeat(32), size: 1 };
  assert.throws(() => fillModel(sample(), 'nope', ok), /no model/);
  assert.throws(() => fillModel(sample(), 'a', { ...ok, sha256: 'xyz' }), /64 hex/);
  assert.throws(() => fillModel(sample(), 'a', { ...ok, size: 0 }), /positive/);
  assert.throws(() => fillModel(sample(), 'a', { ...ok, url: 'http://x.example/m' }), /https/);
});
