'use strict';
const { lt } = require('./locale');
// 表示だけをゲートし、Storeの完了承認記録は変えない。読込ではAIを始めない。
const fs = require('node:fs'), path = require('node:path');
const graph = require('../public/project-order');
class ResultsGate {
  constructor({store, transfer, blocked = () => '', launch}) {
    Object.assign(this, {store, transfer, blocked, launch});
    this.file = path.join(store.root, '_hub/results-gate.json');
    this.records = {}; this.inflight = new Set(); this.issues = new Map();
    try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('invalid'); this.records = data; }
    catch (e) { if (e.code !== 'ENOENT') this.warning = lt('成果整理の依頼記録を読めません。自動では再依頼しません'); }
  }
  key(p,t) { return p.id + '/' + t.id; }
  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2)); fs.renameSync(tmp, this.file);
  }
  target(p,t,all) { return p.kind !== 'freetalk' && !t.freetalk && graph.ancestorsOf(p,t,all).length > 0; }
  eligible(p,t,all) { return this.target(p,t,all) && t.completionPending; }
  current(project,task) {
    const all = this.store.listProjects(), p = all.find(p=>p.id===project), t=p?.tasks.find(t=>t.id===task);
    return {all,p,t};
  }
  issue(p,t,{fresh=true}={}) {
    const key=this.key(p,t), cached=this.issues.get(key);
    // 画面の繰返し読込だけを短く保持。成果ファイルだけの外部変更も次の秒には再検査する。
    if(!fresh && cached?.hash===t.completionHash && Date.now()-cached.at<1000)return cached.issue;
    let issue;try {issue=this.transfer.resultIssue(p,t);} catch(e) {issue={ok:false,code:'verify',reason:e.message};}
    if(this.issues.size>=500)this.issues.clear();
    this.issues.set(key,{hash:t.completionHash,at:Date.now(),issue});return issue;
  }
  decorate(p,t,all) {
    if (!this.eligible(p,t,all)) return t;
    const issue = this.issue(p,t,{fresh:false}); if (issue.ok) return t;
    const key=this.key(p,t), r=this.records[key], busy=this.inflight.has(key);
    const block=this.blocked(p,t) || this.warning;
    const auto=busy || r?.state==='running' && block==='AIが作業中です'?'running':block?'blocked':r?.hash===t.completionHash?(r.state==='blocked'?'blocked':'failed'):'none';
    return {...t, completionPending:false, ...(t.state==='完了確認待ち'?{state:'実行中'}:{}), resultsPending:{code:issue.code,reason:issue.reason,auto,detail:block || (r?.hash===t.completionHash?r.reason:'') || ''}};
  }
  approvalIssue(p,t,all) { return this.target(p,t,all) && t.state !== '完了' ? this.issue(p,t) : {ok:true}; }
  async trigger(project,task,{manual=false,expectedHash,row,organized=false}={}) {
    const {all,p,t}=this.current(project,task); if(!t)throw Error(lt('作業が見つかりません'));
    if(manual && expectedHash!==t.completionHash)throw Error(lt('確認中に作業が更新されました'));
    const key=this.key(p,t);
    if(!this.eligible(p,t,all)) {
      if(this.records[key] && !this.inflight.has(key)) {delete this.records[key];this.save();}
      if(manual)throw Error(lt('成果整理の対象ではありません'));
      return;
    }
    const issue=this.issue(p,t); if(issue.ok)return;
    if(organized) {
      this.records[key]={hash:t.completionHash,at:new Date().toISOString(),attempts:1,state:'failed',reason:row?.error || lt('整理後も成果の記録が整っていません')};this.save();return;
    }
    if(this.inflight.has(key)) {if(manual)throw Error(lt('成果の整理が動いています'));return;}
    const fail=reason=>{this.records[key]={hash:t.completionHash,at:new Date().toISOString(),attempts:1,state:'blocked',reason};this.save();};
    const block=this.blocked(p,t) || this.warning;
    // 上限交代や既に渡した後続の番がある時は、その終了を待って判定する。
    if(!manual && [lt('AIが作業中です'),lt('順番待ちがあります')].includes(block))return;
    if(!manual && row?.error) {fail(lt('直前のAIがエラーまたは停止で終わったため自動整理していません：')+row.error);return;}
    if(block) {if(manual)throw Error(block);return;}
    if(!manual && this.records[key]?.hash===t.completionHash)return;
    this.inflight.add(key);
    try {
      this.records[key]={hash:t.completionHash,at:new Date().toISOString(),attempts:1,state:'running'};this.save();
      await this.launch(p,t,issue);
    } catch(e) {fail(e.message);throw e;} finally {this.inflight.delete(key);}
  }
}
module.exports={ResultsGate};
