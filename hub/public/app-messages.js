'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function trimUrl(u) {
  // 括弧は最初に一度だけ数え、末尾から外した分だけ減らす（長い URL でも数え直さない）。
  const punct = ".,;:!?'*";
  let end = u.length, open = 0, close = 0, openSq = 0, closeSq = 0;
  for (let i = 0; i < u.length; i++) {
    const ch = u[i];
    if (ch === '(') open++; else if (ch === ')') close++; else if (ch === '[') openSq++; else if (ch === ']') closeSq++;
  }
  while (end && punct.includes(u[end - 1])) end--;
  for (;;) {
    const n = end;
    if (u[end - 1] === ')' && open < close) { end--; close--; }
    if (u[end - 1] === ']' && openSq < closeSq) { end--; closeSq--; }
    while (end && punct.includes(u[end - 1])) end--;
    if (end === n) return u.slice(0, end);
  }
}

// [名前](行先) を、その [ の位置から読む。区切りの位置は前へ進みながら一度だけ探して使い回し、
// [ や ]( が多い長い行でも、[ ごとに名前や行先を読み直さない。
function markdownLinks(s) {
  const until = re => {
    let from = 0, to = -1;
    return i => {
      if (i < from || i > to) { re.lastIndex = from = i; const m = re.exec(s); to = m ? m.index : s.length; }
      return to;
    };
  };
  const nameEnd = until(/[\]\n]/g), angleEnd = until(/[>\n]/g), targetEnd = until(/[)\s]/g);
  return p => {
    const q = nameEnd(p + 1), a = q + 2;
    if (q === p + 1 || s[q] !== ']' || s[q + 1] !== '(') return null;
    const name = s.slice(p + 1, q);
    if (s[a] === '<') {
      const r = angleEnd(a + 1);
      if (r > a + 1 && s[r] === '>' && s[r + 1] === ')') return { name, target: s.slice(a, r + 1), end: r + 2 };
    }
    const r = targetEnd(a);
    return r > a && s[r] === ')' ? { name, target: s.slice(a, r), end: r + 1 } : null;
  };
}

