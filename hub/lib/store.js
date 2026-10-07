'use strict';
const { lt, sectionNames, sectionName } = require('./locale');
// 台帳（Product/<プロジェクト>/PROJECT.md）と作業ファイル（.ai/tasks/<作業ID>.md）の読み書き
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { parseDoc, parseYaml, setScalar, scalar } = require('./frontmatter');
const { Completion, hash } = require('./completion');

const SAFE_NAME = /^[^/\\\0]+$/;

function expandHome(p) {
  if (!p || typeof p !== 'string') return '';
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 読んで分けた結果の使い回し：ファイルの更新時刻と大きさが前と同じなら、読み直さずに前の結果を使う
// （一覧は15秒ごとに全ファイルを読んでいた。台帳が多い時や書類フォルダ（iCloud）が遅い時に重かったため）
const parsedFiles = new Map();
function cachedParse(file, build) {
  let st;
  try { st = fs.statSync(file); } catch { parsedFiles.delete(file); return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = parsedFiles.get(file);
  if (hit && hit.key === key) return hit.value;
  const text = read(file);
  if (text === null) { parsedFiles.delete(file); return null; }
  const value = build(text);
  if (parsedFiles.size > 5000) parsedFiles.clear();
  parsedFiles.set(file, { key, value });
  return value;
}

// 意味の要約は書き手が作る。原文と完全に一致する、検査済みの要約だけを使う。
const ISSUE_STATES = new Set(['未解決', '確認待ち', '判断待ち', '解決済み', '履歴']);
function issueSummaries(file) {
  return cachedParse(file, text => {
    let doc;
    try { doc = JSON.parse(text); } catch { return new Map(); }
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const summaries = new Map(), seen = new Set();
    for (const item of items) {
      if (!item || typeof item.hash !== 'string' || !/^[a-f0-9]{16}$/.test(item.hash)) continue;
      // 同じ原文への重複指定は、どちらが最新か推測せず使わない。
      if (seen.has(item.hash)) { summaries.delete(item.hash); continue; }
      seen.add(item.hash);
      if (typeof item.title !== 'string' || !item.title.trim() || Array.from(item.title).length > 30
        || /[\r\n]/.test(item.title) || !ISSUE_STATES.has(item.state)
        || typeof item.next !== 'string' || Array.from(item.next).length > 50 || /[\r\n]/.test(item.next)
        || !['', '人', 'AI'].includes(item.who)) continue;
      summaries.set(item.hash, { title: item.title, state: item.state, next: item.next, who: item.who });
    }
    return summaries;
  }) || new Map();
}

function withIssueSummaries(issues, file) {
  const summaries = issueSummaries(file);
  return (Array.isArray(issues) ? issues : []).filter(i => typeof i === 'string' ? !!i : i && typeof i.text === 'string' && !!i.text).map(i => {
    const text = typeof i === 'string' ? i : i.text;
    const summary = summaries.get(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16));
    if (typeof i === 'string') return summary ? { text, summary: { ...summary } } : i;
    // キャッシュと PROJECT.md 側の形式を変更せず、summary は別ファイルからだけ採用する。
    const { summary: ignored, ...original } = i;
    return summary ? { ...original, summary: { ...summary } } : original;
  });
}

// 本文の「## 見出し」ごとに分ける
function sections(body) {
  const out = {};
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; out[cur] = []; continue; }
    if (cur && line.trim() && !line.trim().startsWith('<!--')) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

// 台帳の本文（先頭の --- の後）から、見出しとコメントを除いたメモ
function projectNotes(body) {
  return body.split(/\r?\n/).filter(l => l.trim() && !/^#\s/.test(l) && !l.trim().startsWith('<!--')).join('\n').trim();
}

// 「## 手順」のチェック欄（- [ ] / - [x]）を読む
const STEP = /^\s*[-*]\s+\[([ xX])\]\s+(\S.*)$/;
function readSteps(body) {
  const out = [];
  let inside = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inside = /^##\s+(?:手順|步驟)/.test(line); continue; }
    const m = inside && line.match(STEP);
    if (m) out.push({ text: m[2].trim(), done: m[1] !== ' ' });
  }
  return out;
}
const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();

// PROJECT.md の phases の1つの state を書き換える（{ name: X, state: Y } の形と、名前・state が別の行の形）
function setPhaseLine(text, name, state) {
  const lines = text.split('\n');
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flow = new RegExp('^\\s*-\\s*\\{.*\\bname:\\s*' + esc + '\\s*[,}]');
  const block = new RegExp('^(\\s*)-\\s*name:\\s*' + esc + '\\s*$');
  for (let i = 0; i < lines.length; i++) {
    if (flow.test(lines[i])) {
      lines[i] = /\bstate:/.test(lines[i]) ? lines[i].replace(/\bstate:\s*[^,}]*/, `state: ${state} `).replace(/ +([,}])/, ' $1') : lines[i].replace(/\s*\}\s*$/, `, state: ${state} }`);
      return lines.join('\n');
    }
    const b = lines[i].match(block);
    if (b) {
      for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && /^\s+\S/.test(lines[j]); j++) {
        if (/^\s*state:/.test(lines[j])) { lines[j] = lines[j].replace(/state:.*$/, `state: ${state}`); return lines.join('\n'); }
      }
      lines.splice(i + 1, 0, `${b[1]}  state: ${state}`);
      return lines.join('\n');
    }
  }
  return text;
}

