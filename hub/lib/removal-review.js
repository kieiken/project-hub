'use strict';
const { lt } = require('./locale');
// AIには読む道具だけを渡す。判定の保存と削除候補への反映はHubが行う。
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {noLinks,exists}=require('./remove');
class RemovalReview {
 constructor({store,removal,start,busy,rows,queued=()=>false}){Object.assign(this,{store,removal,start,busy,rows,queued});this.starting=new Set();}
 file(project){const p=this.store.readProject(project);if(!p)throw Error(lt('プロジェクトがありません'));const f=path.join(p.dir,'.ai/work/remove-sharing.json');noLinks(f);return f;}
 read(project){const f=this.file(project);if(!exists(f))return null;const st=fs.statSync(f);if(st.size>1024*1024)throw Error(lt('共有確認の記録が大きすぎます'));return JSON.parse(fs.readFileSync(f,'utf8'));}
 save(project,r){const f=this.file(project);fs.mkdirSync(path.dirname(f),{recursive:true});noLinks(f+'.tmp');fs.writeFileSync(f+'.tmp',JSON.stringify(r,null,2));fs.renameSync(f+'.tmp',f);}
 active(project){const r=this.read(project);return this.starting.has(project)||r?.status==='running';}
 async begin(token){
  const old=this.removal.tokens.get(token);if(!old||Date.now()-old.at>600000||old.d.task)throw Error(lt('もう一度プロジェクトの削除内容を確認してください'));
  const project=old.d.project;if(this.active(project))throw Error(lt('共有確認はすでに実行中です'));
  const d=this.removal.describe(project);if(d.blockers.length)throw Error(d.blockers.join(' / '));
  if(JSON.stringify(d)!==JSON.stringify(old.d))throw Error(lt('確認中に変わりました。もう一度確認してください'));
  const candidates=d.keep.filter(x=>x.external);if(!candidates.length)throw Error(lt('確認する外の場所がありません'));
  this.starting.add(project);
  let r;
  try {
   const task=this.store.createTask(project,{title:lt('削除前の共有確認'),owner:'claude-code',role:'チェック',model:'claude-fable-5-1',workspaceMode:'direct',steps:[lt('外の場所の共有を読み取りだけで確認する')]});
   if(!task)throw Error(lt('共有確認の作業を作れませんでした'));
   r={id:randomUUID(),task:task.id,status:'running',candidates,results:[],error:'',at:new Date().toISOString()};this.save(project,r);
   const p=this.store.readProject(project),text=[
    lt('プロジェクト削除前の共有確認です。ファイル変更・移動・削除・委任・外部送信は禁止。Read/Glob/Grepのみで読み取ってください。'),
    lt('対象は下のJSONの場所です。ほかのプロジェクトのPROJECT.md・作業・会話で参照されていないか、使われ方と内容も必要な範囲で確認してください。リンク先と選択不可の場所の中身は読みません。選択不可の場所は理由を基に「不明」としてください。'),
    lt`台帳の範囲：${this.store.product}`,
    lt('場所ごとに共有「なし／あり／不明」と根拠を返してください。参照が見つからないだけで「なし」と断定せず、用途や所有も確かめ、他アプリ・他の人の使用など確認できないものは「不明」。読めない/大きすぎる場所も「不明」。'),
    lt('最終応答はJSONのみ：{"results":[{"id":"候補のid","sharing":"なし|あり|不明","reason":"読んだ根拠と確認範囲（必須）"}]}。全候補を1回ずつ。JSONはHubが作業の.ai/work/remove-sharing.jsonに保存します。作業ファイルも編集しないでください。'),
    JSON.stringify(candidates.map(({id,path,selectable,unavailableWhy})=>({id,path,selectable,unavailableWhy})))
   ].join('\n');
   const readDirs=[this.store.product,...candidates.filter(x=>x.selectable).map(x=>fs.statSync(x.path).isDirectory()?x.path:path.dirname(x.path))];
   const launch=await this.start({project,task:task.id,pdir:p.dir,dir:p.dir,text,request:r.id,readOnly:true,readDirs:[...new Set(readDirs)]});
   if(!(await launch.started))throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
   return {status:'running',task:r.task,id:r.id};
  }catch(e){if(r){r.status='failed';r.error=e.message;this.save(project,r);}throw e;}
  finally{this.starting.delete(project);}
 }
 status(project){
  const r=this.read(project);if(!r)return null;
  if(r.status==='running'&&!this.starting.has(project)&&!this.busy(project,r.task)&&!this.queued(project,r.task)){
   const row=this.rows(project,r.task).filter(x=>x.role==='assistant'&&(x.request===r.id||x.request==='limit-'+r.id)).at(-1);
   try{
    if(!row||row.error)throw Error(row?.error||lt('確認が途中で止まりました。判定は反映していません'));
    const parsed=JSON.parse(String(row.text).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
    if(!Array.isArray(parsed.results)||parsed.results.length!==r.candidates.length)throw Error(lt('AIの判定件数が一致しません'));
    const seen=new Set();r.results=parsed.results.map(x=>{
     if(!x||!r.candidates.some(c=>c.id===x.id)||seen.has(x.id)||!['なし','あり','不明'].includes(x.sharing)||typeof x.reason!=='string'||!x.reason.trim()||x.reason.length>2000)throw Error(lt('AIの判定形式が一致しません'));
     seen.add(x.id);return {id:x.id,sharing:x.sharing,reason:x.reason.trim()};
    });
    r.status='done';this.store.setStep(project,r.task,0,true);
   }catch(e){r.status='failed';r.results=[];r.error=e.message;}
   this.save(project,r);
  }
  // AIの確認中に場所が変わった場合、古い「なし」で自動選択しない。
  if(r.status==='done'){
   const d=this.removal.describe(project),now=d.keep.filter(x=>x.external);
   if(JSON.stringify(now)!==JSON.stringify(r.candidates))return {id:r.id,task:r.task,status:'stale',results:[],error:lt('外の場所や他プロジェクトの使用が変わりました。削除内容を確認し直してください')};
  }
  return {id:r.id,task:r.task,status:r.status,results:r.results,error:r.error};
 }
}
module.exports={RemovalReview};