function linkify(text) {
  const s = String(text == null ? '' : text), links = markdownLinks(s);
  let out = '', last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    // LINK_RE は [ だけを拾う。続きが [名前](行先) の形でなければ、ただの文字として先へ進む。
    const link = m[0] === '[' ? links(m.index) : undefined;
    if (link === null) continue;
    // Markdown画像も場所リンクとして扱い、記法の ! を表示に残さない。
    const image = link !== undefined && m.index > last && s[m.index - 1] === '!';
    out += esc(s.slice(last, image ? m.index - 1 : m.index));
    if (link) LINK_RE.lastIndex = link.end;
    last = LINK_RE.lastIndex;
    if (link) { // [名前](URL または場所)
      const t = link.target.replace(/^<|>$/g, '').replace(/^file:\/\//, '');
      let dec = t; try { dec = decodeURI(t); } catch (e) { /* そのまま */ }
      const local = dec.replace(/#L?\d+(-L?\d+)?$/, '');
      out += /^https?:\/\//.test(t) ? urlLink(t, link.name) : isPath(dec) ? image && /\.(png|jpe?g|gif|webp)$/i.test(local) ? imagePathLink(local, link.name) : pathLink(local, link.name) : esc(s.slice(m.index, link.end));
    } else if (m[1]) { const u = trimUrl(m[1]); out += urlLink(u) + esc(m[1].slice(u.length)); LINK_RE.lastIndex = last = m.index + m[1].length; }
    else if (m[2] !== undefined) {
      const c = m[2].trim();
      out += /^https?:\/\//.test(c) ? '`' + urlLink(c) + '`' : isPath(c) ? '`' + pathLink(c) + '`' : esc(m[0]);
    }
    else { const raw = m[3] || m[4]; let end = raw.length; while (end && '.,;:!?'.includes(raw[end - 1])) end--; out += pathLink(raw.slice(0, end)) + esc(raw.slice(end)); }
  }
  return out + esc(s.slice(last));
}

function richText(text, streaming = false) {
  const value=String(text??'');
  // Without either marker no line can start a quote or fenced block. Keep the
  // same table/link renderer, avoiding per-line arrays and regular expressions.
  if(!value.includes('>') && !value.includes('```'))return tables(value);
  const lines=value.match(/[^\n]*\n|[^\n]+$/g)||[];
  let out='', plain='', code='', quote='', quoting=false, fence=0, lang='';
  for(const line of lines) {
    const raw=line.replace(/\r?\n$/, ''), start=raw.match(/^ {0,3}(`{3,})([^`]*)$/);
    if(!fence && /^ {0,3}>/.test(raw)) {
      if(!quoting) {out+=tables(plain);plain='';quoting=true;}
      quote+=line.replace(/^ {0,3}> ?/, '');
      continue;
    }
    flushQuote();
    if(!fence && start) {out+=tables(plain);plain='';fence=start[1].length;lang=start[2].trim().split(/\s+/)[0]||UI.text('テキスト');code='';}
    else if(fence && new RegExp('^ {0,3}`{'+fence+',}\\s*$').test(raw)) {
      out+=block(code, false);fence=0;
    } else if(fence) code+=line; else plain+=line;
  }
  flushQuote();
  if(fence)out+=block(code,true);else out+=tables(plain);
  return out;
  function flushQuote() {
    if(!quoting)return;
    out+=UI.template`<div class="codeblock quote-block"><div class="cb-head"><span>${UI.text('引用')}${streaming?UI.text(' ・書きかけ'):''}</span>${streaming?'':UI.html('<button type="button" class="cb-copy quote-copy" aria-label="引用の本文をコピー">⧉ 引用をコピー</button>')}</div><pre><code>${esc(quote).replace(/\r/g,'&#13;')}</code></pre></div>`;
    quote='';quoting=false;
  }
  function block(value,partial) {return UI.template`<div class="codeblock"><div class="cb-head"><span>${esc(lang)}${partial?UI.text(' ・書きかけ'):''}</span>${partial?'': UI.html('<button type="button" class="cb-copy" aria-label="この囲みをコピー">⧉ コピー</button>')}</div><pre><code>${esc(value).replace(/\r/g,'&#13;')}</code></pre></div>`;}
  // エスケープした | はセルの文字。両端の省略可能な | だけを取り除く。
  function cells(line) {
    const row=[''];let pipes=0,slashes=0;
    for(const ch of line.replace(/\r?\n$/, '')) {
      if(ch==='|') {
        if(slashes%2)row[row.length-1]=row[row.length-1].slice(0,-1)+'|';
        else {row.push('');pipes++;}
      } else row[row.length-1]+=ch;
      slashes=ch==='\\'?slashes+1:0;
    }
    if(!pipes)return null;
    if(!row[0].trim())row.shift();
    if(row.length && !row[row.length-1].trim())row.pop();
    return row.map(x=>x.trim());
  }
  function inline(value) {
    // リンク全体を先に拾い、名前や行先の記号を装飾として分断しない。
    // [ と ![ は候補だけを拾い、続きがリンクの形かは markdownLinks で一度に確かめる。
    const tokens=/!?\[|`([^`\n]+)`|\*\*([^\n]+?)\*\*/g,links=markdownLinks(value);
    let html='',last=0,m;
    while((m=tokens.exec(value))) {
      if(m[1]===undefined&&m[2]===undefined) {
        const link=links(tokens.lastIndex-1);
        if(!link)continue;
        tokens.lastIndex=link.end;
      }
      html+=linkify(value.slice(last,m.index));
      html+=m[1]!==undefined?UI.template`<code class="rt-inline">${linkify(m[1])}</code>`:m[2]!==undefined?UI.template`<strong>${inline(m[2])}</strong>`:linkify(value.slice(m.index,tokens.lastIndex));
      last=tokens.lastIndex;
    }
    return html+linkify(value.slice(last));
  }
  function tables(value) {
    // A table needs a pipe. Ordinary paragraphs can go straight to the same
    // link renderer without splitting and scanning every line for cells.
    if (!value.includes('|')) return linkify(value);
    const rows=value.match(/[^\n]*\n|[^\n]+$/g)||[];
    let html='',pending='';
    for(let i=0;i<rows.length;i++) {
      const head=cells(rows[i]),sep=i+1<rows.length?cells(rows[i+1]):null;
      if(!head?.length || !sep || head.length!==sep.length || !sep.every(x=>/^:?-{2,}:?$/.test(x))) {pending+=rows[i];continue;}
      html+=linkify(pending);pending='';
      const align=sep.map(x=>x.startsWith(':')&&x.endsWith(':')?'center':x.endsWith(':')?'right':'left');
      const tr=(row,tag)=>'<tr>'+head.map((_,n)=>`<${tag}${tag==='th'?' scope="col"':''} class="rt-${align[n]}">${inline(row[n]??'')}</${tag}>`).join('')+'</tr>';
      html+=UI.html('<div class="rt-table-wrap" tabindex="0" role="region" aria-label="表（横にスクロールできます）"><table class="rt-table"><thead>')+tr(head,'th')+'</thead><tbody>';
      i++;
      while(i+1<rows.length) {
        const row=cells(rows[i+1]);
        // 多すぎる列は捨てずに、元の文字として残す。
        if(!row?.length || row.length>head.length)break;
        html+=tr(row,'td');i++;
      }
      html+='</tbody></table></div>';
    }
    return html+linkify(pending);
  }
}

async function copyText(v, quiet) {
  let ok = false;
  try { await navigator.clipboard.writeText(v); ok = true; }
  catch (e) { const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove(); }
  if (!quiet) toast(ok ? UI.text('コピーしました') : UI.text('コピーできませんでした。文を選んで ⌘C でコピーしてください'));
  return ok;
}

function continuationSummary(text) {
  if(typeof text!=='string')return text;
  const next=['次にすること','次にする作業','下一步','接下來要做的工作'];
  const pending=['残件・判断待ち','人の判断待ち','剩餘工作與待決定事項','待使用者決定'];
  const headings=[...next,...pending,'承認（人の発言のみ）','核准（僅限使用者發言）','決定事項','已決定事項','理由','参照先','參照位置','參考位置','參考來源'];
  const lines=text.split('\n'),sections=[];let current=null,prefix=[];
  for(const l of lines){const label=l.trim().replace(/[：:]$/, '');if(headings.includes(label)&&/[：:]$/.test(l.trim())){current={label,lines:[l]};sections.push(current);}else (current?current.lines:prefix).push(l);}
  if(!sections.some(s=>next.includes(s.label)||pending.includes(s.label)))return text;
  for(const s of sections)if(next.includes(s.label))s.lines[0]=UI.text('次にする作業')+'：';
  const rank=s=>next.includes(s.label)?0:pending.includes(s.label)?1:2;
  return [...prefix,...sections.sort((a,b)=>rank(a)-rank(b)).flatMap(s=>s.lines)].join('\n');
}

function msgHtml(r) {
  let html=baseMsgHtml(r);const button=window.HubIdeas?.messageButton(r,{project:view.project,task:view.task})||'';
  // Search destinations find the matched message by its saved time and role.
  if(r&&(r.role==='user'||r.role==='assistant')){const attr=v=>String(v??'').replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'})[c]);html=String(html).replace(/^<div class="m(?=[\s"])/,`<div data-at="${attr(r.at)}" data-role="${r.role}" class="m`);}
  return button?html.replace(/<\/div>$/,`<div class="idea-message-action">${button}</div></div>`):html;
}

