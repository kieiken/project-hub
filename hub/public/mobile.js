/* スマホの収納欄。開閉では入力欄を作り直さない。 */
(() => {
  var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
  const $ = s => document.querySelector(s), media = matchMedia('(max-width:720px)');
  let infoOpen = false, composerOpen = false, workKey = '';
  try { infoOpen = localStorage.getItem('hub-mobile-info') === 'open'; } catch (_) {}
  function draft() {
    const text = $('#chat-in')?.value || '', images = $('#chat-images');
    const hasDraft = Boolean(text || (images && !images.hidden));
    const button = $('#mobile-compose');
    if (button) button.textContent = composerOpen ? UI.text('閉じる') : UI.text('✎ 依頼を書く') + (hasDraft ? UI.text(' · 下書きあり') : '');
  }
  function apply() {
    document.body.classList.toggle('mobile-info-open', infoOpen);
    document.body.classList.toggle('mobile-compose-open', composerOpen);
    const button = $('#mobile-info');
    button.textContent = infoOpen ? '▲' : '▼';
    button.setAttribute('aria-label', infoOpen ? UI.text('情報と操作を閉じる') : UI.text('情報と操作を開く'));
    button.setAttribute('aria-expanded', String(infoOpen));
    const compose = $('#mobile-compose');
    if (compose) compose.setAttribute('aria-expanded', String(composerOpen));
    draft();
  }
  function badges() {
    const name = $('.whead h2')?.textContent || $('.ph h2')?.textContent || '';
    $('#mobile-badges').textContent = name;
    $('#mobile-badges').title = name;
  }
  function layout() {
    const work = $('.work'), info = $('#mobile-work-info'), foot = $('.wfoot');
    if (work && info && foot) { if (media.matches) info.appendChild(foot); else work.appendChild(foot); }
    const vv = window.visualViewport;
    document.body.classList.toggle('mobile-keyboard', Boolean(media.matches && vv && vv.scale === 1 && vv.height < window.innerHeight - 100));
    // ピンチ拡大中はレイアウトを縮めない。キーボード等で可視領域が縮んだ時だけ合わせる。
    document.documentElement.style.setProperty('--hub-visible-height', media.matches && vv && vv.scale === 1 ? vv.height + 'px' : '100dvh');
    // iOSのフォーカス時にページがずれたままだと、縮めた画面の下の空白が見える。
    if (media.matches && vv && vv.scale === 1 && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
  }
  function labels() {
    for (const option of ($('#chat-ai')?.options || [])) {
      const text = media.matches ? option.dataset.short : option.dataset.full;
      if (text !== undefined) option.textContent = text;
    }
  }
  window.HubMobile = {
    mount(key) {
      if (workKey !== key) { composerOpen = false; workKey = key; }
      const work = $('.work'), chat = $('.chat') || $('.panes');
      if (work && chat) {
        const info = document.createElement('div'); info.id = 'mobile-work-info'; info.className = 'mobile-work-info';
        work.insertBefore(info, work.firstChild);
        while (info.nextElementSibling && info.nextElementSibling !== chat) info.appendChild(info.nextElementSibling);
      }
      const composer = $('#composer');
      if (composer) {
        const button = document.createElement('button'); button.id = 'mobile-compose'; button.type = 'button'; button.className = 'mobile-strip'; button.setAttribute('aria-controls','composer');
        composer.before(button);
        button.addEventListener('click', () => { composerOpen = !composerOpen; if (!composerOpen && composer.contains(document.activeElement)) document.activeElement.blur(); apply(); button.focus({preventScroll:true}); });
        composer.addEventListener('input', draft);
        composer.addEventListener('focusin', () => requestAnimationFrame(layout));
      }
      layout(); apply(); badges(); labels();
    },
    badges, draft, labels,
    sent() { composerOpen = false; if ($('#composer')?.contains(document.activeElement)) document.activeElement.blur(); apply(); }
  };
  $('#mobile-info').addEventListener('click', () => { infoOpen = !infoOpen; try { localStorage.setItem('hub-mobile-info',infoOpen ? 'open' : 'closed'); } catch (_) {} apply(); });
  media.addEventListener('change', () => { layout(); labels(); });
  window.visualViewport?.addEventListener('resize',layout);
  window.visualViewport?.addEventListener('scroll',layout);
  apply(); layout();
})();
