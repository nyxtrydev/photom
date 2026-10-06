// Pure helpers for the licence bundle generator (unit-tested in scripts/lib/licenses.test.mjs).
import { createHash } from 'node:crypto';

/** Parse `cargo tree --format "{p}|{l}"` lines into unique { name, version, license } entries. */
export function parseCargoTree(output) {
  const seen = new Map();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [pkg, licenseRaw = ''] = line.split('|');
    const m = pkg.trim().match(/^(\S+) v(\S+)/);
    if (!m) continue;
    const [, name, version] = m;
    // cargo marks packages it already printed with a trailing "(*)"; that is not part of the licence.
    const license = licenseRaw.replace(/\(\*\)/g, '').trim() || 'UNKNOWN';
    seen.set(`${name}@${version}`, { name, version, license, ecosystem: 'rust' });
  }
  return [...seen.values()];
}

/** Flatten `npm ls --all --json` into unique { name, version } entries (the root itself excluded). */
export function flattenNpmTree(tree) {
  const seen = new Map();
  const walk = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (node.version) seen.set(`${name}@${node.version}`, { name, version: node.version });
      walk(node.dependencies);
    }
  };
  walk(tree.dependencies);
  return [...seen.values()];
}

/** Normalise the many ways package.json spells a licence into one string. */
export function normaliseLicense(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (!l) return 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return l.type ?? 'UNKNOWN';
}

const hash = (text) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

/** Render the markdown: a summary table plus each distinct licence text once, listing who uses it. */
export function renderMarkdown({ entries, extra, generated, standard = {} }) {
  const all = [...extra, ...entries].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const lines = [
    '# Third-party licences',
    '',
    `Generated ${generated} by \`scripts/gen-licenses.mjs\` from the dependency trees that ship in the app (Rust crates and npm packages), plus the model and runtime.`,
    '',
    '## Summary',
    '',
    '| Component | Version | Licence | Source |',
    '|---|---|---|---|',
    ...all.map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.ecosystem} |`),
    '',
    '## Licence texts',
    '',
  ];
  const groups = new Map();
  for (const e of all) {
    if (!e.text) continue;
    const key = hash(e.text);
    if (!groups.has(key)) groups.set(key, { text: e.text, users: [] });
    groups.get(key).users.push(`${e.name} ${e.version}`);
  }
  let n = 1;
  for (const { text, users } of groups.values()) {
    lines.push(
      `### ${n++}. Used by: ${users.slice(0, 40).join(', ')}${users.length > 40 ? `, and ${users.length - 40} more` : ''}`,
      '',
      '```text',
      text.trim(),
      '```',
      '',
    );
  }
  const missing = all.filter((e) => !e.text).map((e) => `${e.name} ${e.version} (${e.license})`);
  if (missing.length) {
    lines.push(
      '## Components without a bundled licence file',
      '',
      'Their licence identifier is listed in the summary; the standard text for that identifier applies.',
      '',
    );
    lines.push(...missing.map((m) => `- ${m}`), '');
    const needed = Object.entries(standard).filter(([id]) => missing.some((m) => m.includes(id)));
    for (const [id, text] of needed) {
      lines.push(`### Standard ${id} text`, '', '```text', text.trim(), '```', '');
    }
  }
  return lines.join('\n');
}