function automaticRequest(r) {
  if (r.role !== 'user' || r.from || r.error || r.asks?.length || r.summaryAuto) return false;
  if (r.origin === 'delegate' || r.origin === 'hub-internal' || r.limitSwitch?.request) return true;
  // Old records lack origin. Only the existing full, first-line envelope is
  // evidence; queued mode, a partial heading or a later quotation is not.
  return !r.origin && /^(?:【(?:渡した依頼|已交接的要求)：[^\r\n]+】|\[Delegated request: [^\r\n]+\])(?:\r?\n|$)/.test(String(r.text || ''));
}

function requestBodyHtml(r) {
  if (!automaticRequest(r)) return UI.template`<div class="mb">${richText(r.text)}</div>`;
  const text = String(r.text || ''), preview = text.slice(0, 400).split(/\r?\n/, 2).join('\n');
  // One inert text node retains the exact source, with no links, images, tables
  // or code blocks to build until opened. CR survives HTML parsing as well.
  return UI.template`<div class="mb auto-request"><div class="auto-request-preview">${esc(preview)}</div><button type="button" class="auto-request-toggle" data-request-toggle aria-expanded="false">全文を見る</button><template class="auto-request-source">${esc(text).replace(/\r/g, '&#13;')}</template><div class="auto-request-full" hidden></div></div>`;
}

