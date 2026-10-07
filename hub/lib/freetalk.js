'use strict';
const { lt } = require('./locale');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { scalar, setScalar, parseDoc } = require('./frontmatter');
const { noLinks, exists } = require('./remove');
const ID = 'freetalk';
const PROTECTED = lt('freetalk は常設の会話枠です。解除・並べ替え・完了・削除・統合・取り込みはできません');
const TOPIC_RULE = lt('話題が変わったと感じたら「別の話題に分けますか」と一言提案し、自動では分けない。');
const SETTINGS = lt`# freetalk\n自由対話の場所です。人の相談に答えてください。\n${TOPIC_RULE}\n手順・フェーズ・完了承認・成果引渡し・作業用コピーは使いません。\n別の話題の会話・記録を自動で読み込まないでください。\nAI の設定を変更せず、ファイル作成や整理は人の依頼の範囲で行ってください。\n担当モデルは Hub が今回の起動で指定したものを使ってください。\n`;
// Macで同じフォルダを指す表記も保護する。会話は正規IDだけで扱う。
function isTarget(value) {
  return typeof value === 'string' && (value.toLowerCase() === ID || value.toLowerCase().startsWith(ID + '/'));
}
function hasTarget(value, aliasOnly = false) {
  if (typeof value === 'string') return isTarget(value) && (!aliasOnly || value.split('/')[0] !== ID);
  if (Array.isArray(value)) return value.some(v => hasTarget(v, aliasOnly));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, v]) =>
    ['project','parentProject','ancestorProject','targetProject','childProject','parent','derivedFrom','id','before','order','items','only','selected','children','related'].includes(key) && hasTarget(v, aliasOnly));
  return false;
}
// 会話の操作だけ許可する。共通 API 経由でも重い作業の機能を持ち込めない。
function guard(route, body) {
  if (route === '/api/project/new' && hasTarget((Array.isArray(body.related) ? body.related : String(body.related || '').split(/[,、\n]/)).map(v=>String(v).trim()))) return PROTECTED;
  if (route === '/api/project/new' && typeof body.name === 'string' && isTarget(body.name.trim())) return PROTECTED;
  if (hasTarget(body, true)) return lt('freetalk は正規の名前「freetalk」で指定してください。') + PROTECTED;
  if (!hasTarget(body)) return '';
  if (['/api/freetalk/project-preview','/api/freetalk/promote','/api/freetalk/clean','/api/freetalk/delete','/api/freetalk/summary','/api/freetalk/rotate','/api/chat/send','/api/chat/note','/api/chat/stop','/api/chat/unqueue','/api/delegate','/api/task/read',
    '/api/task/attach','/api/acceleration/task','/api/accounts/select','/api/chatgpt/prompt','/api/chatgpt/result'].includes(route)) return '';
  if (route === '/api/task' && !Object.keys(body).some(k => !['project','task','state','question','memo','owner','model','effort'].includes(k)) && body.state !== '完了') return '';
  return PROTECTED;
}
class Freetalk {
  constructor(store, home) {
    this.store = store; this.home = path.resolve(home);
    this.dir = path.join(this.home, 'Documents', ID);
    this.ledger = path.join(store.product, ID);
    this.result = { ready: false, reason: '' };
  }
  status() { return { ...this.result }; }
  verify() {
    noLinks(this.dir); noLinks(this.ledger);
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.ai/rules.md', '.ai/freetalk.json']) noLinks(path.join(this.dir, file));
    noLinks(path.join(this.ledger, 'PROJECT.md'));
    const p = this.store.readProject(ID);
    const marker = JSON.parse(fs.readFileSync(path.join(this.dir, '.ai/freetalk.json'), 'utf8'));
    const meta = parseDoc(fs.readFileSync(path.join(this.ledger, 'PROJECT.md'), 'utf8')).data;
    if (!p || p.kind !== ID || !marker.owner || marker.owner !== meta.freetalkOwner || marker.ledger !== this.ledger || p.folders.find(f => f.label === '本体')?.path !== this.dir) throw Error(lt('freetalk の登録と専用フォルダが一致しません。設定を確認してください'));
    return p;
  }
  ensure() {
    const made = [];
    const mkdir = dir => { fs.mkdirSync(dir); made.push([dir, true]); };
    const write = (file, text) => { fs.writeFileSync(file, text, { flag: 'wx' }); made.push([file, false]); };
    try {
      noLinks(this.dir); noLinks(this.ledger);
      if (exists(this.dir) || exists(this.ledger)) {
        // 両側に同じ所有印がある、Hub 自身の登録だけを再利用する。
        if (!exists(this.dir) || !exists(this.ledger)) throw Error(lt`同名のフォルダが既にあります（${exists(this.dir) ? this.dir : this.ledger}）。上書きせず、freetalk を作成しません`);
        try { this.verify(); }
        catch (e) { throw Error(lt`同名の既存フォルダを freetalk の専用登録として確認できません。上書きしません（${e.message}）`); }
      } else {
        fs.mkdirSync(path.dirname(this.dir), { recursive: true });
        fs.mkdirSync(this.store.product, { recursive: true });
        const owner = randomUUID();
        mkdir(this.dir); mkdir(path.join(this.dir, '.ai'));
        write(path.join(this.dir, 'AGENTS.md'), SETTINGS);
        write(path.join(this.dir, 'CLAUDE.md'), SETTINGS);
        write(path.join(this.dir, '.ai/rules.md'), SETTINGS);
        write(path.join(this.dir, '.ai/freetalk.json'), JSON.stringify({ owner, ledger: this.ledger }) + '\n');
        mkdir(this.ledger); mkdir(path.join(this.ledger, '.ai')); mkdir(path.join(this.ledger, '.ai/tasks'));
        write(path.join(this.ledger, 'PROJECT.md'), lt`---\nname: freetalk\nkind: freetalk\nfreetalkOwner: ${owner}\nstatus: 進行中\nfolders:\n  本体: ${scalar(this.dir)}\nphases: []\n---\n# freetalk\n自由対話の話題と会話を保管します。\n`);
      }
      this.result = { ready: true, reason: '' };
    } catch (e) {
      // 今回自分が作った物だけ戻す。既存フォルダ・設定には触らない。
      for (const [file, dir] of made.reverse()) { try { if (dir) fs.rmdirSync(file); else fs.unlinkSync(file); } catch { /* 他者が追加した内容は保護 */ } }
      this.result = { ready: false, reason: String(e.message || e) };
    }
    return this.status();
  }
  createTopic(pick) {
    if (!this.result.ready) throw Error(this.result.reason || lt('freetalk をまだ作成できていません'));
    const p = this.verify(), day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const id = require('./task-ids').reserveTaskId(this.store, ID, p.dir, day);
    const file = path.join(p.dir, '.ai/tasks', id + '.md');
    noLinks(path.dirname(file)); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file, `---\nid: ${id}\ntitle: 新しい話題\nfreetalk: true\ntitleAssigned: false\nstate: 未着手\nworkspaceMode: direct\nworkdir: ${scalar(this.dir)}\nowner: ${scalar(pick.ai === 'claude' ? 'Claude Code' : pick.ai === 'chatgpt' ? 'ChatGPT' : pick.ai === 'agy' ? 'Agy CLI' : pick.ai === 'grok' ? 'Grok' : 'Codex')}\nmodel: ${scalar(pick.model)}\neffort: ${scalar(pick.effort)}\nquestion:\nupdated: ${new Date().toISOString()}\n---\n# 自由対話\n`, { flag: 'wx' });
    return this.store.readTask(file);
  }
  nameTopic(task, speech) {
    const file = this.store.taskFile(ID, task); noLinks(file);
    const text = fs.readFileSync(file, 'utf8');
    if (parseDoc(text).data.titleAssigned === true) return;
    const title = Array.from(String(speech).replace(/\s+/g, ' ').trim()).slice(0, 40).join('');
    if (title) fs.writeFileSync(file, setScalar(setScalar(text, 'title', title), 'titleAssigned', true));
  }
  upload(task, name, data) {
    this.verify();
    const topic = this.store.taskFile(ID, task); noLinks(topic);
    if (!fs.existsSync(topic)) throw Error(lt('話題が見つかりません'));
    const dir = path.join(this.dir, 'topics', task); noLinks(dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, randomUUID() + '-' + path.basename(String(name || 'file')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80));
    fs.writeFileSync(file, data, { flag: 'wx' }); return file;
  }
  prompt(p, t) {
    return `自由対話「${t.title}」。人の相談に答えてください。\ncwd=${this.dir}。AI 設定は AGENTS.md・CLAUDE.md・.ai/rules.md。\n${TOPIC_RULE}\nこの話題以外の会話・作業ファイル・メモリは自動で読みません。手順・フェーズ・完了承認・成果引渡し・作業用コピーは使いません。新しい話題は人が［新しい話題］から作ります。\n台帳=${p.dir}。話題ファイル=${this.store.taskFile(p.id, t.id)}。必要なメモは同じ話題ファイルと台帳/.ai/memory/${t.id}/だけに記録し、state・question・workdir は書き換えません。`;
  }
}
module.exports = { Freetalk, ID, PROTECTED, TOPIC_RULE, guard, hasTarget };
