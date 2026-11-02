'use strict';
// Export committed blobs only. Never copy a working directory or Git history.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const defaultOutput = path.join(root, 'public-release', 'ProjectHub');
const publicFiles = new Set([
  'README.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', 'THIRD_PARTY_NOTICES.zh-TW.md',
  'docs/idea-ledger.md', 'docs/idea-ledger-verification.md',
  'scripts/export-public.js', 'scripts/public.gitignore',
]);
const required = [...publicFiles, '.github/ISSUE_TEMPLATE/feedback.md',
  '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md', 'hub/package.json', 'hub/CHANGELOG.md',
  'hub/server.js', 'hub/mcp.js', 'hub/public/index.html',
  'hub/lib/langpack.js', 'hub/lib/locale.js', 'hub/lib/version-check.js', '.github/workflows/macos-app.yml'];
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
function packPath(name) {
  const match = /^langpacks\/([^/]+)\/(.+)$/.exec(name);
  return match && match[1] !== 'ja' && /^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/.test(match[1]) ? match : null;
}
function packAsset(name) {
  const match = packPath(name);
  if (!match) return false;
  const file = match[2];
  return ['pack.json', 'ui.json', 'backend.json', 'native.json', 'README.md'].includes(file)
    || /^(?:docs|templates|seed)\//.test(file) && /(?:\.(?:json|md|yaml|yml|txt)|\/\.gitkeep)$/.test(file)
    // Tests shipped with the repository are source code, never imported pack data.
    || file.startsWith('test/') && /\.(?:js|json|md|yaml|yml|txt)$/.test(file);
}
function excluded(name) {
  if (name.startsWith('hub/purchase-test-app/') || ['hub/test/purchase-test-app.test.js', 'hub/test/purchase-test-workspace.test.js', 'hub/test/purchase-test-update.test.js', 'hub/test/purchase-test-preparation.test.js', 'hub/test/release-mac-migration.test.js',
    'hub/test/windows-license-recovery.test.cjs', 'hub/test/fixtures/purchase-test-app-child.cjs'].includes(name)) return true;
  if (name.startsWith('hub/staging-app/') || ['hub/test/staging-app.test.js', 'hub/test/fixtures/staging-app-child.cjs',
    'hub/test/staging-app-lifecycle.test.js', 'hub/test/fixtures/staging-shutdown.swift'].includes(name)) return true;
  // Opt-in staging activation tools must never become public release entries.
  if (['hub/build-staging-paid-kit.cjs', 'hub/STAGING-PAID-CHECK.md', 'hub/test/staging-paid-acceptance.cjs',
    'hub/test/staging-paid-acceptance.test.js', 'hub/test/fixtures/staging-paid-child.cjs'].includes(name)) return true;
  if (name === 'hub/paid-bundle.json' || name.startsWith('hub/paid/') || name.startsWith('hub/public/paid/')) return true;
  // Local DMG acceptance uses the private publisher and macOS-only fixtures.
  if (['scripts/package-update.js', 'scripts/package-update-windows.js', 'scripts/sign-update.js', 'scripts/release-keychain.js', 'scripts/release-keychain.swift', 'scripts/release-license-build.sql', 'hub/test/release-candidate.test.js', 'hub/test/app-update-packaged.test.js', 'hub/test/app-update-windows.test.js'].includes(name)) return true;
  // Windows acceptance has an isolated private issuer fixture, never a release entry point.
  if (['hub/check-license.cmd', 'hub/WINDOWS-LICENSE.md', 'hub/build-windows-license-kit.cjs', 'hub/collect-license-result-v4.cjs',
    'hub/build-paid-license-kit.cjs', 'hub/test/paid-license-acceptance.cjs', 'hub/test/paid-license-acceptance.test.js', 'hub/test/fixtures/paid-license-child.cjs',
    'hub/test/windows-guard-diagnostics-v4.test.js', 'hub/test/windows-license-result-v4.test.js',
    'hub/test/windows-license-acceptance.cjs', 'hub/test/windows-license-storage.test.js', 'hub/test/windows-cache.test.js'].includes(name)) return true;
  if (name === 'hub/lib/license/owner-edition.js' || name.startsWith('hub/license-issuer/') ||
      name === 'hub/test/license.test.js' || name === 'hub/test/sandbox-local.test.js' || name === 'hub/test/fixtures/license-db.cjs') return true;
  const parts = name.split('/');
  if (parts.some(p => ['.git', 'node_modules', 'public-release', 'Inbox', '.DS_Store'].includes(p))) return true;
  // Skills belong to the recipient's AI installation, never the distributed runtime.
  if (parts.some(p => p.toLowerCase() === 'skills' || p.toLowerCase() === 'skill.md')) return true;
  if (parts.some(p => /^\.env(?:\.|$)/.test(p) && !['.env.example', '.env.sample'].includes(p)
    || /^(?:\.npmrc|\.dev\.vars(?:\..*)?|.*\.log|.*\.(?:pem|key))$/.test(p))) return true;
  // Only the templates and fictional seed may contain ledger metadata.
  if (parts.includes('.ai') && !name.startsWith('docs/project-hub/templates/project/.ai/')
    && !name.startsWith('hub/seed/') && !(packPath(name) && /^(?:seed\/|templates\/project\/\.ai\/)/.test(packPath(name)[2]))) return true;
  if (/\/\.ai\/(?:chat|handoff|work)(?:\/|$)/.test(name)) return true;
  if (parts.includes('_hub') && !name.startsWith('docs/project-hub/templates/_hub/')
    && !(packPath(name) && packPath(name)[2].startsWith('templates/_hub/'))) return true;
  if (name.includes('/.claude/') || name.includes('/.codex/')) return true;
  return false;
}
function selected(name, isPublic) {
  return isPublic ? publicFiles.has(name) || name === '.gitattributes' || name.startsWith('.github/ISSUE_TEMPLATE/')
    || name === '.github/pull_request_template.md' || name.startsWith('.github/PULL_REQUEST_TEMPLATE/')
    || name === '.github/workflows/macos-app.yml'
    : name.startsWith('hub/') || name.startsWith('docs/project-hub/templates/') || packAsset(name)
    || /^docs\/screenshots\/[^/]+-redacted\.png$/.test(name);
}
const rules = [
  ['local user', /\bk[k]minim4\b/i],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g],
  ['API token', /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['private service', /\bh[d]sl\b/i],
  ['private specialty material', /h[u]man[ _-]?design|ヒューマンデザイ[ン]|人[類类][圖图]|人[類类][設设][計计]|\bh[d]sl\b|\bb[g]5\b|reference-gate-librar[y]/i],
  ['Discord webhook', /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/],
  ['private IP', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['user path', /\/Users\/(?!me(?:[/'"\s]|$)|test(?:[/'"\s]|$)|example(?:[/'"\s]|$)|a(?:[/'"\s]|$))[A-Za-z0-9_.-]+/],
];
// Exact, reviewed non-secret literals; an exception never applies to another file.
const safeLiterals = {
  'hub/release-app/README.md': new Set(['info' + '@k-onedot.com']),
  'hub/lib/git.js': new Set(['git' + '@github.com']),
  'hub/lib/update-check.js': new Set(['claude-code' + '@latest.json']),
  'hub/test/accounts.test.js': new Set(['a' + '@example.test']),
  'hub/test/move.test.js': new Set(['a' + '@example.test']),
  'hub/test/git.test.js': new Set(['git' + '@github.com', 'secret' + '@github.com']),
  'hub/test/github.test.js': new Set(['password' + '@github.com', 'git' + '@github.com']),
  'hub/test/remote.test.js': new Set(['owner' + '@example.com', 'guest' + '@example.com']),
  'hub/test/procwatch.test.js': new Set(['sk-' + 'abcdefghijklmnop']),
};
// This exact synthetic rejection fixture contains a header and the word
// "synthetic", never key material. Any change requires a fresh review.
const reviewedSecretFixtures = {
  'hub/test/legacy-import.test.js': '91a61563d713e17a81c680d111b0c6d231360154d45e8cee53cc91455ab9c8cc',
};
const reviewedWindowsIcon = { path: 'hub/app/windows/ProjectHub.ico', sha256: '757b92279f649abe7f4e9a0ded4540d0bd58df1caf8c9eb9436390d6cb4764bd' };
const reviewedImages = new Set([
  'docs/screenshots/conversation-redacted.png', 'docs/screenshots/queued-instructions-redacted.png',
  'hub/app/icon-concept.png', 'hub/public/icon.png',
]);
// Official NuGet 1.0.4258.31 bytes, reviewed for the Windows shell only.
// A different path/version/content must go through a new review.
const webviewPrefix = 'hub/app/windows/vendor/webview2/1.0.4258.31/';
const reviewedWebview = {
  'Microsoft.Web.WebView2.Core.dll': 'd60e6e94245078cb56e44ebd5f360dc04bf18e460136be93bfc4cfca43b98505',
  'Microsoft.Web.WebView2.WinForms.dll': '6a9e6856f23c463783c3afb0ca5d78f56324c86657162ccb16d5227b3233b32a',
  'WebView2Loader.dll': '3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee',
};
const digest = content => createHash('sha256').update(content).digest('hex');
function inspect(entries) {
  const findings = [];
  if (entries.some(e => e.name.startsWith(webviewPrefix) && /\.dll$/i.test(e.name))) {
    const license = entries.find(e => e.name === webviewPrefix + 'LICENSE.txt');
    if (!license || digest(license.content) !== '0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55') findings.push('WebView2: original license missing or changed');
    const notices = entries.find(e => e.name === 'THIRD_PARTY_NOTICES.md');
    if (!notices || !notices.content.toString().includes(webviewPrefix + 'LICENSE.txt')) findings.push('WebView2: copyright notice missing');
  }
  for (const { name, content } of entries) {
    if (excluded(name) || name === '.git') findings.push(`${name}: excluded path`);
    const specialty = rules.find(([label]) => label === 'private specialty material')[1];
    if (specialty.test(name.normalize('NFC'))) findings.push(`${name}: private specialty path`);
    // Raster images are the reviewed redacted screenshots and product icons.
    if (reviewedImages.has(name)) continue;
    if (name === reviewedWindowsIcon.path) {
      if (digest(content) !== reviewedWindowsIcon.sha256) findings.push(`${name}: reviewed product icon changed`);
      continue;
    }
    const sdkHash = name.startsWith(webviewPrefix) && reviewedWebview[name.slice(webviewPrefix.length)];
    if (sdkHash) {
      if (digest(content) !== sdkHash) findings.push(`${name}: reviewed Microsoft binary changed`);
      continue;
    }
    if (/\.(?:png|jpe?g|gif|webp|heic|pdf)$/i.test(name)
      || !Buffer.from(content.toString('utf8')).equals(content)) {
      findings.push(`${name}: binary file needs review`);
      continue;
    }
    const text = content.toString('utf8').normalize('NFC');
    for (const [label, re] of rules) {
      if (label === 'private key' && reviewedSecretFixtures[name] === digest(content)) continue;
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
function main({ args = process.argv.slice(2), output = defaultOutput } = {}) {
  let ref = 'HEAD', publicRef;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !['--ref', '--public-ref'].includes(args[i])) throw new Error('Usage: node scripts/export-public.js [--ref commit] [--public-ref commit]');
    if (args[i] === '--ref') ref = args[i + 1]; else publicRef = args[i + 1];
  }
  const source = commit(ref), overlay = commit(publicRef || ref);
  const entries = [];
  for (const [sha, isPublic] of [[source, false], [overlay, true]]) {
    const tracked = tree(sha);
    const packs = new Set();
    if (!isPublic) for (const entry of tracked.filter(e => packPath(e.name)?.[2] === 'pack.json')) {
      try {
        if (entry.type === 'blob' && entry.mode === '100644'
          && JSON.parse(git(['cat-file', 'blob', entry.oid])).id === packPath(entry.name)[1]) packs.add(packPath(entry.name)[1]);
      } catch { /* Invalid folders are not language packs. */ }
    }
    for (const entry of tracked) {
      if (!selected(entry.name, isPublic) || excluded(entry.name)) continue;
      if (entry.name.startsWith('langpacks/') && !packs.has(packPath(entry.name)?.[1])) continue;
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
  const checked = require('../hub/lib/version-check').checkVersion(name => { const e=entries.find(e=>e.name===name);if(!e)throw Error('Missing version file: '+name);return e.content.toString(); });
  if(!checked.ok)throw Error('Public version mismatch: '+checked.error);
  const version = checked.version;
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
  console.log(`Exported ${entries.length} files to ${path.relative(root, output)} (no Git history).`);
  console.log(`Source: ${source}; public documents: ${overlay}; version: ${version}; inspection: 0 findings.`);
}
if (require.main === module) main();
module.exports = { excluded, selected, inspect, main };