function pick(secs, word) {
  const k = Object.keys(secs).find(s => sectionNames(word).some(name=>s.includes(name)));
  return k ? secs[k] : '';
}

class Store {
  constructor(root) {
    this.root = root;
    this.product = path.join(root, 'Product');
    this.completion = new Completion(root, c => {
      let ids = []; try { ids = fs.readdirSync(this.product); } catch (e) { /* 初回 */ }
      for (const id of ids) {
        const dir = this.projectDir(id); if (!dir) continue;
        const data = parseDoc(read(path.join(dir, 'PROJECT.md')) || '').data;
        c.data.projects[id] = { ...(data.status === '完了' ? { status: 'migrated' } : {}), phases: Object.fromEntries((Array.isArray(data.phases) ? data.phases : []).filter(ph => ph && ph.state === '完了').map(ph => [ph.name, 'migrated'])) };
        let files = []; try { files = fs.readdirSync(path.join(dir, '.ai/tasks')); } catch (e) { /* 作業なし */ }
        for (const name of files.filter(n => n.endsWith('.md') && !/^[_.]/.test(n))) {
          const text = read(path.join(dir, '.ai/tasks', name));
          if (parseDoc(text || '').data.state === '完了') c.data.tasks[`${id}/${name.slice(0, -3)}`] = { hash: hash(text), at: 'migrated' };
        }
      }
    });
  }

  projectDir(id) {
    if (!SAFE_NAME.test(id || '') || id === '.' || id === '..') return null;
    // 常設枠は大小文字で別の会話・再開キーを作らない。
    if (require('./freetalk').hasTarget(id, true)) return null;
    const dir = path.join(this.product, id);
    return fs.existsSync(path.join(dir, 'PROJECT.md')) ? dir : null;
  }

  taskFile(projectId, taskId) {
    const dir = this.projectDir(projectId);
    if (!dir || !SAFE_NAME.test(taskId || '') || taskId.startsWith('_') || taskId.startsWith('.')) return null;
    const f = path.join(dir, '.ai', 'tasks', taskId + '.md');
    return fs.existsSync(f) ? f : null;
  }

  readTask(file) {
    const c = cachedParse(file, text => {
      const { data, body } = parseDoc(text);
      const steps = readSteps(body);
      return { text, data, secs: sections(body), steps, fingerprint: hash(text), stepsHash: hash(JSON.stringify(steps)) };
    }) || { text: '', data: {}, secs: {}, steps: [], fingerprint: hash(''), stepsHash: hash('[]') };
    const { data, secs, text } = c;
    const steps = c.steps.map(x => ({ ...x }));
    const id = path.basename(file, '.md');
    return {
      id,
      title: data.title || id,
      ...(data.freetalk === true ? { freetalk: true } : {}),
      role: data.role || '',
      owner: data.owner || '',
      ...this.completion.task(`${path.basename(path.dirname(path.dirname(path.dirname(file))))}/${id}`, data.state, text, steps, c),
      ...(data.freetalk === true ? { state: data.state === '返事待ち' ? '返事待ち' : data.state === '未着手' ? '未着手' : '実行中', completionPending: false } : {}),
      question: data.question || '',
      workdir: data.workdir || '',
      mergeExcluded: data.mergeExcluded === true,
      model: data.model || '',
      parent: data.parent || '',
      kind: data.kind === 'derived' ? 'derived' : 'main',
      derivedFrom: data.derivedFrom || '',
      workspaceMode: data.workspaceMode === 'direct' ? 'direct' : 'isolated',
      workspaceStarted: data.workspaceStarted || '',
      effort: data.effort || '',
      phase: data.phase || '',
      via: data.via || '',
      steps,
      skills: Array.isArray(data.skills) ? data.skills.filter(Boolean) : [],
      updated: data.updated || '',
      done: pick(secs, 'やったこと'),
      next: pick(secs, '次にやること'),
      note: pick(secs, '注意'),
      memo: pick(secs, 'メモ'),
    };
  }

