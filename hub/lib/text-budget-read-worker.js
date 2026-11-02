'use strict';
// Only a read-only plan is computed here; tokens, idle checks and all writes
// stay in the server's TextBudget instance.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
function run(args){return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{workerData:args,resourceLimits:{maxOldGenerationSizeMb:128}});let received=false;
  worker.once('message',m=>{received=true;if(m.error)reject(Error(m.error));else resolve(m);});
  worker.once('error',reject);worker.once('exit',code=>{if(!received)reject(Error('body plan worker exited: '+code));});
});}
module.exports={plan:args=>run(args),pending:args=>run({...args,operation:'pending'})};
if(!isMainThread&&workerData){try{
  const {root,p,file,state}=workerData,{TextBudget}=require('./text-budget');
  const store={root,readProject:()=>p,taskFile:()=>file,readTask:()=>({state})};
  const b=new TextBudget({store}),dependencies=new Map();
  if(workerData.operation==='pending'){
    // Preview only needs unresolved IDs, never the large before/after bodies.
    const pending=b.pending(workerData.project).map(({file,j})=>({file,j:{id:j.id,project:j.project,task:j.task,stage:j.stage}}));
    parentPort.postMessage({pending,status:b.requestStatus(workerData.project,workerData.task,workerData.request)});
  }else{
    const value=b.buildPlan(workerData.project,workerData.task,undefined,dependencies);
    parentPort.postMessage({value,dependencies:[...dependencies]});
  }
}catch(e){parentPort.postMessage({error:e.message});}}
