'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TRUST = require('./update-trust');
const { sha, unpack } = require('./update-zip');
const { lt } = require('./locale');

const OFFICIAL_PACKS = [
  { id: 'en', name: 'English' },
  { id: 'zh-TW', name: '繁體中文' },
];
const CHECKSUMS = 'SHA256SUMS.txt';
const LATEST = new URL('./', TRUST.feedUrl).href;
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
const ARCHIVE_LIMIT = 8 * 1024 * 1024;
const problem = (status, message) => Object.assign(Error(lt(message)), { status });
const unavailable = () => problem(404, '今の版に対応する公式言語パックが見つかりませんでした。');

async function receive(base, name, limit, fetcher) {
  let url = new URL(name, base);
  let release = base === LATEST ? null : base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const response = await fetcher(url.href, {
        credentials: 'omit', redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'ProjectHub' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw Error('missing redirect');
        url = new URL(location, url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw Error('unexpected URL');
        if (!release && url.href.startsWith(TRUST.assetPrefix)) {
          const [tag, file, ...extra] = url.href.slice(TRUST.assetPrefix.length).split('/');
          if (!VERSION_TAG.test(tag) || file !== name || extra.length) throw Error('unexpected release');
          release = TRUST.assetPrefix + tag + '/';
        } else if (!release || !TRUST.redirectHosts.includes(url.hostname)) {
          throw Error('unexpected redirect');
        }
        continue;
      }
      if (response.status !== 200 || !release || !response.body || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        if (response.status === 404) return null;
        throw Error('unexpected response');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw Error('download too large');
        chunks.push(chunk);
      }
      return { release, bytes: Buffer.concat(chunks) };
    }
    throw Error('too many redirects');
  } catch {
    throw problem(502, '公式配布先から取得できませんでした。通信を確認してもう一度お試しください。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function findAsset(versionTag, name, fetcher) {
  for (const base of [TRUST.assetPrefix + versionTag + '/', LATEST]) {
    // Windows packs can be listed under a combined Mac/Windows release.
    const sums = await receive(base, CHECKSUMS, 128 * 1024, fetcher);
    if (!sums) continue;
    const matches = sums.bytes.toString('utf8').split(/\r?\n/)
      .map(line => /^([a-f0-9]{64}) [ *](.+)$/i.exec(line))
      .filter(row => row?.[2] === name);
    if (matches.length === 1) return { release: sums.release, digest: matches[0][1].toLowerCase() };
    if (matches.length > 1) throw problem(422, '公式言語パックの照合に失敗しました。');
  }
  throw unavailable();
}

async function installOfficialPack(root, version, id, langpacks, fetcher = globalThis.fetch) {
  if (!OFFICIAL_PACKS.some(pack => pack.id === id)) throw problem(400, '公式言語パックの指定が不正です。');
  const tag = 'v' + version;
  if (!VERSION_TAG.test(tag)) throw unavailable();
  const available = () => langpacks.packSettings(root, version).available.includes(id);
  if (available()) return;

  const name = `Project-Hub-${version}-Language-Pack-${id}.zip`;
  const { release, digest } = await findAsset(tag, name, fetcher);
  const asset = await receive(release, name, ARCHIVE_LIMIT, fetcher);
  if (!asset) throw unavailable();
  if (sha(asset.bytes) !== digest) throw problem(422, '公式言語パックの照合に失敗しました。');
  // A manual import in another settings window may have finished during download.
  if (available()) return;

  const stage = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-langpack-'));
  const extract = path.join(stage, 'pack');
  const directory = path.join(extract, id);
  try {
    try {
      unpack(asset.bytes, extract, {
        allowAscii: true, maxEntryBytes: 5 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, maxEntries: 5000,
        acceptEntry: (name, isDir) => name.startsWith(id + '/') || (name === id && isDir),
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'pack.json'), 'utf8'));
      if (manifest?.id !== id || manifest.verifiedWith !== version) throw Error('pack mismatch');
    } catch {
      throw problem(422, '公式言語パックの言語、対応する版、またはファイル形式を確認できませんでした。');
    }
    langpacks.importPack(root, directory);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { OFFICIAL_PACKS, installOfficialPack };