  readProject(id) {
    const dir = this.projectDir(id);
    if (!dir) return null;
    const c = cachedParse(path.join(dir, 'PROJECT.md'), text => { const { data, body } = parseDoc(text); return { data, notes: projectNotes(body), textHash: hash(text) }; })
      || { data: {}, notes: '', textHash: hash('') };
    const { data } = c;
    const tdir = path.join(dir, '.ai', 'tasks');
    let tasks = [];
    try {
      tasks = fs.readdirSync(tdir)
        .filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
        .map(f => this.readTask(path.join(tdir, f)))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    } catch { /* 作業ファイルなし */ }
    const folders = data.folders && typeof data.folders === 'object' && !Array.isArray(data.folders) ? data.folders : {};
    return {
      id,
      dir,
      name: data.name || id,
      ...(data.kind === 'freetalk' ? { kind: 'freetalk' } : {}),
      ...this.completion.project(id, data),
      ...(data.kind === 'freetalk' ? { status: '進行中', phases: [] } : {}),
      completionHash: c.textHash,
      phaseContinueKey: this.completion.data.projects[id]?.continued || '',
      phaseOfferKey: hash(JSON.stringify(tasks.map(t => [t.id,t.state,t.phase,t.steps]))),
      parent: data.parent || '',
      derivedFrom: data.derivedFrom || '',
      description: data.description || '',
      notes: c.notes,
      updated: data.updated || '',
      folders: Object.entries(folders).filter(([, v]) => v).map(([label, p]) => ({ label, path: p })),
      related: Array.isArray(data.related) ? data.related.filter(Boolean) : [],
      issues: withIssueSummaries(data.issues, path.join(dir, '.ai', 'issues-summary.json')),
      chats: Array.isArray(data.chats) ? data.chats.filter(Boolean) : [],
      tasks,
    };
  }

