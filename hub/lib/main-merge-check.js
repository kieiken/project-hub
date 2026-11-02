'use strict';
// Read-only preflight. Never return Git stderr, file contents or local secret names.
const {lt}=require('./locale');
const path=require('node:path'),{execFileSync}=require('node:child_process'),writes=require('./integration-writes');
function safePaths(dir,ignore=[],only){
 const rows=execFileSync('git',['-C',dir,'status','--porcelain','--no-renames','--untracked-files=all','-z'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024}).toString().split('\0').filter(Boolean);
 const paths=[],hidden=[];
 const selected=only?rows.filter(row=>only.includes(row.slice(3))):rows;
 for(const row of selected){const f=row.slice(3);if(ignore.includes(f))continue;
  if(!f||path.isAbsolute(f)||f.split('/').includes('..')||/[\u0000-\u001f\u007f]/.test(f)||/(^|\/)(\.env(?:\..*)?|\.npmrc|\.dev\.vars(?:\..*)?|settings\.local\.json)$|secret|credential|password|token|auth|private.?key/i.test(f)){hidden.push(f);continue;}
  if(paths.length<100)paths.push(f);
 }
 return {paths,hiddenPaths:hidden.length,morePaths:Math.max(0,selected.filter(row=>!ignore.includes(row.slice(3))).length-hidden.length-paths.length)};
}
function check(gitw,dir,side){
 const label=side==='source'?'作業用コピー':'本体';
 const blocker=(kind,details={})=>({side,kind,reason:lt(kind==='dirty'?`${label}に未保存の変更があります`:kind==='merging'?`${label}のマージが途中です`:`${label}の保存状態を読み取れません`),next:lt(kind==='dirty'?`${label}の変更内容を確認し、必要な変更をGitに保存してから、最新の記録を確認してください`:kind==='merging'?`${label}のマージを完了または安全に中止してから、最新の記録を確認してください`:`${label}の場所・Git・読取権限を確認してから、最新の記録を確認してください`),paths:[],...details});
 try{
  if(!dir)return {blocker:blocker('unreadable')};
  if(gitw.merging(dir))return {blocker:blocker('merging')};
  const targetProblem=side==='target'&&gitw.mergeTargetProblem?.(dir);
  if(targetProblem)return {blocker:blocker(targetProblem,{reason:targetProblem==='bisect'?'本体でGitの原因調査が途中です':'本体のブランチが選ばれていません',next:'本体の保存先とGitの状態を確認してから、最新の記録を確認してください'})};
  const ignored=side==='target'?writes.ignored(dir):[],snapshot=gitw.inspect(dir,{readOnly:true,...(ignored.length?{ignore:ignored}:{})});
  if(!snapshot)return {blocker:blocker('unreadable')};
  if(snapshot.status)return {blocker:blocker('dirty',safePaths(dir,ignored))};
  return {snapshot};
 }catch(e){
  const reasons={
   NESTED_GIT_UNRECEIVED:['nested-git',`${label}の内部に別のGitがあります。未受領の成果と履歴の保全が必要です`,'内部のGitをフォルダ全体で別保管し、内容・権限・履歴を照合して保管記録を保存してから、最新の記録を確認してください。無視・削除・参照だけの保存はしないでください'],
   INSPECT_FILE_LIMIT:['file-limit',`${label}の未追跡ファイルが照合件数の上限を超えています`,'成果を保全したうえで未追跡ファイルを整理し、最新の記録を確認してください'],
   INSPECT_BYTE_LIMIT:['byte-limit',`${label}の未追跡ファイルが照合容量の上限を超えています`,'成果を保全したうえで未追跡ファイルを整理し、最新の記録を確認してください'],
   INSPECT_FILE_TYPE:['file-type',`${label}に照合できない種類の未追跡項目があります`,'特殊ファイルの種類と保管方法を確認してください']
  },r=reasons[e?.code];
  return {blocker:r?blocker(r[0],{reason:lt(r[1]),next:lt(r[2]),...(e.code==='NESTED_GIT_UNRECEIVED'?safePaths(dir,[],e.paths):{})}):blocker('unreadable')};
 }
}
async function safePathsAsync(dir,ignore=[],only){
 const rows=(await require('./git-read').command(dir,['status','--porcelain','--no-renames','--untracked-files=all','-z'],{encoding:null,maxBuffer:16*1024*1024})).toString().split('\0').filter(Boolean);
 const paths=[],hidden=[];
 const selected=only?rows.filter(row=>only.includes(row.slice(3))):rows;
 for(const row of selected){const f=row.slice(3);if(ignore.includes(f))continue;
  if(!f||path.isAbsolute(f)||f.split('/').includes('..')||/[\u0000-\u001f\u007f]/.test(f)||/(^|\/)(\.env(?:\..*)?|\.npmrc|\.dev\.vars(?:\..*)?|settings\.local\.json)$|secret|credential|password|token|auth|private.?key/i.test(f)){hidden.push(f);continue;}
  if(paths.length<100)paths.push(f);
 }
 return {paths,hiddenPaths:hidden.length,morePaths:Math.max(0,selected.filter(row=>!ignore.includes(row.slice(3))).length-hidden.length-paths.length)};
}
async function checkAsync(gitw,dir,side){
 const label=side==='source'?'作業用コピー':'本体';
 const blocker=(kind,details={})=>({side,kind,reason:lt(kind==='dirty'?`${label}に未保存の変更があります`:kind==='merging'?`${label}のマージが途中です`:`${label}の保存状態を読み取れません`),next:lt(kind==='dirty'?`${label}の変更内容を確認し、必要な変更をGitに保存してから、最新の記録を確認してください`:kind==='merging'?`${label}のマージを完了または安全に中止してから、最新の記録を確認してください`:`${label}の場所・Git・読取権限を確認してから、最新の記録を確認してください`),paths:[],...details});
 try{
  if(!dir)return {blocker:blocker('unreadable')};
  if(await gitw.mergingAsync(dir))return {blocker:blocker('merging')};
  const targetProblem=side==='target'&&await gitw.mergeTargetProblemAsync?.(dir);
  if(targetProblem)return {blocker:blocker(targetProblem,{reason:targetProblem==='bisect'?'本体でGitの原因調査が途中です':'本体のブランチが選ばれていません',next:'本体の保存先とGitの状態を確認してから、最新の記録を確認してください'})};
  const ignored=side==='target'?await writes.ignoredAsync(dir):[],snapshot=await gitw.inspectAsync(dir,{readOnly:true,...(ignored.length?{ignore:ignored}:{})});
  if(!snapshot)return {blocker:blocker('unreadable')};
  if(snapshot.status)return {blocker:blocker('dirty',await safePathsAsync(dir,ignored))};
  return {snapshot};
 }catch(e){
  if(e?.code==='GIT_READ_CHANGED')return {blocker:blocker('changed',{reason:lt('確認中に保存状態が変わりました。少し待ってから開き直してください'),next:lt('少し待ってから開き直してください')})};
  const reasons={
   NESTED_GIT_UNRECEIVED:['nested-git',`${label}の内部に別のGitがあります。未受領の成果と履歴の保全が必要です`,'内部のGitをフォルダ全体で別保管し、内容・権限・履歴を照合して保管記録を保存してから、最新の記録を確認してください。無視・削除・参照だけの保存はしないでください'],
   INSPECT_FILE_LIMIT:['file-limit',`${label}の未追跡ファイルが照合件数の上限を超えています`,'成果を保全したうえで未追跡ファイルを整理し、最新の記録を確認してください'],
   INSPECT_BYTE_LIMIT:['byte-limit',`${label}の未追跡ファイルが照合容量の上限を超えています`,'成果を保全したうえで未追跡ファイルを整理し、最新の記録を確認してください'],
   INSPECT_FILE_TYPE:['file-type',`${label}に照合できない種類の未追跡項目があります`,'特殊ファイルの種類と保管方法を確認してください']
  },r=reasons[e?.code];
  return {blocker:r?blocker(r[0],{reason:lt(r[1]),next:lt(r[2]),...(e.code==='NESTED_GIT_UNRECEIVED'?await safePathsAsync(dir,[],e.paths):{})}):blocker('unreadable')};
 }
}
function refusal(blocker){return {error:blocker.reason,blocker,stage:'preview',delivery:{state:'not-sent'}};}
module.exports={check,checkAsync,refusal};
