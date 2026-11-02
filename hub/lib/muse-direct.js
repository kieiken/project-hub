'use strict';
// Dedicated human-composed Muse destination. No CLI AI, prompt/history builder,
// automatic question retries. Bounded reply reads are scheduled separately.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { MuseApprovals, read } = require('./muse-approvals');
const { checkDirectory } = require('./muse-settings');
const chat = require('./chat');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const waiting = 'Museへ送信済み・返答待ちです。［返答を確認］で回答だけを読み取れます。回答が長い場合は数分かかります。次の質問は回答取得後に送れます。書いた下書きは残ります。';
const notice = 'Museの結果を確認できません。送信を繰り返さず、この会話で確認を依頼してください。';
const rejected = '回答を求める質問の送信前に処理が止まりました。初回の相談作成に成功している場合、質問の文章は相談の題名としてMuseへ届いています。今回の資料と、回答を求める質問の送信は行っていません。［送信前の状態を照合］はローカル記録だけを確認します。自動で再送しません。';
const unsent = '照合が完了しました。質問の文章は相談の題名としてMuseへ届いています。資料と、回答を求める質問の送信は行っていません。自動で再送しません。必要なら質問を書いて新しく送ってください。';
const followupUnsent = '照合が完了しました。今回の質問と資料はMuseへ届いていません。質問は相談の題名としても届いていません。自動で再送しません。必要なら質問を書いて新しく送ってください。';
const exchangeLimit = 'この相談は往復の上限に達したため、今回の質問は送っていません。新しい話題から送ってください。';
const unsentNotice = d => d.diagnostic?.code==='exchange_limit'?exchangeLimit:d.recovery?.proof?.scope==='follow-up-none'?followupUnsent:unsent;
class MuseDirect {
  constructor({muse, probe, emit = () => {}, now = Date.now}) {
    Object.assign(this,{muse,probe,emit,now});
    this.approvals = new MuseApprovals({muse}); this.active = new Map(); this.cancels = new Map();
    this.scheduler = new (require('./muse-reply-scheduler').MuseReplyScheduler)(this);
  }
  busy() { return [...this.active.values()]; }
  stop(project,task) { this.cancels.get(project+'\0'+task)?.abort(); }
  materials(items) {
    if (!Array.isArray(items) || items.length > 10) throw Error('資料は10件までです。');
    let bytes = 0;
    return items.map(item => {
      if (!item || Object.keys(item).some(k=>!['path','name'].includes(k)) || typeof item.path !== 'string' || typeof item.name !== 'string' || item.name.length > 240) throw Error('資料を選び直してください。');
      const file=path.resolve(item.path);
      if (!path.isAbsolute(item.path) || file!==item.path || !/\.(txt|md|csv|tsv)$/i.test(file) || file.split(path.sep).some(x=>['.git','.env','auth','credential-intake'].includes(x)) || /(?:credentials?|cookies?|tokens?|secrets?|storage[-_]?state)/i.test(path.basename(file))) throw Error('Museへの直接添付はテキスト・Markdown・CSV・TSVに対応しています。その他はAIに整理を依頼してください。');
      checkDirectory(path.dirname(file));
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const s=fs.fstatSync(fd);
        if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.size>24000)throw Error('資料が大きすぎるか、安全に読めません。');
        const raw=fs.readFileSync(fd),a=fs.fstatSync(fd);
        if(s.size!==a.size||s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs)throw Error('資料が変わりました。');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
        bytes+=Buffer.byteLength(text+item.name);
        if(!text.trim()||text.includes('\0')||bytes>24000)throw Error('資料はUTF-8の文字で合計24KBまでです。');
        return {name:item.name,text};
      } finally { fs.closeSync(fd); }
    });
  }
  decisions(project,task) {
    const loc=this.approvals.location(project,task,'index');
    if(!fs.existsSync(loc.decisions))return [];
    checkDirectory(loc.decisions);
    const rows=fs.readdirSync(loc.decisions).filter(n=>/^direct_[a-f0-9-]{36}\.json$/.test(n)).map(n=>read(path.join(loc.decisions,n)).value);
    return rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  }
  pending(project,task) {
    const rows=this.decisions(project,task).filter(d=>!['received','not-sent'].includes(d.state));
    const row=rows.find(d=>d.state!=='sent')||rows[0];
    return row?{id:row.id,state:row.state,sentAt:row.at,lastReplyCheck:row.lastReplyCheck,partial:Boolean(row.result?.partial),nextCheckAt:this.scheduler.next(row),notice:row.state==='sent'?(row.result?.partial?'Museから途中まで受信しました。続きがある可能性があります。［続きを確認］で残りを読み取れます。'+waiting:waiting):row.state==='rejected'?rejected:notice}:null;
  }
  status(project,task) {
    const pending=this.pending(project,task),latest=this.decisions(project,task)[0];
    return {pending,continuation:!pending&&latest?.state==='received'?{id:latest.id,lastReplyCheck:latest.lastReplyCheck}:null};
  }
  validProof(b,proof,original,request,loc) {
    return proof.open_confirmed===true&&proof.id===b.id&&proof.project===b.project&&proof.task===b.task&&
      proof.requestSHA===request.sha&&proof.decisionSHA===original.sha&&proof.digest===original.value.digest&&
      /^[a-f0-9]{64}$/.test(proof.markerSHA)&&typeof proof.discussion_id==='string'&&
      read(loc.file).sha===request.sha&&read(loc.decision).sha===original.sha;
  }
  applySentProof(b,loc,original,request,proof) {
    if(original.value.state!=='unknown'||proof.status!=='sent'||proof.scope!=='acknowledged-send'||
       typeof proof.exchange_id!=='string'||!this.validProof(b,proof,original,request,loc))throw Error(notice);
    const d={...original.value,state:'sent',result:{status:'sent',discussion_id:proof.discussion_id,
      exchange_id:proof.exchange_id,completion_verified:false},recovery:{at:new Date(this.now()).toISOString(),proof}};
    this.approvals.save(loc,d);
    try{this.emit(b.project,b.task,{type:'row',row:chat.appendOnce(path.join(this.muse.root,'Product',b.project),b.task,
      {role:'event',ai:'muse',request:b.id,text:'手元の受付記録から送信済みと確認しました。'+waiting},b.id+':sent-proof')});}catch{}
    return {ok:true,state:'sent',notice:waiting};
  }
  async recoverSent(b) {
    try {
      const loc=this.approvals.location(b.project,b.task,b.id),original=read(loc.decision),request=read(loc.file);
      if(original.value.state!=='unknown')return null;
      const proof=await this.muse.directInspect(b.project,b.task,loc.file);
      return this.applySentProof(b,loc,original,request,proof);
    }catch{return null;}
  }
  async reconcile(b) {
    if(!b||Object.keys(b).some(k=>!['project','task','id','generation'].includes(k))||
       !/^direct_[a-f0-9-]{36}$/.test(b.id)||!Number.isSafeInteger(b.generation))throw Error('照合する作業が変わりました。');
    const key=b.project+'\0'+b.task,loc=this.approvals.location(b.project,b.task,b.id);
    if(this.active.has(key))throw Error('Museの処理が進行中です。');
    this.probe(b);
    const original=read(loc.decision),request=read(loc.file);
    if(original.value.state==='not-sent')return {ok:true,state:'not-sent',notice:unsentNotice(original.value)};
    if(!['unknown','rejected'].includes(original.value.state))throw Error(notice);
    const cancel=new AbortController();this.cancels.set(key,cancel);
    this.active.set(key,{project:b.project,task:b.task,ai:'muse',muse:true,started:this.now(),text:'',model:''});
    try {
      const proof=await this.muse.directInspect(b.project,b.task,loc.file,cancel.signal);
      // The helper holds the existing bridge/registration locks, opens immutable
      // SQLite, and requires the old burned marker. That request cannot resume.
      // No new direct send can race this inspection in this process.
      // The remaining validation and journal write are synchronous. Remove our
      // own busy slot before the standard idle probe, which includes Muse.
      this.active.delete(key);this.probe(b);
      if(cancel.signal.aborted)throw Error(notice);
      if(proof.status==='sent')return this.applySentProof(b,loc,original,request,proof);
      if(proof.status!=='not-sent'||!['question-only','follow-up-none'].includes(proof.scope)||
         !this.validProof(b,proof,original,request,loc))throw Error(notice);
      this.approvals.save(loc,{...original.value,state:'not-sent',recovery:{at:new Date(this.now()).toISOString(),proof}});
      const message=proof.scope==='follow-up-none'?followupUnsent:unsent;
      try {this.emit(b.project,b.task,{type:'row',row:chat.appendOnce(path.join(this.muse.root,'Product',b.project),b.task,
        {role:'event',ai:'muse',request:b.id,text:message},b.id+':not-sent')});}catch{}
      return {ok:true,state:'not-sent',notice:message};
    } catch {return {ok:false,state:original.value.state,notice:'送信状態を証明できないため停止を保持しました。外部への送信・読取りはしていません。この会話で確認を依頼してください。'};}
    finally {this.cancels.delete(key);this.active.delete(key);try{this.emit(b.project,b.task,{type:'idle'});}catch{}}
  }
  reserve(loc,envelope) {
    const raw=JSON.stringify(envelope)+'\n',fd=fs.openSync(loc.file,'wx',0o600);
    try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const d={schema:1,project:envelope.project,task:envelope.task,id:envelope.id,requestSHA:sha(raw),digest:sha(canonical(envelope.request)),decision:'approve',state:'unknown',at:new Date(this.now()).toISOString()};
    this.approvals.save(loc,d,true);return d;
  }
  storeResult(b,loc,d,result,source) {
    if(!['sent','received'].includes(result.status)||result.text!==undefined&&(typeof result.text!=='string'||!result.text.trim())||!['discussion_id','exchange_id'].every(k=>typeof result[k]==='string')||result.status==='received'&&(typeof result.text!=='string'||!result.text.trim()))throw Error('unknown');
    const parent=source||{loc,d};
    const keepReceived=source?.keepReceived&&parent.d.state==='received';
    const state=keepReceived?'received':result.status;
    const previous=parent.d.savedText ?? parent.d.result?.text ?? '';
    // Compare the actual reply, before the waiting path restores saved text.
    const unchanged=Boolean(result.text&&previous&&result.text===previous);
    if(result.status==='sent'&&!result.text&&previous)result={...result,text:previous,partial:true};
    parent.d.savedText=previous;
    parent.d.result=result;parent.d.state=keepReceived?'received':'sent';this.approvals.save(parent.loc,parent.d);
    if(source){d.result=result;this.approvals.save(loc,d);}
    const pdir=path.join(this.muse.root,'Product',b.project),id=parent.d.id;
    if(result.text && result.text!==previous) {
      const text=result.text.startsWith(previous)?result.text.slice(previous.length).trim():result.text;
      if(text) {
        const row=chat.appendOnce(pdir,b.task,{role:'assistant',ai:'muse',external:true,request:id,
          text:(result.partial?'Museから途中まで受信した内容（続きがある可能性）':'Museから受信した内容（回答完了は未確認）')+'\n\n'+text,
          discussionId:result.discussion_id,exchangeId:result.exchange_id,completionVerified:false},
          previous?id+':assistant:'+sha(result.text):id+':assistant');
        this.emit(b.project,b.task,{type:'row',row});
      }
      parent.d.savedText=result.text;
    }
    if(state==='sent') {
      const row=chat.appendOnce(pdir,b.task,{role:'event',ai:'muse',request:id,text:waiting},id+':sent');
      this.emit(b.project,b.task,{type:'row',row});
    }
    // Display metadata only; never a completion signal or scheduling authority.
    const lastReplyCheck={at:new Date(this.now()).toISOString(),unchanged};
    if(source){d.state=state;this.approvals.save(loc,d);}
    parent.d.state=state;parent.d.lastReplyCheck=lastReplyCheck;this.approvals.save(parent.loc,parent.d);
    return {ok:true,state,notice:unchanged?'前回から追加はありません':state==='sent'?waiting:'Museの返答を会話に保存しました。'};
  }
  async readReply(b, automatic) {
    if(!b||Object.keys(b).some(k=>!['project','task','id','sourceId','generation'].includes(k))||!/^read_[a-f0-9-]{36}$/.test(b.id)||!/^direct_[a-f0-9-]{36}$/.test(b.sourceId)||!Number.isSafeInteger(b.generation))throw Error('返答の確認対象が変わりました。');
    const key=b.project+'\0'+b.task,loc=this.approvals.location(b.project,b.task,b.id),parent=this.approvals.location(b.project,b.task,b.sourceId);
    if(this.active.has(key))throw Error('Museの処理が進行中です。');
    if(fs.existsSync(loc.decision)){const d=read(loc.decision).value;return {ok:d.state!=='unknown',state:d.state,notice:d.state==='sent'?waiting:notice};}
    this.probe(b);
    const d=read(parent.decision).value;
    const pending=this.pending(b.project,b.task);
    if(!['sent','received'].includes(d.state)||!d.result||
       (pending ? pending.state!=='sent'||pending.id!==b.sourceId : this.decisions(b.project,b.task)[0]?.id!==b.sourceId))throw Error(notice);
    if(automatic && !this.scheduler.authorized(d,automatic))throw Error('自動確認の範囲を超えています。');
    const request={source_id:b.sourceId,discussion_id:d.result.discussion_id,exchange_id:d.result.exchange_id,expires_at:automatic?.kind==='original'?read(parent.file).value.request.expires_at:new Date(this.now()+599000).toISOString(),request_key:b.id};
    const decision=this.reserve(loc,{schema:1,project:b.project,task:b.task,id:b.id,kind:automatic?.kind==='original'?'direct-poll':'direct-read',request,createdAt:new Date(this.now()).toISOString()});
    if(automatic){decision.automatic=automatic;this.approvals.save(loc,decision);}
    const cancel=new AbortController();this.cancels.set(key,cancel);const run={project:b.project,task:b.task,ai:'muse',model:'',started:this.now(),text:'',muse:true};this.active.set(key,run);
    try {
      this.emit(b.project,b.task,{type:'busy',...run});
      const result=await this.muse[automatic?.kind==='original'?'directPoll':'directRead'](b.project,b.task,loc.file,cancel.signal);
      if(result.discussion_id!==request.discussion_id||result.exchange_id!==request.exchange_id)throw Error('read identity');
      return this.storeResult(b,loc,decision,result,{loc:parent,d,keepReceived:automatic?.kind==='original'});
    }catch{
      // The question is still known sent, even if this read lost its response.
      // Never turn the parent back to unknown or call the sending path.
      return {ok:d.state==='received',state:d.state==='received'?'received':'sent',notice:'返答を確認できませんでした。質問の再送はしていません。'};
    }finally{this.cancels.delete(key);this.active.delete(key);try{this.emit(b.project,b.task,{type:'idle'});}catch{}}
  }
  async send(b) {
    if(!b || Object.keys(b).some(k=>!['project','task','id','question','materials','generation'].includes(k)) || !/^direct_[a-f0-9-]{36}$/.test(b.id) || !Number.isSafeInteger(b.generation) || typeof b.question!=='string' || !b.question.trim() || Buffer.byteLength(b.question)>8192) throw Error('質問はUTF-8で8KBまでです。送信内容を確認してください。');
    const key=b.project+'\0'+b.task,loc=this.approvals.location(b.project,b.task,b.id);
    if(this.active.has(key))throw Error('Museへの送信が進行中です。');
    if(fs.existsSync(loc.decision)) { const d=read(loc.decision).value; return {ok:d.state==='received',state:d.state,notice:d.state==='sent'?waiting:d.state==='not-sent'?unsentNotice(d):d.state==='rejected'?rejected:notice}; }
    const pending=this.pending(b.project,b.task);if(pending)throw Error(pending.notice);
    this.probe(b);
    try{this.muse.workspace(b.project,b.task);}catch{throw Error('Museの接続が未設定です。設定の［つなぐ］でMuse連携を確認してください。');}
    const materials=this.materials(b.materials), request={question:b.question,materials,expires_at:new Date(this.now()+599000).toISOString(),request_key:b.id};
    const envelope={schema:1,id:b.id,project:b.project,task:b.task,kind:'direct',request,createdAt:new Date(this.now()).toISOString()};
    try { fs.mkdirSync(loc.dir,{mode:0o700}); } catch(e){if(e.code!=='EEXIST')throw e;}
    checkDirectory(loc.dir);
    const d=this.reserve(loc,envelope);
    const run={project:b.project,task:b.task,ai:'muse',model:'',started:this.now(),text:'',muse:true};
    const cancel=new AbortController();this.cancels.set(key,cancel);
    this.active.set(key,run);
    const pdir=path.join(this.muse.root,'Product',b.project);
    try {
      this.emit(b.project,b.task,{type:'busy',...run});
      const row=chat.appendOnce(pdir,b.task,{role:'user',ai:'muse',request:b.id,text:b.question+(materials.length?'\n\n選択資料：'+materials.map(x=>x.name).join('、'):''),external:true},b.id+':user');
      this.emit(b.project,b.task,{type:'row',row});
      const result=await this.muse.directChat(b.project,b.task,loc.file,cancel.signal);
      if(result.status==='not-sent') {
        if(result.diagnostic?.code!=='exchange_limit'||result.diagnostic.phase!=='send_prepare'||result.diagnostic.open_confirmed!==true)throw Error('unknown');
        d.state='not-sent';d.diagnostic=result.diagnostic;this.approvals.save(loc,d);
        this.emit(b.project,b.task,{type:'row',row:chat.appendOnce(pdir,b.task,{role:'event',ai:'muse',request:b.id,text:exchangeLimit},b.id+':diagnostic')});
        return {ok:false,state:'not-sent',notice:exchangeLimit};
      }
      if(['rejected','unknown'].includes(result.status)) {
        // Only a fixed, secret-free phase/code leaves the helper. This does not
        // release the pending request or permit a new send without proof.
        d.state=result.status;d.diagnostic=result.diagnostic;this.approvals.save(loc,d);
        if(d.state==='unknown'){const recovered=await this.recoverSent(b);if(recovered)return recovered;}
        const message=d.state==='rejected'?rejected:notice;
        const row=chat.appendOnce(pdir,b.task,{role:'event',ai:'muse',request:b.id,text:message},b.id+':diagnostic');
        this.emit(b.project,b.task,{type:'row',row});
        return {ok:false,state:d.state,notice:message};
      }
      return this.storeResult(b,loc,d,result);
    }catch{
      // Keep even a successfully received result when chat persistence failed.
      // No retry calls the service or reissues a permit.
      if(d.state!=='received'){try{this.approvals.save(loc,d);}catch{}}
      if(d.state==='unknown'){const recovered=await this.recoverSent(b);if(recovered)return recovered;}
      try{this.emit(b.project,b.task,{type:'row',row:chat.appendOnce(pdir,b.task,{role:'event',ai:'muse',text:d.state==='sent'?waiting:d.state==='not-sent'?unsentNotice(d):d.state==='rejected'?rejected:notice},b.id+':unknown')});}catch{}
      return {ok:d.state==='received',state:['sent','received','rejected','not-sent'].includes(d.state)?d.state:'unknown',notice:d.state==='sent'?waiting:d.state==='not-sent'?unsentNotice(d):d.state==='rejected'?rejected:notice};
    }finally{this.cancels.delete(key);this.active.delete(key);try{this.emit(b.project,b.task,{type:'idle'});}catch{}}
  }
}
module.exports={MuseDirect,canonical};
