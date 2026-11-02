'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../hub/public/locale.js'), 'utf8');

// Extracted app functions still use the same real locale implementation as the
// browser. Original behavioral tests deliberately keep the Japanese default.
module.exports = function uiLocale(locale = 'ja') {
  const context = vm.createContext({ HUB_LOCALE: { locale, messages: require('../ui.json') } });
  vm.runInContext(source, context);
  return context.HubI18n;
};

// Follow the real module order: app.js now calls functions split into app-*.js.
module.exports.loadApp = context => {
  const publicDir = path.resolve(__dirname, '../../../hub/public');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const match of index.matchAll(/<script src="((?:role-settings|app(?:-[a-z]+)*)\.js)"><\/script>/g)) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, match[1]), 'utf8'), context, { filename: match[1] });
  }
};
