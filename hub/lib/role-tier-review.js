'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const launch = require('./launch');
const { lt } = require('./locale');
const roles = require('./roles');
const tiers = require('./role-tiers');
const OPEN = '[[段の見直し結果]]', CLOSE = '[[/段の見直し結果]]';
const basePrompt = lt('役割の段の見直し案を作ります。公式資料は検索・参照できます。ファイル編集・CLI起動・委任・購入・API従量課金・認証変更は禁止。設定は人の承認後だけHubが保存します。');
const isRequest = id => /^(?:limit-)*tier-review-/.test(String(id || ''));
function parse(text) {
  if (typeof text !== 'string' || text.split(OPEN).length !== 2 || text.split(CLOSE).length !== 2 || text.indexOf(CLOSE) < text.indexOf(OPEN)) throw Error(lt('段の見直し結果の印を確認できません'));
  return JSON.parse(text.split(OPEN)[1].split(CLOSE)[0].trim());
}
function validate(decision, current, catalogs) {
  if (!decision?.tiers || typeof decision.tiers !== 'object' || Array.isArray(decision.tiers) || (typeof decision.reason !== 'string' || !decision.reason.trim()) || !Array.isArray(decision.evidence) || !Array.isArray(decision.unverified) || decision.unverified.some(x => typeof x !== 'string')) throw Error(lt('提案の設定・理由・出どころ・未確認の点が足りません'));
  const lower = {}, nextRoles = structuredClone(current.roles);
  for (const [name, row] of Object.entries(decision.tiers)) {
    const role = nextRoles.find(r => r.name === name); if (!role || !row || Object.keys(row).some(k => !['light', 'standard', 'hard'].includes(k))) throw Error(lt('提案の役割や段が違います'));
    if (row.hard) {
      const s = row.hard, ai = tiers.cli(s.ai), m = catalogs[ai]?.models?.find(m => m.id === s.model);
      if (!m || tiers.oldModel(s.model) || s.effort === 'Ultra' || !launch.effortsFor(ai, s.model, catalogs[ai].models).includes(s.effort) || Object.keys(s).sort().join(',') !== 'ai,effort,model') throw Error(lt('難しい段のモデル・思考を選べません'));
      if (ai === 'agy' && ![role.main, role.backup].some(s => tiers.cli(s.ai) === 'agy')) throw Error(lt('Agyの割り当ては増やせません'));
      role.main = { ai: launch.AI_KEY[ai], model: m.label, effort: s.effort };
    }
    lower[name] = { routing: current.tiers[name]?.routing || 'on', ...(row.light ? { light: row.light } : {}), ...(row.standard ? { standard: row.standard } : {}) };
    const before = current.roles.find(r => r.name === name);
    if (JSON.stringify(lower[name]) !== JSON.stringify(current.tiers[name]) || JSON.stringify(role.main) !== JSON.stringify(before.main)) {
      const evidence = decision.evidence.find(e => e?.role === name);
      if (!evidence || typeof evidence.reason !== 'string' || !evidence.reason.trim() || !Array.isArray(evidence.sources) || !evidence.sources.length || evidence.sources.some(s => typeof s !== 'string' || !/^https:\/\/\S+/.test(s) || !/\d{4}-\d{2}-\d{2}/.test(s))) throw Error(lt('変える役割ごとに、理由と公式URL・確認日が必要です'));
    }
  }
  if (!Object.keys(lower).length) throw Error(lt('提案する段がありません'));
  tiers.validate(lower, nextRoles, catalogs);
  return { lower, roles: nextRoles };
}
class TierReview {
  constructor(o) { Object.assign(this, o); this.tempDirs = new Map(); }
  temporaryDir(request) {
    if (!this.tempDirs.has(request)) this.tempDirs.set(request, fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-tier-review-')));
    return this.tempDirs.get(request);
  }
  cleanup(o) { const dir = this.tempDirs.get(o.request); if (dir) { fs.rmSync(dir, { recursive:true, force:true }); this.tempDirs.delete(o.request); } }
  update(fn) { const r = this.tiers.read(); fn(r.data); return tiers.write(this.tiers.file, r.data, r.revision); }
  verify(o) {
    const p = this.tiers.read().data.review;
    if (!p || p.status !== 'running' || p.task !== o.task || o.project !== 'freetalk' || ![p.request, 'limit-' + p.request].includes(o.request) || !o.readOnly || !o.isolatedReview || !o.tierReview) throw Error(lt('段の見直しは終了または中断されています'));
    if (!o.limitSwitch && (o.ai !== p.slot.ai || launch.flagFor(o.ai, o.model) !== p.slot.model || (o.account || 'default') !== p.slot.account)) throw Error(lt('段の見直しの担当が変わりました'));
  }
  refresh(o) { this.verify(o); const p = this.store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task); if (!t) throw Error(lt('見直しの話題がありません')); return { dir: this.temporaryDir(o.request), basePrompt, policy: basePrompt }; }
  recover() {
    try {
      this.finishApplication();
      const r = this.tiers.read();
      if (r.data.review?.status === 'running' || r.data.review?.status === 'creating') this.update(d => { d.review.status = 'interrupted'; d.review.error = lt('Hubの再起動で中断しました。設定は変えていません'); });
    } catch (e) {
      // An unreadable optional file must neither stop boot nor be overwritten.
      try { this.update(d => { if (d.review) { d.review.status = 'failed'; d.review.error = e.message; } }); } catch { /* Settings displays the read error. */ }
    }
  }
  async start() {
    const r = this.tiers.read();
    if (['creating', 'running'].includes(r.data.review?.status)) throw Error(lt('段の見直しはすでに受付済みです'));
    if (this.special()) throw Error(lt('特殊モードを解除してから見直してください'));
    const data = this.roles(), slot = roles.delegateSlot(data, '司令塔');
    if (!slot) throw Error(lt('司令塔にAIを設定してください'));
    if (!['claude', 'codex'].includes(slot.ai)) throw Error(lt('この担当では読むだけの見直しを実行できません'));
    slot.effort = '高';
    if (!launch.effortsFor(slot.ai, slot.model, this.tiers.tools.catalog()[slot.ai]?.models).includes('高')) throw Error(lt('司令塔のモデルで思考「高」を選べません'));
    const id = crypto.randomUUID(), request = 'tier-review-' + id;
    this.update(d => { d.review = { id, request, status: 'creating', at: new Date().toISOString(), baseRoles: data.roles, baseRevision: data.management.revision, baseTiers: d.roles }; });
    let topic;
    try {
      topic = this.createTopic(slot);
      slot.account = this.accountFor('freetalk', topic.id, slot.ai);
      const invalid = this.modelError(slot.ai, slot.model, slot.account); if (invalid) throw Error(invalid);
      const prompt = [
        lt('人が設定画面の［更新］を押しました。役割の段（軽い・標準・難しい）の見直し案を作ってください。') + basePrompt,
        lt('調べること：各モデルの公式料金（入力・出力・キャッシュ読み出し）、Hubが起動できるモデルとアカウントの違い、長い会話の割増、キャッシュの割引、今の段との差分。公式の出どころ（URL・見た日）を記載。第三者の検証・品質差・契約枠の減り方は未確認と明記。最新という理由だけで変えず、迷ったら上の段。安い段は極高、Ultraなし、古いモデル・一覧外のモデルなし。停止中の役割は再開しない。'),
        lt('今のいつもの担当：') + JSON.stringify(data.roles), lt('今の段：') + JSON.stringify(r.data.roles),
        lt('確認済み一覧（出どころ・確認時刻を含む）：') + JSON.stringify(this.tiers.view().catalogs), lt('アカウント別Codex一覧：') + JSON.stringify(this.tiers.tools.codexCatalogs()),
        lt('変更を提案する役割だけ含め、最後に印の中にJSONを一つ返す。変更がない場合も現設定の段を返す。hardはいつもの担当を変える場合だけ。sourcesには公式URLと YYYY-MM-DD の確認日を書く。'),
        OPEN + '\n{"tiers":{"コーディング":{"light":{"ai":"codex","model":"gpt-6-luna","effort":"極高"},"standard":{"ai":"codex","model":"gpt-6.1-terra","effort":"極高"}}},"reason":"理由","evidence":[{"role":"コーディング","reason":"理由","sources":["https://公式のURL（YYYY-MM-DD）"]}],"unverified":["第三者の検証は未確認"]}\n' + CLOSE,
      ].join('\n\n');
      this.update(d => Object.assign(d.review, { task: topic.id, slot, status: 'running' }));
      const p = this.store.readProject('freetalk'), t = p.tasks.find(t => t.id === topic.id);
      const turn = { project: p.id, task:t.id, pdir:p.dir, dir:this.temporaryDir(request), ...slot, model:launch.modelLabel(slot.ai,slot.model), role:'司令塔', request, id:request, origin:'tier-review', tierReview:true, readOnly:true, isolatedReview:true, freshContext:true, requireModel:true, requiredModel:slot.model, text:prompt, shown:prompt, basePrompt, policy:basePrompt, onEnd:()=>this.ended(p.id,t.id) };
      this.chats.enqueue(p.id,t.id,turn);
      // The durable queue owns the request before asynchronous preflight.
      void this.chats.sendQueued(turn).then(async run => { if (!(await run.started)) throw Error(lt('見直しを起動できませんでした')); this.chats.unqueue(p.id,t.id,request); }).catch(e => {
        this.cleanup({request});this.chats.unqueue('freetalk',topic.id,request);this.update(d => { if(d.review?.id===id){d.review.status='failed';d.review.error=e.message;} });
      });
      return { ok:true, task:topic.id, ...this.tiers.view() };
    } catch(e) { this.cleanup({request}); this.update(d=>{d.review.status='failed';d.review.error=e.message;}); throw e; }
  }
  async settled(o, row) {
    try { return await this.finish(o, row); } finally { this.cleanup(o); }
  }
  async finish(o, row) {
    const p = this.tiers.read().data.review; if (!p || p.status !== 'running' || p.task !== o.task || ![p.request, 'limit-'+p.request].includes(o.request)) return;
    if (row.error && this.chats.queue(o.project,o.task).some(q=>q.limitSwitch && q.id==='limit-'+p.request)) return;
    try {
      if (row.error || row.asks?.length) throw Error(row.error || lt('見直しが提案まで完了しませんでした'));
      const decision = parse(row.text);
      validate(decision, { roles:p.baseRoles, tiers:p.baseTiers }, this.tiers.tools.catalog());
      this.update(d => { d.proposal={id:p.id,at:new Date().toISOString(),decision,baseRoles:p.baseRoles,baseRevision:p.baseRevision,baseTiers:p.baseTiers,task:p.task};d.review.status='proposed'; });
    } catch(e) { this.update(d=>{d.review.status='failed';d.review.error=e.message;}); }
  }
  finishApplication() {
    const r=this.tiers.read(),a=r.data.application;if(!a)return;
    const current=this.roles();
    if(JSON.stringify(current.roles)!==JSON.stringify(a.roles)) {
      if(current.management.revision!==a.baseRevision)throw Error(lt('反映中に役割設定が変わりました。保存内容を確認してください'));
      delete r.data.application;tiers.write(this.tiers.file,r.data,r.revision);return;
    }
    r.data.roles=a.tiers;r.data.proposal=null;delete r.data.application;
    r.data.catalogSeen=tiers.snapshot(this.tiers.tools);r.data.lastReviewedAt=new Date().toISOString();
    tiers.write(this.tiers.file,r.data,r.revision);
  }
  decide({ id, apply }) {
    if(typeof apply!=='boolean')throw Error(lt('反映するか見送るかを指定してください'));
    this.finishApplication();
    let r = this.tiers.read(); const p = r.data.proposal;
    if (!p || id !== p.id) throw Error(lt('この提案はもうありません'));
    if (apply) {
      const current = this.roles();
      if (current.management.revision !== p.baseRevision || JSON.stringify(r.data.roles) !== JSON.stringify(p.baseTiers)) throw Error(lt('提案後に設定が変わりました。設定を読み直して更新してください'));
      const next = validate(p.decision, { roles:current.roles, tiers:r.data.roles }, this.tiers.tools.catalog());
      const merged = { ...r.data.roles, ...next.lower };
      for (const [name, row] of Object.entries(merged)) if (r.data.roles[name]?.routing==='stopped') row.routing='stopped';
      // Durable human intent lets recovery finish the second file if publication is interrupted.
      r.data.application={id,roles:next.roles,tiers:merged,baseRevision:p.baseRevision};
      r=tiers.write(this.tiers.file,r.data,r.revision);
      const saved = this.saveRoles(next.roles,p.baseRevision);
      if (!saved.ok) {delete r.data.application;tiers.write(this.tiers.file,r.data,r.revision);throw Error(saved.errors.join(' / '));}
      this.finishApplication();
    } else {
      r.data.proposal=null;r.data.catalogSeen=tiers.snapshot(this.tiers.tools);r.data.lastReviewedAt=new Date().toISOString();
      tiers.write(this.tiers.file,r.data,r.revision);
    }
    return this.tiers.view();
  }
}
module.exports = { TierReview, parse, validate, isRequest, basePrompt };
