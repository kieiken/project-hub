'use strict';
// 添付の原本コピー・参照用ファイル・状態を同じ話題の中に保管する。
const fs = require('./platform/file-io'), path = require('node:path'), os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { noLinks, exists } = require('./remove');
const { lt } = require('./locale');
const start = require('./start');
const platforms = require('./platform');
const run = promisify(execFile), TEXT_LIMIT = 500000, PACKAGE_LIMIT = 256 * 1024 * 1024, FILE_LIMIT = 20000;
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|ts|py|log|rtf)$/i;
const { PDF_SCRIPT } = platforms;
// 添付のXMLは外部から来るため、後戻りする正規表現を使わず前から一度だけ走査する。
// 閉じがない開始は、後ろの開始も同じく閉じを持てないので、そこで打ち切る。
function cdataText(s) {
  let out = '', pos = 0;
  for (let i; (i = s.indexOf('<![CDATA[', pos)) >= 0;) {
    const end = s.indexOf(']]>', i + 9);
    if (end < 0) break;
    out += s.slice(pos, i) + s.slice(i + 9, end); pos = end + 3;
  }
  return out + s.slice(pos);
}
function xmlText(xml) {
  const parts = [];
  for (let pos = 0, i; (i = xml.indexOf('<a:t', pos)) >= 0;) {
    const c = xml.charAt(i + 4);
    if (c !== '>' && !/\s/.test(c)) { pos = i + 1; continue; }
    const gt = xml.indexOf('>', i + 4), end = gt < 0 ? -1 : xml.indexOf('</a:t>', gt + 1);
    if (end < 0) break;
    parts.push(xml.slice(gt + 1, end)); pos = end + 6;
  }
  return parts.map(m => cdataText(m).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, v) => {
    if (v[0] === '#') { const n = v[1].toLowerCase() === 'x' ? parseInt(v.slice(2),16) : Number(v.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[v] || all;
  })).join('\n');
}
function readSafe(file, max = start.MAX) {
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd), real = fs.statSync(file);
    if (!st.isFile() || st.size > max || st.dev !== real.dev || st.ino !== real.ino || fs.realpathSync(file) !== file) throw Error(lt('このファイルは添付できません'));
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
class FreetalkAttachments {
  constructor(ft, { platform = platforms } = {}) { this.ft = ft; this.platform = platform; }
  base(task) { this.ft.history.topic(task); const dir = path.join(this.ft.dir,'topics',task); noLinks(dir); return dir; }
  derived(task, id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw Error(lt('添付ファイルの指定が正しくありません'));
    const dir = path.join(this.base(task),'.derived',id); noLinks(dir); return dir;
  }
  async upload(task, name, data, generation) {
    this.ft.checkGeneration(task,generation);
    if (!data.length || data.length > start.MAX) throw Error(lt('ファイルは1件50MBまでです'));
    const file = this.ft.upload(task,name,data);
    return this.prepare(task,file,generation);
  }
  async fromPath(task, raw, generation) {
    this.ft.checkGeneration(task,generation);
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw Error(lt('このファイルは添付できません'));
    let file = path.resolve(raw);
    // macOS標準の /var・/tmp の別名だけを正規化する。中のリンクは拒否する。
    for(const root of [os.tmpdir(),'/tmp'])if(exists(root) && file.startsWith(path.resolve(root)+path.sep)) {
      file=path.join(fs.realpathSync(root),path.relative(path.resolve(root),file));break;
    }
    noLinks(file);
    const allowed = [this.ft.home,os.tmpdir(),'/private/tmp'].filter(exists).map(x => fs.realpathSync(x));
    if (!allowed.some(dir => file.startsWith(dir + path.sep))) throw Error(lt('この場所のファイルは追加できません'));
    if (!fs.lstatSync(file).isDirectory()) return this.upload(task,path.basename(file),readSafe(file),generation);
    if (!/\.key$/i.test(file)) throw Error(lt('フォルダはKeynoteのパッケージだけ添付できます'));
    const entries = []; let bytes = 0;
    const walk = (src, rel = '') => {
      noLinks(src); const st = fs.lstatSync(src);
      if (entries.length >= FILE_LIMIT) throw Error(lt('ファイルが多すぎます'));
      if (!st.isFile() && !st.isDirectory()) throw Error(lt('特殊なファイルは添付できません'));
      bytes += st.isFile() ? st.size : 0;
      if (bytes > PACKAGE_LIMIT) throw Error(lt('Keynoteのパッケージは256MBまでです'));
      entries.push({src,rel,dir:st.isDirectory(),size:st.size});
      if (st.isDirectory()) for (const n of fs.readdirSync(src)) walk(path.join(src,n),path.join(rel,n));
    };
    walk(file);
    const base = this.base(task); fs.mkdirSync(base,{recursive:true});
    const dest = path.join(base,randomUUID()+'-'+require('./freetalk').attachmentName(file)), temp = dest+'.uploading';
    try {
      for (const e of entries) {
        const to = path.join(temp,e.rel);
        if (e.dir) fs.mkdirSync(to);
        else fs.writeFileSync(to,readSafe(e.src,PACKAGE_LIMIT),{flag:'wx'});
      }
      fs.renameSync(temp,dest);
    } catch (e) { if(exists(temp))fs.rmSync(temp,{recursive:true}); throw e; }
    return this.prepare(task,dest,generation);
  }
  async prepare(task, file, generation) {
    const id = path.basename(file).slice(0,36);let derived;
    try {
      derived=this.derived(task,id);
      fs.mkdirSync(derived,{recursive:true});
      const result = {id,name:path.basename(file).slice(37),kind:start.IMAGE.test(file)?'image':'file',path:file,status:'ok',message:'',referencePaths:[file],generation};
      const writeText = text => {
        const clipped = text.length > TEXT_LIMIT;
        const output = path.join(derived,'text.txt'); fs.writeFileSync(output,text.slice(0,TEXT_LIMIT),{flag:'wx'});
        result.referencePaths.push(output);
        if(clipped){result.status='partial';result.message=lt('文字が多いため、先頭50万文字のみ参照できます');}
      };
      if (start.IMAGE.test(file)) {
        result.imagePath = file;
        if (!/\.(png|jpe?g)$/i.test(file)) {
          result.imagePath = path.join(derived,'image.png');
          try { start.convertImage(file,result.imagePath); } catch { throw Error(lt('画像をPNGに変換できませんでした。画像を書き出し直して追加してください')); }
          result.referencePaths = [result.imagePath]; result.path = result.imagePath;
        }
      } else if (/\.pdf$/i.test(file)) {
        try {
          const stdout = await this.platform.readPdfText(file, run);
          if (!stdout.trim()) { result.status='unsupported';result.message=lt('画像のみのPDFです。本文を抽出できません'); }
          else writeText(stdout);
        } catch { result.status='unsupported';result.message=lt('PDFの本文を抽出できませんでした'); }
      } else if (/\.(pptx|key)$/i.test(file)) {
        const keynote = /\.key$/i.test(file), deadline = Date.now()+30000;
        const unzip = args => this.platform.readArchive(args,{timeout:Math.max(1,deadline-Date.now()),maxBuffer:8*1024*1024});
        try {
          const packageDir = fs.lstatSync(file).isDirectory();
          let members;
          if(packageDir)members=['preview.jpg','preview.png','preview-web.jpg','Metadata/Preview.jpg'].filter(n=>exists(path.join(file,n)));
          else members=(await unzip(['-Z','-1',file])).stdout.trim().split('\n');
          if(members.length > FILE_LIMIT)throw Error('archive too large');
          if (!keynote) {
            const xmls = members.filter(n=>/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
            if(xmls.length>1000)throw Error('too many slides');
            let text='';
            for(const member of xmls){const content=xmlText((await unzip(['-p',file,member])).stdout);if(content.trim())text+=member+'\n'+content+'\n\n';if(text.length>TEXT_LIMIT)break;}
            result.status = text.trim() ? 'partial' : 'unsupported';
            result.message = lt(text.trim() ? 'スライドの文字とノートのみ参照できます。画像・図・配置は読み取れません' : 'PPTXに抽出できる文字・ノートがありません');
            if(text.trim())writeText(text);
          }
          const preview = ['preview.jpg','preview.png','preview-web.jpg','Metadata/Preview.jpg','docProps/thumbnail.jpeg','docProps/thumbnail.jpg','docProps/thumbnail.png'].find(n=>members.includes(n));
          if(preview){
            const output=path.join(derived,'preview'+path.extname(preview).toLowerCase());
            const data=packageDir?readSafe(path.join(file,preview)):(await this.platform.readArchive(['-p',file,preview],{timeout:Math.max(1,deadline-Date.now()),maxBuffer:start.MAX,encoding:'buffer'})).stdout;
            fs.writeFileSync(output,data,{flag:'wx'});result.imagePath=output;result.referencePaths.push(output);
          }
        } catch { result.status='unsupported';result.message=lt(keynote ? 'Keynoteのプレビューを取得できませんでした' : 'PPTXの文字・ノートを抽出できませんでした'); }
        if(keynote){result.status='unsupported';result.message=lt('Keynoteの本文は読めません。PDFかPPTXに書き出して添付してください');}
      } else if (!TEXT.test(file)) { result.status='unsupported';result.message=lt('この形式の内容参照には対応していません'); }
      this.ft.checkGeneration(task,generation);
      if(result.imagePath)result.url='/api/freetalk/attachment?'+new URLSearchParams({project:'freetalk',task,id});
      fs.writeFileSync(path.join(derived,'attachment.json'),JSON.stringify(result)+'\n',{flag:'wx'});
      return result;
    } catch(e) {
      // この処理で作ったコピーと派生物だけを戻す。元のファイルには触れない。
      if(derived && exists(derived))fs.rmSync(derived,{recursive:true});
      if(exists(file))fs.rmSync(file,{recursive:fs.lstatSync(file).isDirectory()});
      throw e;
    }
  }
  descriptor(task,id) {
    const result=JSON.parse(readSafe(path.join(this.derived(task,id),'attachment.json'),1024*1024));
    for(const file of [...result.referencePaths,result.imagePath].filter(Boolean)) {
      if(!file.startsWith(this.base(task)+path.sep))throw Error(lt('添付ファイルの指定が正しくありません'));
      noLinks(file);if(!exists(file))throw Error(lt('添付ファイルが見つかりません'));
    }
    return result;
  }
  discard(task,result) {
    const derived=this.derived(task,result.id),original=path.join(this.base(task),result.id+'-'+result.name);
    if(exists(derived))fs.rmSync(derived,{recursive:true});
    noLinks(original);if(exists(original))fs.rmSync(original,{recursive:fs.lstatSync(original).isDirectory()});
  }
  images(task,ids) {
    if(!Array.isArray(ids)||ids.length>20)throw Error(lt('添付ファイルの指定が正しくありません'));
    return ids.map(id=>this.descriptor(task,id).imagePath).filter(Boolean);
  }
  preview(task,id) {
    const file=this.descriptor(task,id).imagePath;
    if(!file || !/\.(png|jpe?g)$/i.test(file))throw Error(lt('画像が見つかりません'));
    return {data:readSafe(file),type:/\.jpe?g$/i.test(file)?'image/jpeg':'image/png'};
  }
}
module.exports={FreetalkAttachments,xmlText,PDF_SCRIPT,TEXT_LIMIT,PACKAGE_LIMIT,FILE_LIMIT};
