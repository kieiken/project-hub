'use strict';

module.exports = function queuecontrolRoutes(ctx) {
  const { ROLES_FILE, chats, freetalkAttachments, projectAttachments, fromRemote, fs, launch, limitIdentity, lt, modelError, permCmd, pickSpec, queueActions, queueEdit, queueEditable, getQueueRetreat, record, requestAccount, roleHistory, getRoleReview, roles, rolesData, send, store } = ctx;

  function handleDraft(req, res, url) {
      const p = store.readProject(url.searchParams.get('project')), task = url.searchParams.get('task');
      const item = p && store.taskFile(p.id, task) && chats.queue(p.id, task).find(x => x.id === url.searchParams.get('id'));
      if (!item) return send(res, 404, { error: 'その指示はもう待っていません' });
      if (!queueEditable(item)) return send(res, 409, { error: 'この待ち指示は編集できません' });
      return send(res, 200, { draft: queueEdit.draft(p, task, item, freetalkAttachments, projectAttachments), expectedItem: JSON.stringify(item) });
    }

  function handleReceipt(req, res, url) {
      try { if(req.headers['x-hub']!=='1')return send(res,403,{error:'接続を確認してください'});return send(res,200,(getQueueRetreat()).receipt(Object.fromEntries(url.searchParams))); }
      catch(e){return send(res,e.status||503,{error:e.message,code:e.code});}
    }

  function handleRetreat(req, res, url, b) {
      const human=require('../idea-api').humanRequest({...req,headers:{...req.headers,'x-hub-ui':req.headers['x-hub-ui']==='queue'?'ideas':''}});
      if(!human)return send(res,403,{error:'この操作は待ち指示の［台帳へ退避］から行ってください'});
      try {return send(res,200,(getQueueRetreat()).transfer(b));}
      catch(e){return send(res,e.status||503,{error:e.message,code:e.code,opId:b.opId});}
    }

  function handleEdit(req, res, url, b) {
      const p = store.readProject(b.project), file = store.taskFile(b.project, b.task);
      if (!p || !file) return send(res, 400, { error: lt('作業が見つかりません') });
      const q = chats.queue(p.id, b.task), item = q.find(x => x.id === String(b.id || ''));
      if (!item) return send(res, 404, { error: lt('その指示はもう待っていません') });
      if (!queueEditable(item)) return send(res, 409, { error: lt('この待ち指示は編集できません') });
      if (queueActions.has(chats.key(p.id, b.task)) || chats.busy(p.id, b.task)?.request === item.id) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text && !(Array.isArray(b.attachmentIds) && b.attachmentIds.length)) return send(res, 400, { error: lt('依頼を書いてください') });
      if (b.expectedText !== item.text) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
      try {
        if (b.expectedItem !== undefined ? b.expectedItem !== JSON.stringify(item) : item.editRevision || item.attachmentDraft) throw Error('待ち指示が変更されています。編集を開き直してください');
        let selection = {};
        if (b.ai !== undefined || b.model !== undefined) {
          if (!['claude', 'codex', 'agy', 'grok'].includes(b.ai) || typeof b.model !== 'string' || !b.model) throw Error('AI・モデルを選んでください');
          const t = store.readTask(file), account = requestAccount(p, b.task, b.ai, b.ai === item.ai ? item.account || 'default' : undefined);
          const model = launch.modelLabel(b.ai, b.model), invalid = modelError(b.ai, model, account);
          if (invalid) throw Error(invalid);
          const preferred = roles.EFFORTS.includes(item.effort) ? item.effort : pickSpec(t, b.ai).effort;
          const normalized = launch.normalizeEffort(b.ai, preferred);
          const effort = b.ai === 'agy' ? '高' : normalized && !launch.effortsFor(b.ai, model).includes(normalized) ? '高' : normalized;
          if (item.requireModel && !launch.flagFor(b.ai, model)) throw Error('指定モデルの起動名を確認できません');
          selection = { ai: b.ai, model, account, effort, perm: permCmd(b.ai), requiredModel: item.requireModel ? launch.flagFor(b.ai, model) : undefined, limitSlot: item.role ? limitIdentity(rolesData(), { ai: b.ai, model, role: item.role })?.limitSlot : undefined };
        }
        let editedText = text, attachmentDraft, images = item.images, projectImages = item.projectImages;
        if (b.attachmentIds !== undefined) {
          const source = queueEdit.draft(p, b.task, item, freetalkAttachments, projectAttachments);
          if (!Array.isArray(b.attachmentIds) || new Set(b.attachmentIds).size !== b.attachmentIds.length || b.attachmentIds.some(id => !source.attachments.some(x => x.id === id))) throw Error('添付情報が変更されています');
          const attachments = source.attachments.filter(x => b.attachmentIds.includes(x.id));
          // 参照の削除だけなので、既に無い画像も残存添付の保存を妨げない。
          attachmentDraft = { text: b.text, attachments };
          editedText = queueEdit.format(b.text, attachments);
          images = queueEdit.imagePaths(attachments);
          if(p.kind !== 'freetalk') projectImages = attachments.filter(x => x.kind !== 'file').map(x => x.id);
        }
        const edited = { ...item, ...selection, text: editedText, ...(item.shown !== undefined ? { shown: editedText } : {}),
          ...(b.attachmentIds !== undefined ? { attachmentDraft, images, ...(p.kind !== 'freetalk' ? { projectImages } : {}) } : { attachmentDraft: undefined }),
          ...(b.ai !== undefined || b.attachmentIds !== undefined ? { editRevision: require('node:crypto').randomUUID() } : {}), error: undefined };
        const queue = chats.setQueue(p.id, b.task, q.map(x => x.id === item.id ? edited : x), true);
        record('chatqueueedit', { project: p.id, task: b.task, ai: item.ai });
        return send(res, 200, { ok: true, queue });
      } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
    }

  function handleUnqueue(req, res, url, b) {
      if (queueActions.has(chats.key(b.project, b.task))) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
      try{(getQueueRetreat()).guard({project:b.project,task:b.task,id:b.id,action:'change'});}catch(e){return send(res,409,{error:e.message});}
      const pending = fs.existsSync(ROLES_FILE) ? roleHistory.load(ROLES_FILE).journal.review : null;
      if (pending?.project === b.project && pending.task === b.task && [pending.request, `limit-${pending.request}`].includes(b.id) && b.id) (getRoleReview()).cancel?.();
      if (fromRemote()) record('chatunqueue', b);
      return send(res, 200, { ok: true, queue: chats.unqueue(b.project, b.task, String(b.id || '')) });
    }

  return {
    draft: { matches: (req, url) => req.method === 'GET' && url.pathname === '/api/chat/queue/draft', handle: handleDraft },
    receipt: { matches: (req, url) => req.method==='GET' && url.pathname==='/api/chat/queue/retreat', handle: handleReceipt },
    retreat: { matches: (req, url) => url.pathname === '/api/chat/queue/retreat', handle: handleRetreat },
    edit: { matches: (req, url) => url.pathname === '/api/chat/queue/edit', handle: handleEdit },
    unqueue: { matches: (req, url) => url.pathname === '/api/chat/unqueue', handle: handleUnqueue },
  };
};
