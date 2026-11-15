'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const publicDir = path.resolve(__dirname, '../../public');
// Read the actual classic-script list immediately before app.js.
function scripts(dir = publicDir) {
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const names = [...index.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)].map(m => m[1]);
  const app = names.indexOf('app.js');
  if (app < 0 || names.lastIndexOf('app.js') !== app) throw Error('app_entry_missing_or_duplicate');
  let start = app;
  while (start && /^app-[a-z-]+\.js$/.test(names[start - 1])) start--;
  return names.slice(start, app + 1);
}
function loadApp(context, dir = publicDir) {
  for (const name of scripts(dir)) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context, { filename: name });
}
// Older focused fixtures slice a source region around its original state and
// comments. Expand only the declaration markers from the current module code;
// no baseline copy or runtime alternative is used. Full harnesses use loadApp.
function readApp(dir = publicDir) {
  const functions = new Map();
  for (const name of scripts(dir).filter(n => n !== 'app.js')) {
    const context = vm.createContext({document:{addEventListener(){}},setInterval(){},setTimeout(){}});
    vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context, { filename: name });
    functions.set(name, context);
  }
  return fs.readFileSync(path.join(dir, 'app.js'), 'utf8').replace(/\/\* @app-callback ([a-z-]+\.js):([A-Za-z_$][\w$]*) \*\/\2\(\)/g, (_, file, name) => {
    const create = functions.get(file)?.[name];
    if (typeof create !== 'function') throw Error('app_callback_missing: ' + file + ':' + name);
    return create().toString();
  }).replace(/\/\* @app-function ([a-z-]+\.js):([A-Za-z_$][\w$]*) \*\//g, (_, file, name) => {
    const fn = functions.get(file)?.[name];
    if (typeof fn !== 'function') throw Error('app_declaration_missing: ' + file + ':' + name);
    return fn.toString();
  });
}
module.exports = { scripts, loadApp, readApp };