  // 新しいプロジェクト：ひな形（CLAUDE.md・AGENTS.md・.ai/ など）を写し、台帳を書く
  createProject({ name, description, body, phases, parent, derivedFrom, related, refs }, templateDir) {
    const nm = oneLine(name).replace(/[\/\\\0]/g, '・').slice(0, 60);
    if (!nm || nm === '.' || nm === '..' || nm.startsWith('.') || nm.startsWith('_')) return { error: lt('プロジェクト名を入れてください') };
    if (require('./freetalk').hasTarget((Array.isArray(related) ? related : String(related || '').split(/[,、\n]/)).map(oneLine))) return { error: require('./freetalk').PROTECTED };
    if (nm.toLowerCase() === 'freetalk') return { error: require('./freetalk').PROTECTED };
    const projects = this.listProjects();
    const { Hierarchy } = require('./hierarchy');
    const h = new Hierarchy(this);
    try { parent = h.resolve(parent, projects); derivedFrom = h.resolve(derivedFrom, projects); } catch(e) { return { error: e.message }; }
    if (projects.some(p => p.name === nm)) return { error: lt('同じ名前のプロジェクトがあります') };
    const dir = path.join(this.product, nm);
    if (fs.existsSync(dir)) return { error: lt`「${nm}」はもうあります` };
    fs.mkdirSync(dir, { recursive: true });
    if (templateDir && fs.existsSync(templateDir)) {
      fs.cpSync(templateDir, dir, { recursive: true, filter: src => path.basename(src) !== '.gitkeep' && path.basename(src) !== 'PROJECT.md' });
    }
    for (const d of ['資料', '作業', '成果物', '.ai/tasks', '.ai/memory', '.ai/work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const list = (Array.isArray(phases) ? phases : String(phases || '').split(/\r?\n/)).map(oneLine).filter(Boolean).slice(0, 12);
    const rel = (Array.isArray(related) ? related : String(related || '').split(/[,、\n]/)).map(oneLine).filter(Boolean);
    const q = v => scalar(v);
    const text = [
      '---',
      `name: ${q(nm)}`,
      'status: 進行中',
      `updated: ${now().slice(0, 10)}`,
      `description: ${q(description)}`,
      `parent: ${q(parent)}`,
      `derivedFrom: ${q(derivedFrom)}`,
      'phases:',
      ...(list.length ? list : [lt('計画'), lt('作る'), lt('チェック'), lt('仕上げ')]).map((ph, i) => `  - { name: ${ph.replace(/[,{}]/g, '・')}, state: ${i === 0 ? '進行中' : '未着手'} }`),
      'folders:',
      ...(oneLine(body) ? [`  本体: ${q(oneLine(body))}`] : []),
      ...(Array.isArray(refs) ? refs : []).map(oneLine).filter(Boolean).slice(0, 30).map((r, i) => `  参考${i + 1}: ${q(r)}`),
      `related: [${rel.map(x => x.replace(/[,\[\]]/g, '・')).join(', ')}]`,
      'chats: []',
      'issues: []',
      '---',
      '',
      lt('# メモ'),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), text);
    return { project: this.readProject(nm) };
  }

  // 参考フォルダ・ファイルを足す（PROJECT.md の folders に「参考N」として書く。同じ場所は足さない）
  addRefs(id, paths) {
    const p = this.readProject(id);
    if (!p) return null;
    const file = path.join(p.dir, 'PROJECT.md');
    const lines = read(file).split('\n');
    const end = lines.indexOf('---', 1);
    let i = lines.findIndex((l, k) => k > 0 && k < end && /^folders:/.test(l));
    if (i < 0) { lines.splice(end, 0, 'folders:'); i = end; }
    else if (/^folders:\s*\{\s*\}/.test(lines[i])) lines[i] = 'folders:';
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && lines[j] !== '---') j++;
    const have = new Set(p.folders.map(f => expandHome(f.path)));
    const used = new Set(p.folders.map(f => f.label));
    // 中身の無い「資料:」などの行は残してよい。番号は空いている所から
    let n = 1;
    const add = [];
    for (const x of paths) {
      if (have.has(x)) continue;
      while (used.has(`参考${n}`)) n++;
      used.add(`参考${n}`); have.add(x);
      add.push(`  参考${n}: ${scalar(x)}`);
    }
    lines.splice(j, 0, ...add);
    fs.writeFileSync(file, lines.join('\n'));
    return { project: this.readProject(id), added: add.length };
  }

