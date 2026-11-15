'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const path=require('node:path');
const {noLinks}=require('./token-usage-scan');
const {read}=require('./token-usage-store');
(async()=>{try{
 noLinks(workerData.dir);
 const preferences=read(path.join(workerData.dir,'preferences.json'))||{};
 const {snapshot,storage}=await require('./token-usage-compact').run({...workerData,preferences,progress:p=>parentPort.postMessage({progress:p})});
 parentPort.postMessage({snapshot,storage});
}catch{parentPort.postMessage({failed:true});}})();