function baseMsgHtml(r) {
  let time = '';
  if (r.at) {
    const date = new Date(r.at), options = { hour: '2-digit', minute: '2-digit' };
    // Invalid dates have a native label; Intl.format would throw instead.
    if (Number.isNaN(date.getTime())) time = date.toLocaleTimeString(UI.dateLocale, options);
    else {
      // One formatter for the active locale/UTC offset, not one per message.
      // The offset check also refreshes after a local timezone or DST change.
      const offset = date.getTimezoneOffset(), cached = baseMsgHtml.timeFormat;
      if (!cached || cached.locale !== UI.dateLocale || cached.offset !== offset) {
        baseMsgHtml.timeFormat = { locale: UI.dateLocale, offset, format: new Intl.DateTimeFormat(UI.dateLocale, options) };
      }
      time = baseMsgHtml.timeFormat.format.format(date);
    }
  }
  if (r.from === 'gptchat' || r.from === 'gptchat-report') {
    const child = taskOf(proj(view.project), r.childTask);
    return UI.template`<div class="m ai"><div class="mh"><b>ChatGPT（Chat／Pro）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div>${child ? gptChildLink(view.project, child.id) : UI.html('')}</div>`;
  }
  if (r.role === 'user' && r.to === 'gptchat' && r.request) return UI.template`<div class="m me" data-gpt-request="${esc(r.request)}"><div class="mh"><b data-gpt-status>ChatGPT（Chat）への依頼（未処理）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div>${gptChildLink(view.project, view.task)}</div>`;
  if (r.summaryAuto) return UI.template`<div class="m handoff"><details><summary>前の会話を整理しました（人の確認なし）・中身を見る</summary><div class="mb">${richText(continuationSummary(r.text))}</div></details></div>`;
  if (r.role === 'event' && r.answeredQuestionSource) return '';
  if (r.role === 'event' && r.continuation) return UI.template`<div class="ev" role="status">${esc(r.text)}</div>`;
  if (r.role === 'event') return isToolRow(r) && !showDetail() ? '' : UI.template`<div class="ev">▸ ${esc(r.text)}</div>`;
  if (r.role === 'user' && (r.from === 'delegate' || r.from === 'child' || r.from === 'subtask')) {
    // 過去の結果通知でも、実際の成果を確認する共通引渡しへ進む。
    const childProject = proj(r.childProject || view.project);
    const candidate = r.child && r.from !== 'child' && taskOf(childProject, r.child);
    const receiver = { project: proj(view.project), task: taskOf(proj(view.project),view.task) };
    const recordedTitle = typeof r.childTitle === 'string' ? r.childTitle : /^（子作業「(.+)」の結果）(?:\r?\n|$)/.exec(r.text || '')?.[1];
    const mismatch = candidate && recordedTitle !== undefined && recordedTitle !== candidate.title;
    const block = candidate && !mismatch && !r.handoff && !r.partialReceipt ? ProjectOrder.integrateBlock(receiver,childProject,candidate,state.projects,'continue') : null;
    const offer = candidate && (state.taskOffers||[]).find(x=>x.project===childProject.id&&x.task===candidate.id&&x.targetProject===view.project&&x.targetTask===view.task);
    const received = offer?.pending===false;
    const unchecked = offer?.received&&offer.pending!==false&&offer.receiptChecked!==true;
    const kid = !mismatch && !received && !unchecked && !r.handoff && !r.partialReceipt && !block ? candidate : null;
    const absorb = kid ? transferButton(childProject.id,kid.id,recordedTitle ?? kid.title,r.offer?UI.text('統合…'):UI.text('成果を受け取る')) : '';
    const note = r.handoff ? (r.disposition==='continue'?UI.text('この成果は受領済みです。作業と残件を保持して続けられます。新しい成果が届いたときだけ［統合…］が表示されます。'):r.integrating ? UI.text('この成果はもう受け取っています。統合や片付けが残っている場合は上部の［統合…］から進めてください。') : UI.text('この成果はもう受け取っています。片付けが残っている場合は上部の［引渡しの残りを続ける］から進めてください。'))
      : received ? UI.text('この成果は受領済みです。作業と残件を保持して続けられます。新しい成果が届いたときだけ［統合…］が表示されます。')
      : unchecked ? UI.text('受領状況が未確認です')
      : mismatch ? UI.text('この結果の子作業は今はありません（同じ番号の別の作業があります）。')
      : r.child && r.from !== 'child' && !candidate ? UI.text('この子作業は今はありません。受け取った成果は本作業の会話と［ファイルを見る］で確認できます。')
      : block || (kid && transferNeedsUpdate() ? transferUpdateMessage() : '');
    return UI.template`<div class="m ai"><div class="mh"><span class="chip"><span class="ic">↩</span>${r.from === 'delegate' ? UI.text('渡した作業の結果') : r.from === 'subtask' ? UI.text('子作業の結果') : UI.text('子プロジェクトの結果')}${r.ai ? UI.template`<small>・${esc(AI_LABEL[r.ai] || r.ai)}</small>` : ''}</span><span class="small">${time}</span>${absorb}</div>${note ? UI.template`<p class="transfer-hint">${esc(note)}</p>` : ''}<div class="mb">${richText(r.text)}</div></div>`;
  }
  if (r.role === 'user' && r.to === 'dot' && r.request) return UI.template`<div class="m me" data-dot-request="${esc(r.request)}"><div class="mh"><b data-dot-status>Dotへの依頼（廃止・参照のみ）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div><p class="small">依頼ID：${esc(r.request)}</p></div>`;
  if (r.role === 'user') return UI.template`<div class="m me"><div class="mh">${r.mode === 'redo' || r.mode === 'interrupt' ? UI.html('<span class="tagm int">やり直し</span>') : r.mode === 'amend' ? UI.html('<span class="tagm am">追加指示</span>') : r.mode === 'queued' ? UI.html('<span class="tagm">順番待ちの指示</span>') : ''}<span class="small">${time}・${esc(AI_LABEL[r.to] || '')}${r.model ? '・' + esc(r.model) : ''}${r.to === 'codex' && r.fast === true ? UI.text('・加速ON（Fast）') : ''} へ</span></div>${requestBodyHtml(r)}</div>`;
  return UI.template`<div class="m ai ${r.discussion ? 'discussion-message' : ''} ${r.discussion?.summary && !r.error ? 'discussion-summary' : ''}" ${r.ai === 'chatgpt-chat' && r.request ? `data-gpt-report="${esc(r.request)}"` : ''} ${r.ai === 'dot' && r.request ? `data-dot-report="${esc(r.request)}"` : ''}><div class="mh">${r.discussion ? UI.template`<b>${esc(r.discussion.summary ? '話し合いのまとめ' : r.discussion.stage)}</b>` : ''}<span class="chip k-${esc(r.ai)}"><span class="ic">${AI_ICON[r.ai] || '?'}</span>${esc(AI_LABEL[r.ai] || r.ai)}${r.model ? UI.template`<small>・${esc(r.model)}${r.effort ? '・' + esc(r.effort) : ''}</small>` : ''}</span><span class="small">${time}</span>${r.error ? UI.html('<span class="done bad">⚠ 止まりました</span>') : UI.template`<span class="done">✓ 完了${r.ms ? '（' + dur(r.ms) + '）' : ''}</span>`}${r.text ? UI.template`<button type="button" class="cp cp-msg" data-copy="${esc(r.text)}" title="この返事をコピー">⧉ コピー</button>` : ''}</div>
    ${r.text ? UI.template`<div class="mb">${richText(r.text)}</div>` : ''}${(r.generatedImages || []).map(x => imagePathLink(x.path, x.name)).join('')}${!r.questionsManaged && r.asks && r.asks.length ? askHtml(r.asks) : ''}${r.error ? UI.template`<div class="merr">${esc(r.error)}</div>` : ''}</div>`;
}

