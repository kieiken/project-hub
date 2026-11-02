'use strict';
// Display state only. Never use this record as permission for an operation.
const {createHash}=require('node:crypto');
const source=row=>createHash('sha256').update(JSON.stringify(row)).digest('hex');
const validAsks=asks=>Array.isArray(asks)&&asks.length>0&&asks.every(a=>a&&typeof a.question==='string'&&Array.isArray(a.options)&&a.options.every(o=>typeof o==='string'));
const clean=s=>s.replace(/[（(]おすすめ[）)]/g,'').trim();
const human=r=>r.role==='user'&&!r.from&&!r.origin&&!r.request&&!r.limitSwitch&&!r.automation&&!r.discussion&&!r.error&&!/^【渡した依頼：|\[task-(?:auto|summary):/.test(r.text||'');
function exactAnswer(asks,text){
  const parts=asks.length===1?[text]:text.split('\n\n');
  if(parts.length!==asks.length)return false;
  return asks.every((a,i)=>{
    const prefix=a.question+'：';
    if(asks.length>1&&!parts[i].startsWith(prefix))return false;
    const answer=parts[i].startsWith(prefix)?parts[i].slice(prefix.length):parts[i];
    if(a.options.some(o=>answer===o||answer===clean(o)))return true;
    if(!a.multi||!answer)return false;
    // Buttons submit multiple choices in their saved order, joined with 「、」.
    const ends=new Set([0]);
    for(const option of a.options)for(const end of [...ends])for(const label of new Set([option,clean(option)])){
      const token=(end?'、':'')+label;if(token&&answer.startsWith(token,end))ends.add(end+token.length);
    }
    return ends.has(answer.length);
  });
}
function pending(rows,initial=null){
  let current=initial,answer=null;
  for(const row of rows){
    if((row.summaryAuto||row.summaryApproved)&&Object.hasOwn(row,'pendingQuestion'))current=row.pendingQuestion;
    if(row.role==='assistant'&&answer){if(!row.error&&current?.source===answer)current=null;answer=null;}
    if(row.role==='assistant'&&validAsks(row.asks))current={source:source(row),asks:row.asks};
    if(current&&row.role==='event'&&row.answeredQuestionSource===current.source)current=null;
    if(current&&human(row)&&exactAnswer(current.asks,(row.text||'').trim()))answer=current.source;
  }
  return current;
}
module.exports={pending,source,validAsks};
