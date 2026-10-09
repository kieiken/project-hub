'use strict';
function safeName(value) {
  if (typeof value !== 'string' || !value || /[\\/\x00-\x1f]/.test(value) || value === '.' || value === '..') return false;
  if (process.platform === 'win32' && (/[<>:"|?*]/.test(value) || /[. ]$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))) return false;
  return true;
}
module.exports = { safeName };
