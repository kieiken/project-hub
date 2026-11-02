'use strict';
// Never silently turn an unreceived repository into a gitlink. These failures
// carry a closed code, not raw Git stderr or file contents, for UI preflight.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
function error(code,message,paths=[]){return Object.assign(Error(message),{code,paths,delivery:{state:'not-sent'}});}
function list(dir,untracked){
 const names=untracked||execFileSync('git',['-C',dir,'ls-files','--others','--exclude-standard','-z'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}).toString().split('\0').filter(Boolean);
 // ls-files collapses an embedded repository to a directory, even with -uall.
 return names.filter(f=>fs.lstatSync(path.join(dir,f)).isDirectory()).sort();
}
function assertNone(dir,untracked){const paths=list(dir,untracked);if(paths.length)throw error('NESTED_GIT_UNRECEIVED','内部の別Gitに未受領の成果があります。履歴と内容を保全してから取り込んでください',paths);}
module.exports={list,assertNone,error};
