'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{checkVersion}=require('../lib/version-check');
const read=file=>fs.readFileSync(path.join(__dirname,'../..',file),'utf8');
test('固定前の版・日本語の変更履歴を出力副作用なしで検査する',()=>{const result=checkVersion(read);assert.equal(result.ok,true,result.error);assert.equal(result.version,JSON.parse(read('hub/package.json')).version);assert.deepEqual(result.languages,['ja']);});
test('日本語の版・履歴不一致と資料不足を固定前に拒否する',()=>{
  for(const [file,content] of [['hub/package.json','{"version":"invalid"}'],['hub/CHANGELOG.md','## 0.0.0'],['README.md',read('README.md').replace('ソース版：','旧ソース版（')],['README.md',read('README.md').replace(/ソース版：\d+\.\d+\.\d+/,'ソース版：0.0.0')]])assert.equal(checkVersion(f=>f===file?content:read(f)).ok,false,file);
  for(const missing of ['hub/package.json','hub/CHANGELOG.md','README.md'])assert.equal(checkVersion(f=>{if(f===missing)throw Error('missing');return read(f);}).ok,false,missing);
});
test('正式版の配布版と作業ソース版を区別し、Beta表記を検査条件にしない',()=>{
  const readme=read('README.md').replace(/Mac \d+\.\d+\.\d+/,'Mac 0.0.1').replace(/Windows \d+\.\d+\.\d+/,'Windows 0.0.2');
  assert.equal(checkVersion(f=>f==='README.md'?readme:read(f)).ok,true);
  assert.equal(checkVersion(f=>f==='README.md'?readme.replace(/ソース版：[^\n]+/,''):read(f)).ok,false);
});
test('通常の自動検査は未更新・欠落した言語パックを読まず日本語だけで完了する',()=>{
  for(const unavailable of ['outdated','missing']){const reads=[];const result=checkVersion(f=>{reads.push(f);if(!['hub/package.json','hub/CHANGELOG.md','README.md'].includes(f))throw Error(unavailable);return read(f);});assert.equal(result.ok,true,result.error);assert.deepEqual(reads,['hub/package.json','hub/CHANGELOG.md','README.md']);}
});
