'use strict';
// Pure validation, also used by export-public. No export or file mutation.
function checkVersion(read,{languages=['ja']}={}) {
  try {
    const version=JSON.parse(read('hub/package.json')).version;
    if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('版番号が不正です');
    const changelog=read('hub/CHANGELOG.md'),readme=read('README.md');
    if(changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1]!==version||readme.match(/^ソース版：(\d+\.\d+\.\d+)（/m)?.[1]!==version)throw Error('日本語の版番号が一致しません');
    if(languages.includes('zh-TW')) {const c=read('langpacks/zh-TW/docs/CHANGELOG.md'),r=read('README.zh-TW.md');if(c.match(/^## (\d+\.\d+\.\d+)/m)?.[1]!==version||!r.includes(`開發中的版本（v${version}）`)||!r.includes(`目前版本（${version}）`))throw Error('繁体字の版番号が一致しません');}
    return {ok:true,version,languages};
  }catch(e){return {ok:false,error:e.message};}
}
module.exports={checkVersion};
