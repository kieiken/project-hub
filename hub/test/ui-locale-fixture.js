'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/locale.js'), 'utf8');

// Extracted app functions still use the same real locale implementation as the
// browser. Original behavioral tests deliberately keep the Japanese default.
module.exports = function uiLocale(locale = 'ja') {
  const messages = ['en','zh-TW'].includes(locale) ? require('../../langpacks/' + locale + '/ui.json') : {};
  const context = vm.createContext({ HUB_LOCALE: { locale, messages } });
  vm.runInContext(source, context);
  return context.HubI18n;
};