  listProjects() {
    let names = [];
    try { names = fs.readdirSync(this.product); } catch { return []; }
    return names.filter(n => !n.startsWith('.') && !n.startsWith('_'))
      .map(n => this.readProject(n)).filter(Boolean)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  roles() {
    const text = read(path.join(this.root, '_hub', 'roles.yaml'));
    return text ? parseYaml(text) : {};
  }

  // 状態・質問を書き換え、メモを1行足す
  updateTask(projectId, taskId, { state, question, memo, owner, role, model, effort, parent, workdir, phase, via, mergeExcluded, kind, derivedFrom, workspaceMode, workspaceStarted }) {
    const file = this.taskFile(projectId, taskId);
    if (!file) return null;
    let text = read(file);
    const key = `${projectId}/${taskId}`, preserve = this.completion.data.tasks[key]?.hash === hash(text);
    if (state !== undefined) text = setScalar(text, 'state', state);
    if (question !== undefined) text = setScalar(text, 'question', question);
    if (owner !== undefined) text = setScalar(text, 'owner', owner);
    if (role !== undefined) text = setScalar(text, 'role', role);
    if (model !== undefined) text = setScalar(text, 'model', model);
    if (effort !== undefined) text = setScalar(text, 'effort', effort);
    if (parent !== undefined) text = setScalar(text, 'parent', parent);
    if (workdir !== undefined) text = setScalar(text, 'workdir', workdir);
    if (typeof mergeExcluded === 'boolean') text = setScalar(text, 'mergeExcluded', mergeExcluded);
    if (phase !== undefined) text = setScalar(text, 'phase', phase);
    if (via !== undefined) text = setScalar(text, 'via', via);
    for (const [key,value] of Object.entries({kind,derivedFrom,workspaceMode,workspaceStarted})) if (value !== undefined) text = setScalar(text,key,value);
    text = setScalar(text, 'updated', now());
    if (memo && String(memo).trim()) {
      const line = `- ${now()} ${String(memo).replace(/[\r\n]+/g, ' ').trim()}`;
      text = /^## (?:メモ|備註)\s*$/m.test(text)
        ? text.replace(/^## (?:メモ|備註)\s*$/m, m => `${m}\n${line}`)
        : text.replace(/\s*$/, lt`\n\n## メモ\n${line}\n`);
    }
    fs.writeFileSync(file, text);
    if (preserve && parseDoc(text).data.state === '完了') this.completion.approveTask(key, text);
    return this.readTask(file);
  }

  // 手順だけを更新。全部付いても、人の承認までは一覧に残す。
  setStep(projectId, taskId, index, done) {
    const file = this.taskFile(projectId, taskId);
    if (!file) return null;
    const before = read(file), key = `${projectId}/${taskId}`, preserve = this.completion.data.tasks[key]?.hash === hash(before);
    const lines = before.split('\n');
    let inside = false, n = -1, hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { inside = /^##\s+(?:手順|步驟)/.test(lines[i]); continue; }
      if (inside && STEP.test(lines[i]) && ++n === index) { lines[i] = lines[i].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]'); hit = true; break; }
    }
    if (!hit) return null;
    let text = setScalar(lines.join('\n'), 'updated', now());
    const steps = readSteps(parseDoc(text).body);
    const cur = parseDoc(text).data.state;
    if (!steps.every(x => x.done) && cur === '完了') text = setScalar(text, 'state', '実行中');
    fs.writeFileSync(file, text);
    if (preserve && parseDoc(text).data.state === '完了') this.completion.approveTask(key,text);
    return this.readTask(file);
  }

  // 手順を1つ足す（「## 手順」が無ければ本文の先頭に作る）
  addStep(projectId, taskId, textIn) {
    const file = this.taskFile(projectId, taskId);
    const item = oneLine(textIn).slice(0, 120);
    if (!file || !item) return null;
    const lines = read(file).split('\n');
    const h = lines.findIndex(l => /^##\s+(?:手順|步驟)/.test(l));
    if (h >= 0) {
      let end = h + 1;
      for (let i = h + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (STEP.test(lines[i])) end = i + 1;
      // 中身の無い「- [ ] 」は置き換える
      const blank = lines.findIndex((l, i) => i > h && i <= end && /^\s*[-*]\s+\[ \]\s*$/.test(l));
      if (blank >= 0) lines[blank] = `- [ ] ${item}`; else lines.splice(end, 0, `- [ ] ${item}`);
    } else {
      const close = lines.indexOf('---', 1);
      lines.splice(close + 1, 0, lt('## 手順'), `- [ ] ${item}`, '');
    }
    let text = setScalar(lines.join('\n'), 'updated', now());
    if (parseDoc(text).data.state === '完了') text = setScalar(text, 'state', '実行中');
    fs.writeFileSync(file, text);
    return this.readTask(file);
  }

  // 「## 見出し」の終わりに文を足す（見出しが無ければ終わりに作る）。ChatGPT の報告・提案で使う
  appendSection(projectId, taskId, heading, block) {
    const file = this.taskFile(projectId, taskId), add = String(block || '').replace(/\s+$/, '');
    if (!file || !add) return null;
    const lines = read(file).replace(/\s*$/, '\n').split('\n');
    const h = lines.findIndex(l => sectionNames(heading).some(name => l.replace(/^##\s+/, '').trim() === name || l.replace(/^##\s+/, '').trim().startsWith(name+'（')) && /^##\s/.test(l));
    if (h < 0) lines.splice(lines.length - 1, 0, '', `## ${sectionName(heading)}`, add);
    else {
      let end = h + 1;
      for (let i = h + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (lines[i].trim()) end = i + 1;
      lines.splice(end, 0, add);
    }
    fs.writeFileSync(file, setScalar(lines.join('\n'), 'updated', now()));
    return this.readTask(file);
  }

  // プロジェクトの状態（人が［プロジェクトを完了にする］を押した時など）
  setProjectStatus(projectId, status) {
    const p = this.readProject(projectId);
    if (!p) return null;
    const file = path.join(p.dir, 'PROJECT.md');
    fs.writeFileSync(file, setScalar(read(file), 'status', status));
    if (status === '完了') this.completion.approveProject(projectId, parseDoc(read(file)).data, { status: true });
    return this.readProject(projectId);
  }

  // 今のフェーズ（最初の未完了）を完了にして、次を進行中にする
  nextPhase(projectId) {
    const p = this.readProject(projectId);
    if (!p) return null;
    const i = p.phases.findIndex(ph => ph && ph.state !== '完了');
    if (i < 0) return p;
    const file = path.join(p.dir, 'PROJECT.md');
    let text = setPhaseLine(read(file), p.phases[i].name, '完了');
    if (p.phases[i + 1] && !p.phases[i + 1].completionPending) text = setPhaseLine(text, p.phases[i + 1].name, '進行中');
    else if (!p.phases[i + 1]) text = setScalar(text, 'status', '完了');
    fs.writeFileSync(file, text);
    this.completion.approveProject(projectId, parseDoc(text).data, { phase: p.phases[i].name, status: !p.phases[i + 1] });
    return this.readProject(projectId);
  }

  phaseOfferKey(p) { return hash(JSON.stringify(p.tasks.map(t => [t.id,t.state,t.phase,t.steps]))); }

  continuePhase(projectId) {
    const p = this.readProject(projectId); if (!p) return null;
    const ph = p.phases.find(x => x.state !== '完了'); if (!ph) return p;
    const file = path.join(p.dir, 'PROJECT.md');
    fs.writeFileSync(file, setPhaseLine(read(file), ph.name, '進行中'));
    this.completion.data.projects[projectId] ||= { phases: {} };
    this.completion.data.projects[projectId].continued = this.phaseOfferKey(p); this.completion.save();
    return this.readProject(projectId);
  }

  decideTask(projectId, taskId, action, expectedHash) {
    const file = this.taskFile(projectId, taskId); if (!file) return null;
    if (!['approve', 'continue'].includes(action)) return { error: lt('判断を指定してください'), status: 400 };
    const before = read(file);
    if (hash(before) !== expectedHash) return { error: lt('確認中に作業が更新されました'), status: 409 };
    const raw = parseDoc(before).data.state || '未着手';
    const text = setScalar(setScalar(before, 'state', action === 'approve' ? '完了' : raw === '完了' ? '実行中' : raw), 'updated', now());
    fs.writeFileSync(file, text);
    const key = `${projectId}/${taskId}`;
    if (action === 'approve') this.completion.approveTask(key, text);
    else this.completion.continueTask(key, readSteps(parseDoc(text).body));
    return this.readTask(file);
  }

  // 新しい作業ファイルを作る
  createTask(projectId, { title, owner, model, effort, next, role, parent, phase, via, steps, kind, derivedFrom, workspaceMode }) {
    const dir = this.projectDir(projectId);
    if (!dir || !title || !String(title).trim()) return null;
    let context; try { context = require('./work-context').validateTask(this.readProject(projectId), null, {parent,kind,derivedFrom,workspaceMode}, this.listProjects()); } catch(e) { return null; }
    const tdir = path.join(dir, '.ai', 'tasks');
    fs.mkdirSync(tdir, { recursive: true });
    const day = now().slice(0, 10).replace(/-/g, '');
    const id = require('./task-ids').reserveTaskId(this, projectId, dir, day);
    const one = scalar;
    const list = (Array.isArray(steps) ? steps : String(steps || '').split(/\r?\n/)).map(oneLine).filter(Boolean).slice(0, 12);
    const text = lt`---\nid: ${id}\ntitle: ${one(title)}\nrole: ${one(role)}\nparent: ${one(parent)}\nkind: ${context.kind}\nderivedFrom: ${one(context.derivedFrom)}\nworkspaceMode: ${context.workspaceMode}\nphase: ${one(phase)}\nowner: ${one(owner)}\nvia: ${one(via)}\nstate: 未着手\nworkdir:\nmodel: ${one(model)}\neffort: ${one(effort)}\nquestion:\nskills: []\nupdated: ${now()}\n---\n## 手順\n${list.map(x => `- [ ] ${x}`).join('\n')}\n\n## やったこと\n\n## 次にやること\n${one(next)}\n\n## 注意\n`;
    fs.writeFileSync(path.join(tdir, id + '.md'), text, { flag: 'wx' });
    return this.readTask(path.join(tdir, id + '.md'));
  }
}

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { Store, expandHome, readSteps, setPhaseLine };
