'use strict';

// Japanese is the built-in language. Every other language is an independent
// locale pack in hub/locales/<locale>/ (pack.json plus optional catalogs,
// terms, styles, native strings, seed and templates); adding a language means
// adding a pack, not changing core code. HUB_LANG selects a pack, and a
// language whose pack is not installed falls back to Japanese. Only
// application-owned phrases are translated. Interpolated user text, filenames,
// persisted identifiers and CLI model names are kept verbatim.
const fs = require('fs');
const path = require('path');
const DEFAULT_LOCALE = 'ja';
const PACKS = path.join(__dirname, '..', 'locales');
const TEMPLATES = path.join(__dirname, '..', '..', 'docs', 'project-hub', 'templates');
const LOCALE_NAME = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const packs = new Map();
let installedPacks = null;

function readOptional(file, parse) {
  try { return parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
function pack(language) {
  if (!packs.has(language)) packs.set(language, loadPack(language));
  return packs.get(language);
}
function loadPack(language) {
  if (language === DEFAULT_LOCALE || !LOCALE_NAME.test(String(language))) return null;
  const dir = path.join(PACKS, language);
  const manifest = readOptional(path.join(dir, 'pack.json'), JSON.parse);
  if (!manifest || manifest.locale !== language) return null;
  const terms = readOptional(path.join(dir, 'terms.json'), JSON.parse) || {};
  return {
    dir, locale: language, dateLocale: manifest.dateLocale || language,
    messages: readOptional(path.join(dir, 'messages.json'), JSON.parse) || {},
    uiMessages: readOptional(path.join(dir, 'ui-messages.json'), JSON.parse) || {},
    styles: readOptional(path.join(dir, 'ui.css'), String) || '',
    headings: terms.headings || {}, headingAliases: terms.headingAliases || {}, labels: terms.labels || {},
  };
}
// Every installed locale pack; Markdown headings written in any of them stay readable.
function installed() {
  if (!installedPacks) installedPacks = (fs.existsSync(PACKS) ? fs.readdirSync(PACKS).sort() : []).map(pack).filter(Boolean);
  return installedPacks;
}
const active = (language = process.env.HUB_LANG) => language ? pack(language) : null;
const own = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
const locale = () => active()?.locale || DEFAULT_LOCALE;
function lt(source, ...values) {
  const template = Array.isArray(source) && Object.hasOwn(source, 'raw');
  const key = template ? source.map((part, i) => part + (i < values.length ? '${' + i + '}' : '')).join('') : String(source);
  const pack = active();
  const text = pack && own(pack.messages, key) || key;
  return template ? text.replace(/\$\{(\d+)\}/g, (all, index) => String(values[Number(index)])) : text;
}
const sectionNames = heading => {
  const packs = installed();
  let canonical = heading;
  for (const pack of packs) {
    const found = Object.keys(pack.headings).find(key => key === heading || pack.headings[key] === heading);
    if (found) { canonical = found; break; }
  }
  const names = [canonical];
  for (const pack of packs) names.push(own(pack.headings, canonical) || canonical, ...(own(pack.headingAliases, canonical) || []));
  return [...new Set(names)];
};
const sectionName = heading => own(active()?.headings || {}, heading) || heading;
const label = value => own(active()?.labels || {}, value) || value;
// The browser receives one catalog: UI-only phrases plus the server catalog, which wins on overlap.
function config(language) {
  const pack = active(language);
  if (!pack) return { locale: DEFAULT_LOCALE, language: DEFAULT_LOCALE, dateLocale: 'ja-JP', messages: {} };
  return { locale: pack.locale, language: pack.locale, dateLocale: pack.dateLocale, messages: { ...pack.uiMessages, ...pack.messages } };
}
function configScript() {
  return 'window.HUB_LOCALE = ' + JSON.stringify(config()).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';';
}
const styles = () => active()?.styles || '';
// Project and _hub templates for new ledgers in the active language.
function templates() {
  const pack = active(), dir = pack && path.join(pack.dir, 'templates');
  return dir && fs.existsSync(dir) ? dir : TEMPLATES;
}
module.exports = { lt, locale, config, configScript, styles, templates, installed, sectionNames, sectionName, label };