function drawPendingQuestion(box, question) {
  // Keep drafts across row updates; answered questions disappear on the saved acknowledgement.
  const existing=box.querySelector('.pending-question');
  if(question && existing?.dataset.questionSource===question.source)return;
  existing?.remove();
  if (!question) return;
  box.insertAdjacentHTML('beforeend', UI.template`<div class="m pending-question" data-question-source="${esc(question.source)}"><b>未回答の質問</b>${askHtml(question.asks, question.source)}</div>`);
}

function askHtml(asks, source) {
  const key = JSON.stringify([view.project, view.task, asks]);
  const saved = askDrafts.get(key) || [];
  return UI.template`<div class="ask${askPending.has(key) ? ' pending' : ''}" data-ask-key="${esc(key)}"${source ? UI.template` data-question-source="${esc(source)}"` : ''}>${asks.map((a, i) => {
    const d = saved[i] || { selected: [], free: '' };
    return UI.template`<div class="ask-q" data-i="${i}" data-multi="${a.multi ? 1 : 0}" data-q="${esc(a.question)}">
      <div class="ask-t">❓ ${richText(a.question || UI.text('選んでください'))}</div>
      <div class="ask-opts">${a.options.map(o => UI.template`<button type="button" class="ask-o${d.selected.includes(o) ? ' on' : ''}" data-ask="${esc(o)}" aria-pressed="${d.selected.includes(o)}">${esc(o)}</button>`).join('')}</div>
      <label class="ask-free-label">ほかの回答・補足<textarea class="ask-free" rows="2" placeholder="選択肢にない回答を書けます。選んだ回答への補足もできます。">${esc(d.free)}</textarea></label></div>`;
  }).join('')}
    <div class="ask-foot"><span class="small">質問ごとに選ぶか入力して、まとめて［選んで送る］を押してください。</span><button type="button" class="btn sm ask-send">選んで送る</button></div><div class="ask-status small" role="status"></div></div>`;
}

