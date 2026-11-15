'use strict';
// Reuse local extraction with storage scoped to one project task.
const fs = require('./platform/file-io'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { noLinks, exists } = require('./remove');
const { FreetalkAttachments } = require('./freetalk-attachments');
const { attachmentName } = require('./freetalk');
const { lt } = require('./locale');
class ProjectAttachments {
  constructor(store, history) { this.store = store; this.history = history; }
  forProject(p) {
    const base = task => {
      const file = this.store.taskFile(p.id,task);
      if (!file || p.kind === 'freetalk') throw Error(lt('作業が見つかりません'));
      noLinks(file);
      const dir = path.join(p.dir,'.ai','work',task,'chat-attachments'); noLinks(dir); return dir;
    };
    const storage = {
      home: os.homedir(),
      checkGeneration: (task,generation) => {
        base(task);
        if (generation !== this.history.state(p.id,task).generation) throw Error(lt('会話が切り替わりました。新しい会話を開いてください'));
      },
      upload: (task,name,data) => {
        const dir = base(task); fs.mkdirSync(dir,{recursive:true});
        const file = path.join(dir,randomUUID()+'-'+attachmentName(name)), temp = file+'.uploading';
        try { fs.writeFileSync(temp,data,{flag:'wx'}); fs.renameSync(temp,file); }
        catch(e) { if(exists(temp))fs.unlinkSync(temp); throw e; }
        return file;
      }
    };
    return new FreetalkAttachments(storage,{base,previewUrl:(task,id,file)=>'/api/file/view?'+new URLSearchParams({project:p.id,task,path:file})});
  }
}
module.exports = { ProjectAttachments };
