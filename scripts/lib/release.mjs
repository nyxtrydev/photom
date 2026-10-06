// Pure helpers for version bumping and changelog generation (tested in release.test.mjs).

/** Next semantic version for a bump type, or an explicit version. */
export function bump(current, kind) {
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(kind)) return kind;
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`not a semantic version: ${current}`);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (kind === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (kind === 'minor') [minor, patch] = [minor + 1, 0];
  else if (kind === 'patch') patch += 1;
  else throw new Error(`unknown bump "${kind}" (use major, minor, patch or an explicit x.y.z)`);
  return `${major}.${minor}.${patch}`;
}

/** Replace the version in Cargo.toml's [package] section only (not in dependencies). */
export function setCargoVersion(toml, version) {
  const lines = toml.split('\n');
  let inPackage = false;
  let done = false;
  return lines
    .map((line) => {
      if (/^\[.*\]\s*$/.test(line)) inPackage = line.trim() === '[package]';
      if (inPackage && !done && /^version\s*=/.test(line)) {
        done = true;
        return `version = "${version}"`;
      }
      return line;
    })
    .join('\n');
}

const TYPES = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
  test: 'Tests',
  chore: 'Maintenance',
};

/** Parse "feat(scope)!: subject" style commit subjects. Non-conventional subjects return null. */
export function parseCommit(subject) {
  const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/);
  if (!m) return null;
  const [, type, scope, bang, text] = m;
  return { type, scope: scope ?? null, breaking: !!bang, text };
}

/** Decide the bump implied by a list of commit subjects (breaking > feat > anything else). */
export function suggestedBump(subjects) {
  const parsed = subjects.map(parseCommit).filter(Boolean);
  if (parsed.some((c) => c.breaking)) return 'major';
  if (parsed.some((c) => c.type === 'feat')) return 'minor';
  return parsed.length ? 'patch' : null;
}

/** Markdown section for one release. Skips release/merge noise and non-conventional commits. */
export function renderRelease(version, date, subjects) {
  const groups = new Map();
  const breaking = [];
  for (const s of subjects) {
    const c = parseCommit(s);
    if (!c || /^(chore\(release\)|release)/.test(s)) continue;
    const line = `- ${c.scope ? `**${c.scope}:** ` : ''}${c.text}`;
    if (c.breaking) breaking.push(line);
    const title = TYPES[c.type] ?? 'Other';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(line);
  }
  const out = [`## ${version} (${date})`, ''];
  if (breaking.length) out.push('### Breaking changes', '', ...breaking, '');
  for (const title of [...Object.values(TYPES), 'Other']) {
    if (groups.has(title)) out.push(`### ${title}`, '', ...groups.get(title), '');
  }
  if (out.length === 2) out.push('- No notable changes.', '');
  return out.join('\n');
}

/** Insert a release section under the changelog header (newest first), replacing a same-version section. */
export function prependRelease(changelog, section, version) {
  const header =
    '# Changelog\n\nAll notable changes to Photom. Generated from conventional commits by `scripts/changelog.mjs`.\n\n';
  let body = changelog.startsWith('# Changelog')
    ? changelog.slice(
        changelog.indexOf('\n## ') >= 0 ? changelog.indexOf('\n## ') + 1 : changelog.length,
      )
    : changelog;
  const re = new RegExp(`## ${version.replace(/\./g, '\\.')} \\([^)]*\\)[\\s\\S]*?(?=\\n## |$)`);
  body = body.replace(re, '').replace(/^\n+/, '');
  return `${header}${section}\n${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