function askValues(ask) {
  return [...ask.querySelectorAll('.ask-q')].map(q => ({ question: q.dataset.q,
    selected: [...q.querySelectorAll('.ask-o.on')].map(b => b.dataset.ask), free: q.querySelector('.ask-free').value }));
}

function askAnswer(values) {
  return values.map(v => {
    const selected = v.selected.map(cleanOpt).join('、'), free = v.free.trim();
    const answer = selected && free ? UI.template`${selected}\n自由入力：${free}` : selected || free;
    return values.length > 1 ? `${v.question}：${answer}` : answer;
  }).join('\n\n');
}

function updateAskControls(ask) {
  if(ask.closest?.('.freetalk-work')?.dataset.readonly==='true'){ask.querySelectorAll('button, textarea').forEach(e=>e.disabled=true);return;}
  const disabled = ask.classList.contains('done') || askPending.has(ask.dataset.askKey) || (typeof chatSending !== 'undefined' && chatSending.has(JSON.stringify(JSON.parse(ask.dataset.askKey).slice(0,2))));
  ask.querySelectorAll('button, textarea').forEach(el => { el.disabled = disabled; });
  ask.querySelector('.ask-send').textContent = askPending.has(ask.dataset.askKey) ? UI.text('送っています…') : UI.text('選んで送る');
}

