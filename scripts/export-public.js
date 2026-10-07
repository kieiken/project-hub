'use strict';
// Export committed blobs only. Never copy a working directory or Git history.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public-release', 'ProjectHub');
const publicFiles = new Set([
  'README.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', 'THIRD_PARTY_NOTICES.zh-TW.md',
  'scripts/export-public.js', 'scripts/public.gitignore',
]);
const required = [...publicFiles, '.github/ISSUE_TEMPLATE/feedback.md',
  '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md', 'hub/package.json', 'hub/CHANGELOG.md',
  'hub/server.js', 'hub/mcp.js', 'hub/public/index.html',
  'hub/locales/zh-TW.json', 'hub/lib/locale.js', '.github/workflows/macos-app.yml'];
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
function commit(ref) {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim();
}
function tree(ref) {
  return git(['ls-tree', '-rz', '--full-tree', ref]).toString().split('\0').filter(Boolean).map(row => {
    const split = row.indexOf('\t');
    const meta = row.slice(0, split), name = row.slice(split + 1);
    const [mode, type, oid] = meta.split(' ');
    return { name, mode, type, oid };
  });
}
function excluded(name) {
  const parts = name.split('/');
  if (parts.some(p => ['.git', 'node_modules', 'public-release', 'Inbox', '.DS_Store'].includes(p))) return true;
  if (parts.some(p => /^\.env(?:\.|$)/.test(p) && !['.env.example', '.env.sample'].includes(p)
    || /^(?:\.npmrc|\.dev\.vars(?:\..*)?|.*\.log|.*\.(?:pem|key))$/.test(p))) return true;
  // Only the templates and fictional seed may contain ledger metadata.
  if (parts.includes('.ai') && !name.startsWith('docs/project-hub/templates/project/.ai/')
    && !name.startsWith('docs/project-hub/templates/zh-TW/project/.ai/')
    && !name.startsWith('hub/seed/') && !name.startsWith('hub/seed-zh-TW/')) return true;
  if (/\/\.ai\/(?:chat|handoff|work)(?:\/|$)/.test(name)) return true;
  if (parts.includes('_hub') && !name.startsWith('docs/project-hub/templates/_hub/')
    && !name.startsWith('docs/project-hub/templates/zh-TW/_hub/')) return true;
  if (name.includes('/.claude/') || name.includes('/.codex/')) return true;
  return false;
}
function selected(name, isPublic) {
  return isPublic ? publicFiles.has(name) || name.startsWith('.github/ISSUE_TEMPLATE/')
    || name === '.github/pull_request_template.md' || name.startsWith('.github/PULL_REQUEST_TEMPLATE/')
    || name === '.github/workflows/macos-app.yml'
    : name.startsWith('hub/') || name.startsWith('docs/project-hub/templates/')
    || /^docs\/screenshots\/[^/]+-redacted\.png$/.test(name);
}
const rules = [
  ['local user', /\bk[k]minim4\b/i],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g],
  ['API token', /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['private service', /\bh[d]sl\b/i],
  ['Discord webhook', /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/],
  ['private IP', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['user path', /\/Users\/(?!me(?:[/'"\s]|$)|test(?:[/'"\s]|$)|example(?:[/'"\s]|$)|a(?:[/'"\s]|$))[A-Za-z0-9_.-]+/],
];
// Exact, reviewed non-secret literals; an exception never applies to another file.
const safeLiterals = {
  'hub/lib/git.js': new Set(['git' + '@github.com']),
  'hub/lib/update-check.js': new Set(['claude-code' + '@latest.json']),
  'hub/test/accounts.test.js': new Set(['a' + '@example.test']),
  'hub/test/git.test.js': new Set(['git' + '@github.com', 'secret' + '@github.com']),
  'hub/test/github.test.js': new Set(['password' + '@github.com']),
  'hub/test/remote.test.js': new Set(['owner' + '@example.com', 'guest' + '@example.com']),
  'hub/test/procwatch.test.js': new Set(['sk-' + 'abcdefghijklmnop']),
};
const reviewedImages = new Set([
  'docs/screenshots/conversation-redacted.png', 'docs/screenshots/queued-instructions-redacted.png',
  'hub/app/icon-concept.png', 'hub/public/icon.png',
]);
function inspect(entries) {
  const findings = [];
  for (const { name, content } of entries) {
    if (excluded(name) || name === '.git') findings.push(`${name}: excluded path`);
    // Raster images are the reviewed redacted screenshots and product icons.
    if (reviewedImages.has(name)) continue;
    if (/\.(?:png|jpe?g|gif|webp|heic|pdf)$/i.test(name)
      || !Buffer.from(content.toString('utf8')).equals(content)) {
      findings.push(`${name}: binary file needs review`);
      continue;
    }
    const text = content.toString('utf8');
    for (const [label, re] of rules) {
      re.lastIndex = 0;
      const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
      if (matches.some(m => !safeLiterals[name]?.has(m[0]) && !(label === 'GitHub token'
        && (name === 'hub/test/github.test.js' && /^gh[p]_TESTONLY0123456789$/.test(m[0])
          || name === 'hub/test/github-api.test.js' && /^gh[p]_MOCK_ONLY$/.test(m[0]))))) findings.push(`${name}: ${label}`);
    }
  }
  if (findings.length) throw new Error(`Public inspection failed (${findings.length}):\n${findings.join('\n')}`);
}
function readOutput(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const name = prefix + e.name;
    if (e.isDirectory()) return readOutput(path.join(dir, e.name), name + '/');
    if (!e.isFile()) throw new Error(`Not a regular exported file: ${name}`);
    return [{ name, content: fs.readFileSync(path.join(dir, e.name)) }];
  });
}
function main() {
  const args = process.argv.slice(2);
  let ref = 'HEAD', publicRef;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !['--ref', '--public-ref'].includes(args[i])) throw new Error('Usage: node scripts/export-public.js [--ref commit] [--public-ref commit]');
    if (args[i] === '--ref') ref = args[i + 1]; else publicRef = args[i + 1];
  }
  const source = commit(ref), overlay = commit(publicRef || ref);
  const entries = [];
  for (const [sha, isPublic] of [[source, false], [overlay, true]]) {
    for (const entry of tree(sha)) {
      if (!selected(entry.name, isPublic) || excluded(entry.name)) continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Not a regular tracked file: ${entry.name}`);
      let content = git(['cat-file', 'blob', entry.oid]);
      if (entry.name === 'hub/CHANGELOG.md') {
        const text = content.toString('utf8');
        const legacy = [...text.matchAll(/^## (\d+)\.(\d+)\.(\d+).*$/gm)]
          .find(m => Number(m[1]) < 4 || (Number(m[1]) === 4 && Number(m[2]) < 20));
        content = Buffer.from(legacy ? text.slice(0, legacy.index).trimEnd() + '\n' : text);
      }
      entries.push({ name: entry.name, content, mode: parseInt(entry.mode, 8) & 0o777 });
    }
  }
  for (const name of required) if (!entries.some(e => e.name === name)) throw new Error(`Missing required public file: ${name}`);
  entries.push({ name: '.gitignore', content: entries.find(e => e.name === 'scripts/public.gitignore').content, mode: 0o644 });
  const version = JSON.parse(entries.find(e => e.name === 'hub/package.json').content).version;
  const changelog = entries.find(e => e.name === 'hub/CHANGELOG.md').content.toString();
  const readme = entries.find(e => e.name === 'README.md').content.toString();
  if (changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1] !== version
    || !readme.includes(`開発中の版です（v${version}）`) || !readme.includes(`現行版（${version}）`)) throw new Error('Public version mismatch');
  inspect(entries);
  // Build and inspect a sibling staging folder before replacing a previous export.
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.staging-'));
  for (const { name, content, mode } of entries) {
    const target = path.join(stage, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode });
  }
  const written = readOutput(stage);
  inspect(written);
  if (written.length !== entries.length) throw new Error('Export file count mismatch');
  if (fs.existsSync(output)) {
    const previous = path.join(parent, '.previous');
    fs.mkdirSync(previous, { recursive: true });
    fs.renameSync(output, path.join(previous, `ProjectHub-${Date.now()}`));
  }
  fs.renameSync(stage, output);
  console.log(`Exported ${entries.length} files to public-release/ProjectHub (no Git history).`);
  console.log(`Source: ${source}; public documents: ${overlay}; version: ${version}; inspection: 0 findings.`);
}
if (require.main === module) main();
module.exports = { excluded, selected, inspect };
