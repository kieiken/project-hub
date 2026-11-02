'use strict';
const platform = require('./platform');
const { lt } = require('./locale');
const fs = require('./platform/file-io'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { noLinks, readNoLinks, exists } = require('./remove');
const { scalar } = require('./frontmatter');
const chat = require('./chat');
const delegationText=require('./delegation-text');
// 保存済み文字からの目安。日本語等は1文字、英数等ASCIIは4文字で約1トークン。
function estimate(text) {
  let ascii = 0, other = 0;
  for (const c of String(text)) { if (c.codePointAt(0) <= 127) ascii++; else other++; }
  return Math.ceil(other + ascii / 4);
}
class FreetalkHistory {
  constructor(ft, busy = () => '') { this.ft = ft; this.store = ft.store; this.busy = task => ft.uploadReason(task) || busy(task); ft.history = this; }
  topic(task) {
    this.ft.verify(); const file = this.store.taskFile('freetalk', task);
    if (!file) throw Error(lt('話題が見つかりません'));
    readNoLinks(file); const t = this.store.readTask(file);
    if (!t.freetalk) throw Error(lt('自由対話の話題ではありません'));
    return { t, file };
  }
  file(task) { return path.join(this.ft.ledger, '.ai/freetalk', task + '.json'); }
  state(task) {
    const file = this.file(task); readNoLinks(file);
    if (!exists(file)) return { generation: 1 };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  save(task, state) {
    const file = this.file(task); noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID(); fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { flag: 'wx' });
    try { fs.renameSync(tmp, file); } catch (e) { fs.unlinkSync(tmp); throw e; }
  }
  rows(task) {
    const file = chat.files(this.ft.ledger, task).log; readNoLinks(file);
    if (!exists(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
  }
  revision(task) {
    const hash = createHash('sha256');
    for (const file of [this.store.taskFile('freetalk',task), this.file(task), ...Object.values(chat.files(this.ft.ledger,task))]) {
      readNoLinks(file); hash.update(file); if (exists(file)) hash.update(fs.readFileSync(file));
    }
    return hash.digest('hex');
  }
  status(task) {
    const state = this.state(task);
    // A deleted source retains only a receipt so another device can find the destination.
    if(state.migrated?.automatic) {
      this.ft.verify();
      const pending=Boolean(state.migrated.cleanupPending);
      return {migrated:state.migrated,generation:state.generation,tokens:0,warning:false,reason:pending?this.busy(task):lt('この話題はプロジェクトへ移行済みです'),revision:'',draft:'',summaryId:'',promotionRequested:false,promotionAutomatic:pending,automaticCompleted:!pending,automaticError:state.migrated.cleanupError || '',stale:false,staleReason:'',summaryError:''};
    }
    this.topic(task); const rows = this.rows(task);
    const tokens = estimate(rows.map(r => [r.text, ...(r.asks || []).map(a => a.question + '\n' + (a.options || []).join('\n'))].filter(Boolean).join('\n')).join('\n'));
    const reason = state.migrated && !state.migrated.cleanupPending ? lt('この話題はプロジェクトへ移行済みです') : this.busy(task);
    const summary=state.summary;
    // 保存した依頼IDで特定。旧記録だけは先頭のmarkerで読む（後の引用を拾わない）。
    const index=summary?rows.findIndex(r=>{
      if(r.role!=='user')return false;
      if(r.request===summary.id)return true;
      if(summary.requestText)return r.text===summary.requestText || r.text===summary.requestShown;
      const lines=(r.text || '').split('\n');
      return lines[0]===summary.marker || (delegationText.isEnvelopeLine(lines[0]) && lines[1]===summary.marker);
    }):-1;
    const after=index<0?[]:rows.slice(index+1).filter(r=>r.role!=='event'), result=after[0];
    const text=result?.role==='assistant' && (!result.request || result.request===(rows[index]?.request || summary?.id)) && !result.error && !result.asks?.length?result.text || '':'';
    const stale=Boolean(text && after.length>1), promotionRequested=summary?.intent==='promote' && !state.migrated;
    const draft=text && (!stale || promotionRequested)?text:'';
    return { migrated: state.migrated || null, generation: state.generation, tokens, warning: tokens >= 240000, reason,
      revision: this.revision(task), draft, summaryId: summary?.id || '', promotionRequested, stale,
      promotionAutomatic:Boolean(state.migrated?.cleanupPending || (promotionRequested && summary?.automatic)), automaticCompleted:false, automaticError:state.migrated?.cleanupError || summary?.automatic?.error || '',
      staleReason:stale?lt('要約の後に会話が追加されました。要約し直してください'):'',
      summaryError:summary && !reason && !text ? (result?.error || (result?.asks?.length?lt('要約に質問が含まれています。要約し直してください'):index<0?lt('要約依頼を開始できませんでした。要約し直してください'):result?lt('要約を確認できません。要約し直してください'):lt('要約の返事を確認できません。要約し直してください'))) : '' };
  }
  idle(task) { this.topic(task); if(this.state(task).migrated)throw Error(lt('この話題はプロジェクトへ移行済みです')); const reason = this.busy(task); if (reason) throw Error(reason); }
  promotionIntent(task, requested) {
    if(typeof requested!=='boolean')throw Error(lt('プロジェクト化の指定を確認してください'));
    this.topic(task);if(requested)this.idle(task);
    const state=this.state(task);if(!state.summary){if(requested)throw Error(lt('この話題のAIが作った要約を確認してください'));return this.status(task);}
    this.save(task,{...state,promotion:undefined,summary:{...state.summary,intent:requested?'promote':undefined}});
    return this.status(task);
  }
  prepareSummary(task, {intent, automatic=false} = {}) {
    this.idle(task); const rows = this.rows(task), state=this.state(task);
    let last=rows.findLast(r=>r.role==='assistant');
    // 要約の失敗を再要約する時は、直前に成功した同じ相談経路へ戻す。
    if(last?.error && state.summary && this.status(task).summaryError)last=rows.findLast(r=>r.role==='assistant' && !r.error);
    if (!last || last.error || !['codex','claude','agy','grok','chatgpt'].includes(last.ai) || (last.ai !== 'chatgpt' && !last.model)) throw Error(lt('この話題のAIに一度相談し、返事が成功してから整理してください'));
    if (last.ai === 'chatgpt') { const e = Error(lt('手動・アプリの経路は廃止しました。この話題で利用できるAIを選び直してください')); e.status = 410; throw e; }
    const id = randomUUID(), marker = '[freetalk-summary:' + id + ']';
    const text=automatic?lt`${marker}\nこの話題をプロジェクトへ引き継ぐ要約を作ってください。決定事項・その理由・未解決の点・次にすることだけをまとめ、要約本文だけを返してください。ファイルや設定は変更せず、質問形式を使わないでください。要約後のプロジェクト作成・移行と、成功後の移行元の削除はHubが自動で行います。`:lt`${marker}\nこの話題を新しい会話へ引き継ぐ要約を作ってください。決定事項・その理由・未解決の点・次にすることだけをまとめ、要約本文だけを返してください。ファイルや設定は変更せず、質問形式を使わないでください。人が確認・編集するまで会話は消しません。`;
    const requestShown=lt`【渡した依頼：${lt('話題の整理用の要約')}】\n${text}`;
    this.save(task, { ...state, promotion:undefined, summary: { id, marker, requestText:text, requestShown, intent:intent==='promote'?'promote':undefined, ...(automatic?{automatic:{phase:'starting'}}:{}) } });
    return { ai: last.ai, model: last.model, effort: last.effort, account: last.account || 'default', text };
  }
  rotate(task, { confirm, revision, summaryId, summary } = {}) {
    this.idle(task); const status = this.status(task);
    if (confirm !== true) throw Error(lt('内容を確認してから実行してください'));
    if (revision !== status.revision) throw Error(lt('会話が更新されました。もう一度確認してください'));
    if (summaryId && (summaryId !== status.summaryId || !status.draft || status.stale || typeof summary !== 'string' || !summary.trim() || summary.length > 50000)) throw Error(lt('AIの要約を確認・編集してください'));
    if (!summaryId && summary !== undefined) throw Error(lt('確認済みの要約がありません'));
    const { t, file } = this.topic(task), oldState = this.state(task);
    const targets = [file, this.file(task)];
    // すべてのAIの再開情報・指示全文・引継ぎ控えを同時に退避。
    for (const dir of ['chat','handoff','memory','work']) {
      const base = path.join(this.ft.ledger,'.ai',dir); noLinks(base);
      if (exists(base)) for (const name of fs.readdirSync(base)) if (name === task || name.startsWith(task + '.') || name.startsWith(task + '-')) targets.push(path.join(base,name));
    }
    const topicMemory = path.join(this.ft.dir,'topics',task,...(summaryId ? ['.ai'] : []));
    if (exists(topicMemory)) targets.push(topicMemory);
    for (const target of targets) noLinks(target);
    const trash = path.join(platform.trashDir(this.ft.home), 'ProjectHub freetalk ' + task + ' ' + randomUUID()); noLinks(trash);
    fs.mkdirSync(trash,{recursive:true});
    const moved = [], created = [];
    fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,generation:oldState.generation,planned:targets.map((target,i)=>({target,dest:path.join(trash,String(i))}))})+'\n',{flag:'wx'});
    try {
      for (const [i, target] of targets.entries()) if (exists(target)) {
        const dest = path.join(trash,String(i)); fs.renameSync(target,dest); moved.push({target,dest});
      }
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,generation:oldState.generation,moved})+'\n');
      const source = `---\nid: ${task}\ntitle: ${scalar(t.title)}\nfreetalk: true\ntitleAssigned: true\nstate: 未着手\nworkspaceMode: direct\nworkdir: ${scalar(this.ft.dir)}\nowner: ${scalar(t.owner)}\nmodel: ${scalar(t.model)}\neffort: ${scalar(t.effort)}\nquestion:\nupdated: ${new Date().toISOString()}\n---\n# 自由対話\n`;
      fs.writeFileSync(file,source,{flag:'wx'}); created.push(file);
      const meta = chat.files(this.ft.ledger,task).meta;
      const oldMeta = moved.find(x=>x.target===meta);
      const prefs = oldMeta ? JSON.parse(fs.readFileSync(oldMeta.dest,'utf8')) : {};
      created.push(meta); chat.writeMeta(this.ft.ledger,task,{sessions:{},models:{},accounts:prefs.accounts || {},codexFast:prefs.codexFast === true});
      if (summaryId) { created.push(chat.files(this.ft.ledger,task).log); chat.append(this.ft.ledger,task,{role:'user',text:lt('人が確認した引き継ぎ要約：\n')+summary.trim(),summaryApproved:true,generation:oldState.generation+1}); }
      created.push(this.file(task)); this.save(task,{generation:oldState.generation+1});
      return { ok:true,generation:oldState.generation+1,trash };
    } catch (e) {
      for (const target of created.reverse()) if (exists(target)) fs.unlinkSync(target);
      for (const {target,dest} of moved.reverse()) fs.renameSync(dest,target);
      throw Error(lt('切り替えに失敗し、元の会話を保持しました：')+e.message);
    }
  }
}
module.exports = { FreetalkHistory, estimate };