function bindAskAnswers(box, send) {
  box.addEventListener('input', e => {
    const ask = e.target.closest('.ask');
    if (!ask || !e.target.matches('.ask-free') || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = '';
  });
  box.addEventListener('click', async e => {
    const ask = e.target.closest('.ask');
    if (!ask || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    const opt = e.target.closest('.ask-o');
    if (opt) {
      const q = opt.closest('.ask-q'), wasOn = opt.classList.contains('on');
      if (q.dataset.multi !== '1') q.querySelectorAll('.ask-o').forEach(b => b.classList.remove('on'));
      opt.classList.toggle('on', !wasOn);
      q.querySelectorAll('.ask-o').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
      askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = ''; return;
    }
    if (!e.target.closest('.ask-send')) return;
    const values = askValues(ask), missing = values.findIndex(v => !v.selected.length && !v.free.trim());
    askDrafts.set(ask.dataset.askKey, values);
    if (missing !== -1) {
      ask.querySelector('.ask-status').textContent = UI.template`質問${missing + 1}の選択肢を選ぶか、ほかの回答を入力してください。`;
      ask.querySelectorAll('.ask-free')[missing].focus(); return;
    }
    const key = ask.dataset.askKey;
    const currentAsks = () => [...new Set([ask, ...document.querySelectorAll('.ask')])].filter(a => a.dataset.askKey === key);
    askPending.add(key); updateAskControls(ask);
    ask.querySelector('.ask-status').textContent = '';
    try {
      const answer=ask.dataset.questionSource && values.length===1 ? `${values[0].question}：${askAnswer(values)}` : askAnswer(values);
      if (await send(answer, ask.dataset.questionSource)) {
        askDrafts.delete(key); currentAsks().forEach(a => { a.classList.add('answered', 'done'); a.querySelector('.ask-status').textContent = UI.text('回答をまとめて送信しました。'); });
      } else { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = UI.text('送信されていません。回答はそのまま残っています。'); }); }
    } catch (err) { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = UI.template`送信できませんでした。回答は残っています。${err.message}`; }); }
    finally { askPending.delete(key); currentAsks().forEach(updateAskControls); }
  });
}

function refreshAsks(box) {
  const all = [...box.querySelectorAll('.m')];
  const last = all.filter(m => !m.id).pop();
  const asks = [...box.querySelectorAll('.ask')];
  const workKey = JSON.stringify([view.project, view.task]), attempt = askAttempts.get(workKey);
  const current = attempt && taskOf(proj(view.project), view.task);
  const target = attempt && asks.filter(a => a.dataset.askKey === attempt.askKey).at(-1);
  const newer = target && asks.slice(asks.indexOf(target) + 1).some(a => a.dataset.askKey !== attempt.askKey);
  const retry = attempt && current?.question === attempt.question && target && !newer && !target.classList.contains('answered');
  // 初期履歴が届く前の空DOMは、対象の質問が消えたという情報ではない。
  if (attempt && (current?.question !== attempt.question || newer || target?.classList.contains('answered') || (!target && box.dataset?.askHistoryPending !== '1'))) askAttempts.delete(workKey);
  asks.forEach(a => {
    a.classList.toggle('done', a.classList.contains('answered') || (!a.dataset.questionSource && !(retry && a === target) && (!last || !last.contains(a))));
    updateAskControls(a);
  });
}

function dur(ms) { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? UI.template`${t}秒` : UI.template`${Math.floor(t / 60)}分${t % 60 ? (t % 60) + '秒' : ''}`; }

// Create the original callback at its original registration point in app.js.
function appMessagesCallback1642() {
  return (async e=>{
  const toggle = e.target.closest?.('[data-request-toggle]');
  if (toggle?.dataset?.requestToggle !== undefined) {
    const body = toggle.closest('.auto-request'), full = body.querySelector('.auto-request-full');
    const expand = toggle.getAttribute('aria-expanded') !== 'true';
    const change = () => {
      if (expand && !full.dataset.ready) {
        full.innerHTML = richText(body.querySelector('.auto-request-source').content.textContent);
        full.dataset.ready = '1';
      }
      full.hidden = !expand;
      body.querySelector('.auto-request-preview').hidden = expand;
      toggle.setAttribute('aria-expanded', String(expand));
      toggle.textContent = UI.text(expand ? '閉じる' : '全文を見る');
    };
    const box = body.closest('#msgs');
    if (box && window.HubChatScroll?.change) window.HubChatScroll.change(box, change); else change();
    return;
  }
  const b=e.target.closest?.('.cb-copy');if(!b || b.disabled)return;
  const label=UI.text(b.classList?.contains('quote-copy')?'⧉ 引用をコピー':'⧉ コピー');
  b.disabled=true;
  const ok=await copyText(b.closest('.codeblock').querySelector('code').textContent,true);
  b.textContent=ok?UI.text('✓ コピーしました'):UI.text('コピーできませんでした。選んで ⌘C');
  setTimeout(()=>{b.textContent=label;b.disabled=false;},2000);
});
}
