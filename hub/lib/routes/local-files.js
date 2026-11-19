'use strict';

const { createMockupAssets, readMockupFile } = require('../mockup-assets');

module.exports = function localfilesRoutes(ctx) {
  const { send, lt, resolvePlace, viewInfo, fs, documentHtml, fromRemote, record, store, expandHome, denied, launch, DRY, path, platform, protect, mockupAudience } = ctx;
  const mockupAssets = createMockupAssets({ protect });
  return {
    view: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/file/view',
      async handle(req, res, url) {
        const b = Object.fromEntries(url.searchParams);
        const unavailable = { error: lt('このファイルを表示できません。Macで開いてください。') };
        if (b.mockup !== undefined) {
          const asset = mockupAssets.read(b.mockup, b.asset, mockupAudience(req));
          return asset ? send(res, 200, asset) : send(res, 404, unavailable);
        }
        const { target } = resolvePlace(b), info = viewInfo(target);
        if (info.status !== 200) return send(res, info.status, unavailable);
        if (info.kind === 'mockup') {
          const audience = mockupAudience(req);
          if (!audience) return send(res, 403, unavailable);
          let fd, html, mockup;
          try {
            fd = fs.openSync(info.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            html = readMockupFile(fd, info.stat, info.limit).toString('utf8');
            mockup = mockupAssets.issue(info.path, audience, info.stat);
          } catch { return send(res, 415, unavailable); }
          finally { if (fd !== undefined) fs.closeSync(fd); }
          if (fromRemote()) record('fileview', b, { path: target, kind: info.kind });
          return send(res, 200, { html, mockup });
        }
        // 実体確認後は同じファイルを配信する。最終要素のリンクへの置換も断る。
        let fd, stat;
        try {
          fd = fs.openSync(info.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > info.limit || stat.dev !== info.stat.dev || stat.ino !== info.stat.ino) {
            fs.closeSync(fd);
            return send(res, 415, unavailable);
          }
        } catch (e) {
          if (fd !== undefined) fs.closeSync(fd);
          return send(res, ['EPERM', 'EACCES'].includes(e.code) ? 403 : 404, unavailable);
        }
        const headers = { 'Content-Type': info.type, 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' };
        if (info.kind === 'doc') {
          let html;
          try { html = await documentHtml(fd, info, stat.size); }
          catch (e) { return send(res, e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 500 : 415, unavailable); }
          finally { fs.closeSync(fd); }
          headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
          headers['Content-Length'] = Buffer.byteLength(html);
          if (fromRemote()) record('fileview', b, { path: target, kind: info.kind });
          res.writeHead(200, headers);
          return res.end(html);
        }
        // iOSのPDF表示が要求する単一byte rangeも同じfdから返す。
        let begin = 0, end = stat.size - 1, status = 200;
        if (info.kind === 'pdf') {
          headers['Accept-Ranges'] = 'bytes';
          if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (match && (match[1] || match[2])) {
              begin = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
              end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
            } else begin = -1;
            if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin > end || begin >= stat.size) {
              fs.closeSync(fd); res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); return res.end();
            }
            status = 206; headers['Content-Range'] = `bytes ${begin}-${end}/${stat.size}`;
          }
        }
        if (fromRemote()) record('fileview', b, { path: target, kind: info.kind });
        res.writeHead(status, { ...headers, 'Content-Length': Math.max(0, end - begin + 1) });
        if (!stat.size) { fs.closeSync(fd); return res.end(); }
        const stream = fs.createReadStream(info.path, { fd, autoClose: true, start: begin, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        return stream.pipe(res);
      },
    },
    open: {
      matches: (req, url) => url.pathname === '/api/open',
      async handle(req, res, url, b) {
        const p = store.readProject(b.project);
        if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
        let target = null;
        if (b.kind === 'project') target = p.dir;
        else if (b.kind === 'folder') target = (p.folders.find(f => f.label === b.label) || {}).path;
        else if (b.kind === 'workdir') { const f = store.taskFile(b.project, b.task); target = f && store.readTask(f).workdir; }
        target = expandHome(target || '');
        if (!target || !fs.existsSync(target)) return send(res, 404, { error: lt('その場所が見つかりません'), path: target });
        if (denied(target)) return send(res, 403, { error: denied(target), path: target });
        const r = await launch.openFolder(target, DRY);
        return send(res, 200, { ok: true, path: target, ...(DRY ? { r } : {}) });
      },
    },
    reveal: {
      matches: (req, url) => url.pathname === '/api/reveal',
      async handle(req, res, url, b) {
        const { target, home } = resolvePlace(b);
        const isDir = fs.statSync(target).isDirectory();
        // info＝開かず種類と場所を返す／list＝フォルダの中身／open＝元ファイルを既定アプリで開く／finder＝Finderで表示
        const how = ['info', 'list', 'open'].includes(b.how) ? b.how : 'finder';
        if (how === 'info') {
          const info = viewInfo(target), view = info.status === 200;
          return send(res, 200, { ok: true, path: target, dir: isDir, how, view, viewKind: view ? info.kind : '', remote: fromRemote() });
        }
        if (how === 'list' && isDir) {
          let entries = [];
          try {
            entries = fs.readdirSync(target, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 500)
              .map(d => { const full = path.join(target, d.name); let st = null; try { st = fs.statSync(full); } catch (e) { /* 読めない物 */ } return { name: d.name, path: full, dir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }; })
              .sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name, 'ja') : x.dir ? -1 : 1));
          } catch (e) { return send(res, 403, { error: denied(target) || String(e.message) }); }
          const up = path.dirname(target);
          return send(res, 200, { ok: true, path: target, dir: true, entries, parent: home.some(h => up === h || up.startsWith(h + path.sep)) ? up : '' });
        }
        record('reveal', { project: b.project, task: b.task }, { path: target, dir: isDir, how, app: Boolean(b.app) });
        const act = how === 'list' ? 'open' : how; // ファイルに list が来たら開く
        // アプリの中では、アプリ自身が開く（許可がアプリに付いているため）。ブラウザの時は本体が open で開く
        if (b.app) return send(res, 200, { ok: true, path: target, dir: isDir, byApp: true, how: act });
        const r = act === 'open' || isDir ? await launch.openFolder(target, DRY) : await launch.revealFile(target, DRY);
        return send(res, 200, { ok: true, path: target, dir: isDir, how: act, ...(DRY ? { r } : {}) });
      },
    },
    url: {
      matches: (req, url) => url.pathname === '/api/open-url',
      async handle(req, res, url, b) {
        const u = String(b.url || '');
        if (!/^https?:\/\/[^\s]+$/.test(u)) return send(res, 400, { error: lt('開けない URL です') });
        const r = await launch.openUrl(u, DRY);
        return send(res, 200, { ok: true, ...(DRY ? { r } : {}) });
      },
    },
    pick: {
      matches: (req, url) => url.pathname === '/api/pick-folder',
      handle(req, res, url, b) {
        if (DRY) return send(res, 200, { path: '' });
        platform.pickFolder(b.prompt, selected => send(res, 200, { path: selected }));
        return undefined;
      },
    },
  };
};
