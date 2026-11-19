'use strict';
// The source stays in a detached template. Only reconstructed elements and
// inlined image bytes reach the opaque-origin, script-free frame.
const MOCKUP_TAGS = new Set(('a abbr article aside b blockquote br button caption code col colgroup dd details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input kbd label li main mark nav ol p pre s section small span strong sub summary sup table tbody td th thead tfoot time tr u ul').split(' '));
const MOCKUP_DISCARD = new Set(['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'audio', 'video', 'textarea', 'select']);
const MOCKUP_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const MOCKUP_TABS_CSS = '.hub-preview-tabs{display:grid;grid-auto-columns:1fr;gap:.25rem}.hub-preview-tabs>input{position:absolute;opacity:0}.hub-preview-tabs>label{grid-row:1;cursor:pointer;padding:.45em;border-bottom:2px solid transparent}.hub-preview-tabs>input:checked+label{border-color:currentColor;font-weight:600}.hub-preview-tabs>input:focus-visible+label{outline:2px solid currentColor}.hub-preview-tabs>div{grid-column:1/-1;grid-row:2;min-width:0}.hub-preview-tabs>input:not(:checked)+label+div{display:none!important}';

async function mockupFrameDocument(html, loadAsset) {
  const doc = document.implementation.createHTMLDocument('');
  const template = doc.createElement('template');
  template.innerHTML = html;
  const output = doc.createElement('div'), assets = new Map(), styles = new Map(), images = [];
  let nodeCount = 0, tabCount = 0, embeddedBytes = 0;

  function asset(raw) {
    let name;
    try { name = decodeURIComponent((raw || '').trim().replace(/^\.\//, '')); } catch { return null; }
    if (!name || /^[.]|[ .]$|[\x00-\x1f\x7f<>:"/\\|?*]/.test(name)) return null;
    if (!assets.has(name) && assets.size < 48) assets.set(name, loadAsset(name));
    return assets.get(name);
  }
  function embed(data) {
    if (!data || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return '';
    if (embeddedBytes + data.length > 8 * 1024 * 1024) return '';
    embeddedBytes += data.length;
    return data;
  }
  async function image(raw) {
    if (!raw) return '';
    if (raw.startsWith('data:')) return embed(raw);
    const data = await asset(raw);
    return data?.base64 ? embed('data:' + data.type + ';base64,' + data.base64) : '';
  }
  async function css(text) {
    const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"]+))\s*\)/gi;
    const parts = [];
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      if (parts.length >= 256) break;
      parts.push(text.slice(start, match.index));
      const src = await image(match[1] ?? match[2] ?? match[3]);
      parts.push(src ? 'url("' + src + '")' : 'url("data:,")');
      start = match.index + match[0].length;
    }
    return parts.join('') + text.slice(start);
  }
  function attrs(from, to) {
    for (const name of ['class', 'id', 'title', 'lang', 'dir', 'aria-label']) {
      if (from.hasAttribute(name)) to.setAttribute(name, from.getAttribute(name));
    }
    if (from.hasAttribute('style')) styles.set(to, from.getAttribute('style'));
  }
  function copyChildren(source, target, depth) {
    if (depth > 64 || nodeCount > 12_000) return;
    const panels = new Set(), replacements = new Map(), panelsById = new Map();
    for (const child of source.children) {
      if (child.id && child.getAttribute('role') === 'tabpanel' && !panelsById.has(child.id)) panelsById.set(child.id, child);
    }
    for (const item of source.children) {
      if (tabCount >= 100 || item.getAttribute('role') !== 'tablist') continue;
      const tabs = Array.from(item.children).filter(el => el.getAttribute('role') === 'tab');
      if (tabs.length < 2 || tabs.length > 8) continue;
      const group = tabs.map(tab => ({
        tab, panel: panelsById.get(tab.getAttribute('aria-controls')),
      }));
      const unique = new Set(group.map(({ panel }) => panel));
      if (unique.has(undefined) || unique.size !== tabs.length || [...unique].some(panel => panels.has(panel))) continue;
      for (const panel of unique) panels.add(panel);
      const section = doc.createElement('section');
      section.className = 'hub-preview-tabs';
      const name = 'hub-preview-tab-' + ++tabCount;
      const selected = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
      group.forEach(({ tab, panel }, index) => {
        const input = doc.createElement('input'), label = doc.createElement('label'), area = doc.createElement('div');
        input.type = 'radio'; input.name = name; input.id = name + '-' + index;
        input.defaultChecked = index === selected;
        label.htmlFor = input.id; label.textContent = tab.textContent;
        attrs(panel, area);
        copyChildren(panel, area, depth + 1);
        section.append(input, label, area);
      });
      // Keep the rebuilt tab set at the source tab list's position.
      replacements.set(item, section);
    }
    for (const child of source.childNodes) {
      if (nodeCount > 12_000) break;
      if (replacements.has(child)) target.append(replacements.get(child));
      else if (!panels.has(child)) copy(child, target, depth);
    }
  }
  function copy(node, parent, depth) {
    if (++nodeCount > 12_000 || depth > 64) return;
    if (node.nodeType === 3) { parent.append(doc.createTextNode(node.data)); return; }
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    const tag = node.localName;
    if (MOCKUP_DISCARD.has(tag)) return;
    if (tag === 'style' || (tag === 'link' && node.getAttribute('rel')?.toLowerCase() === 'stylesheet')) {
      const style = doc.createElement('style');
      const text = tag === 'style' ? node.textContent : Promise.resolve(asset(node.getAttribute('href'))).then(data => data?.css || '');
      styles.set(style, text);
      parent.append(style);
      return;
    }
    if (!MOCKUP_TAGS.has(tag)) { copyChildren(node, parent, depth + 1); return; }
    if (tag === 'input' && !['radio', 'checkbox', 'range'].includes(node.type)) return;
    const el = doc.createElement(tag);
    attrs(node, el);
    for (const name of (tag === 'img' ? ['alt', 'width', 'height'] : tag === 'input' ? ['type', 'min', 'max', 'step', 'value', 'checked'] :
      tag === 'label' ? ['for'] : tag === 'details' ? ['open', 'name'] : tag === 'td' || tag === 'th' ? ['colspan', 'rowspan'] : [])) {
      if (node.hasAttribute(name)) el.setAttribute(name, node.getAttribute(name));
    }
    if (tag === 'img' && images.length < 128) images.push([el, node.getAttribute('src')]);
    if (tag === 'input' && node.type === 'radio') el.name = 'mockup-radio-' + node.name;
    if (tag === 'button') el.disabled = true;
    parent.append(el);
    copyChildren(node, el, depth + 1);
  }

  copyChildren(template.content, output, 0);
  for (const [el, src] of images) {
    const data = await image(src);
    if (data) el.setAttribute('src', data);
  }
  for (const [el, text] of styles) {
    const value = await css(await text);
    // CSS is a raw-text element in the next parser. A literal less-than
    // must never be able to close it and introduce new markup.
    if (el.localName === 'style') el.textContent = value.replaceAll('<', '\\3c ');
    else el.setAttribute('style', value);
  }
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + MOCKUP_CSP
    + '"><meta name="viewport" content="width=device-width, initial-scale=1">' + output.innerHTML + '<style>' + MOCKUP_TABS_CSS + '</style>';
}

async function loadMockupPreview(fileUrl, signal) {
  const url = new URL(fileUrl, location.href);
  url.searchParams.delete('hubResource');
  const request = async target => {
    const response = await fetch(target, { signal, redirect: 'error' });
    return response.ok ? response.json() : null;
  };
  const preview = await request(url);
  if (!preview || typeof preview.html !== 'string' || !/^[a-f0-9]{48}$/.test(preview.mockup)) throw Error('mockup unavailable');
  return mockupFrameDocument(preview.html, name => {
    const asset = new URL(url.pathname, url);
    asset.search = new URLSearchParams({ mockup: preview.mockup, asset: name });
    return request(asset).catch(() => null);
  });
}
