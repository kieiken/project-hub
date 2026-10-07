'use strict';
const { lt } = require('./locale');
// 自動で合わせるのは版の行と、既存履歴を一字も変えない追加節だけ。
const path = require('node:path');
const version = s => /^\d+\.\d+\.\d+$/.test(s || '') && s.split('.').map(Number);
const compare = (a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2];
const markers = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m;
function plan({read, paths, base, ours, theirs, merged, title, date = new Date().toISOString().slice(0,10)}) {
  try {
    if (!paths.length) return null;
    const folder = path.posix.dirname(paths[0]);
    const file = n => folder === '.' ? n : folder+'/'+n;
    const names = ['package.json','package-lock.json','CHANGELOG.md'].map(file);
    if (paths.some(p => !names.includes(p))) return null;
    const pkg = ref => JSON.parse(read(ref,file('package.json')));
    const bv = version(pkg(base).version), ov = version(pkg(ours).version), tv = version(pkg(theirs).version);
    if (!bv || !ov || !tv || compare(tv,bv)<=0) return null;
    for(const [ref,v] of [[base,bv],[ours,ov],[theirs,tv]]) {
      const lock=JSON.parse(read(ref,file('package-lock.json')));
      if(lock.version!==v.join('.') || (lock.packages?.['']&&lock.packages[''].version!==lock.version))return null;
    }
    const next = tv[0]!==bv[0] ? [ov[0]+1,0,0] : tv[1]!==bv[1] ? [ov[0],ov[1]+1,0] : [ov[0],ov[1],ov[2]+1];
    const to = (compare(next,tv)>0 ? next : tv).join('.');
    const output = {};
    for (const name of names.slice(0,2)) {
      const text = read(merged,name);
      if (typeof text !== 'string') return null;
      // 競合ハンクは各側がversion行1行だけ。依存先のversion競合は下の構造比較で拒否。
      const hunks = /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
      let bad = false;
      const choose = side => text.replace(hunks,(_all,a,b) => {
        if (![a,b].every(x=>/^\s*"version": "\d+\.\d+\.\d+",?\n$/.test(x))) bad=true;
        return side ? b : a;
      });
      const left=choose(0),right=choose(1);
      if(bad || markers.test(left) || markers.test(right))return null;
      const a=JSON.parse(left),b=JSON.parse(right);
      const strip = obj => {const c=structuredClone(obj);delete c.version;if(name===file('package-lock.json')&&c.packages?.[''])delete c.packages[''].version;return c;};
      if(JSON.stringify(strip(a))!==JSON.stringify(strip(b)))return null;
      if(!version(a.version)||!version(b.version))return null;
      // 書式も非競合部分も保持する。rootとpackages[""]以外の版行は変えない。
      let changed=0;
      let rewritten=left.replace(/^  "version": "[^\n"]*"/m,()=>{changed++;return `  "version": "${to}"`;});
      const expected=name===file('package-lock.json')&&a.packages?.['']?2:1;
      if(expected===2)rewritten=rewritten.replace(/^    "": \{\n([\s\S]*?)^    \}/m,(block)=>block.replace(/^      "version": "[^\n"]*"/m,()=>{changed++;return `      "version": "${to}"`;}));
      if(changed!==expected)return null;
      const result=rewritten,parsed=JSON.parse(result);
      if(parsed.version!==to || (expected===2&&parsed.packages[''].version!==to) || JSON.stringify(strip(parsed))!==JSON.stringify(strip(a)))return null;
      output[name]=result;
    }
    const logName=file('CHANGELOG.md'),old=read(base,logName),current=read(ours,logName),child=read(theirs,logName);
    const split = s => {const at=s.search(/^## /m);if(at<0)throw Error(lt('履歴の見出しがありません'));return [s.slice(0,at),s.slice(at)];};
    const [header,history]=split(old);
    for(const [log,v] of [[old,bv],[current,ov],[child,tv]])if(log.match(/^## ([\d.]+)/m)?.[1]!==v.join('.'))return null;
    const added = s => {
      const [h,body]=split(s);
      if(h!==header || !body.endsWith(history))throw Error(lt('既存の履歴が変わっています'));
      const prefix=body.slice(0,body.length-history.length);
      if(prefix && !/^## \d+\.\d+\.\d+(?:（[^\n]*）| \([^\n]*\))?\n/.test(prefix))throw Error(lt('新しい節が不正です'));
      if(prefix.split('\n').some(l=>l.startsWith('## ')&&!/^## \d+\.\d+\.\d+(?:（[^\n]*）| \([^\n]*\))?$/.test(l)))throw Error(lt('新しい節が不正です'));
      return prefix;
    };
    added(current);const additions=added(child);if(!additions)return null;
    const bullets=additions.replace(/^## [^\n]*\n/gm,'').trim();
    output[logName]=lt`${header}## ${to}（${date}）\n- 子作業「${String(title).replace(/[\r\n]/g,' ')}」を統合（子では ${tv.join('.')}）\n${bullets}\n\n${split(current)[1]}`;
    if(Object.values(output).some(s=>markers.test(s)))return null;
    return {output,autoResolved:{files:names,from:ov.join('.'),to}};
  } catch { return null; }
}
module.exports={plan};
