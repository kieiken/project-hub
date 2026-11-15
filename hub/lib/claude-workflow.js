'use strict';
const fs = require('fs'), path = require('path');
// Merge per-turn switches with existing CLI settings; never write settings.
function configure(args, { workflow, dir }) {
  let settings = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) continue;
    const inline = args[i].startsWith('--settings='), value = inline ? args[i].slice(11) : args[i + 1];
    const parsed = JSON.parse(value?.startsWith('{') ? value : fs.readFileSync(path.resolve(dir || process.cwd(), value), 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error('Invalid Claude settings');
    settings = { ...settings, ...parsed };
    args.splice(i--, inline ? 1 : 2);
  }
  args.push('--settings', JSON.stringify({ ...settings, ultracode: workflow, workflowKeywordTriggerEnabled: false }));
  if (!workflow) {
    const i = args.indexOf('--disallowedTools');
    if (i < 0) args.push('--disallowedTools', 'Workflow');
    else args[i + 1] = [...new Set((args[i + 1] || '').split(',').filter(Boolean).concat('Workflow'))].join(',');
  }
}
function modelUsage(models) {
  if (!models || typeof models !== 'object') return undefined;
  const out = {};
  for (const [key, source] of [['input_tokens','inputTokens'], ['cache_read_input_tokens','cacheReadInputTokens'], ['cache_creation_input_tokens','cacheCreationInputTokens']]) {
    const values = Object.values(models).map(m => m?.[source]);
    if (values.length && values.every(v => Number.isFinite(v) && v >= 0)) out[key] = values.reduce((a,b) => a+b,0);
  }
  return Object.keys(out).length ? out : undefined;
}
module.exports = { configure, modelUsage };
