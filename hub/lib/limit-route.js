'use strict';
const launch = require('./launch');
// 設定画面のmain/backupを実際の起動へ結ぶ。設定自体は書き換えない。
function limitIdentity(data, o) {
  const matches = slot => slot && launch.AI_KEY[o.ai] === slot.ai && launch.flagFor(o.ai, slot.model) === launch.flagFor(o.ai, o.model);
  const row = (data.roles || []).find(r => o.role ? r.name === o.role : matches(r.main) || matches(r.backup));
  if (!row) return null;
  if (matches(row.main)) return { role: row.name, limitSlot: 'main' };
  if (matches(row.backup)) return { role: row.name, limitSlot: 'backup' };
  // 手動の別モデルも、その作業の保存済みbackupへ。別の役割を推測せず、
  // 起動時の欄を保持するだけで既定mainや手動選択そのものは書き換えない。
  return o.role && launch.AIS.includes(o.ai) && launch.flagFor(o.ai, o.model)
    ? { role: row.name, limitSlot: 'main' } : null;
}
// Classification only: guard an already requested handoff; no target selection or execution.
function capacityModel(model) {
  const id = launch.flagFor('codex', model), match = /^gpt-(\d+(?:\.\d+)*)-(sol|astra)$/.exec(id);
  return match ? { id, version: match[1].split('.').map(Number), family: match[2] } : null;
}
function capacityReturnAllowed(o) {
  return o.limitSwitch?.reason === 'capacity' && o.ai === 'codex' &&
    capacityModel(o.model)?.family === 'astra' && o.limitSwitch.sourceAI === 'codex' &&
    capacityModel(o.limitSwitch.sourceModel)?.family === 'sol';
}
module.exports = { limitIdentity, capacityModel, capacityReturnAllowed };
