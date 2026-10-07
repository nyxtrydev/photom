// Canonical JSON + Ed25519 signing for the model catalog. The Rust verifier
// (src-tauri/src/model_hub/manifest.rs) must produce byte-identical canonical output; both sides
// test the same vector.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** Compact JSON with object keys sorted at every level. Catalog numbers are integers only. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/** Signature (base64) over the canonical JSON of `catalog.models`. */
export function signCatalog(catalog, privatePem) {
  const key = createPrivateKey(privatePem);
  return sign(null, Buffer.from(canonicalize(catalog.models)), key).toString('base64');
}

export function verifyCatalog(catalog, publicPem) {
  const key = createPublicKey(publicPem);
  return verify(
    null,
    Buffer.from(canonicalize(catalog.models)),
    key,
    Buffer.from(catalog.signature, 'base64'),
  );
}

const PLACEHOLDER = '0'.repeat(64);

/** SHA-256 (hex) and byte size of a file, streamed. */
export async function hashFile(path) {
  const { createHash } = await import('node:crypto');
  const { createReadStream, statSync } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: statSync(path).size };
}

/**
 * Publish a real file for a catalog entry: set its hash and size (model and its single file),
 * optionally add a download URL (first = primary) and bump the version. Returns the entry.
 * The catalog must be signed again afterwards.
 */
export function fillModel(catalog, id, { sha256, size, url, version }) {
  const m = catalog.models.find((x) => x.id === id);
  if (!m) throw new Error(`no model '${id}' in the catalog`);
  if (m.files.length !== 1) throw new Error(`${id} has several files; fill them by hand`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex characters');
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive integer');
  if (url && !url.startsWith('https://')) throw new Error('download URLs must be https');
  m.sha256 = sha256;
  m.sizeBytes = size;
  m.files[0].sha256 = sha256;
  m.files[0].sizeBytes = size;
  if (url) m.urls = [url, ...m.urls.filter((u) => u !== url && !u.includes('.example/'))];
  if (version) m.version = version;
  return m;
}

/** Entries that still carry a placeholder hash and therefore cannot be installed. */
export function unpublished(catalog) {
  return catalog.models
    .filter((m) => m.sha256 === PLACEHOLDER || m.files.some((f) => f.sha256 === PLACEHOLDER))
    .filter((m) => m.urls.length > 0)
    .map((m) => m.id);
}
