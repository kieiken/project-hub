'use strict';
const { lt } = require('./locale');
const { randomUUID } = require('node:crypto');
const MARKER = 'maintenance-problems';
function problemPrompt(p, checks) {
  return [
    lt('台帳とリンクの問題解決'),
    `プロジェクト名：${p.name}\n台帳の場所：${p.dir}/PROJECT.md`,
    lt('サーバー側で確認し直した、×の項目だけを以下に示します。'),
    ...checks.map(c => `× ${c.name}${c.detail ? '：' + c.detail : ''}`),
    lt('人の明示決定：直せるものは全部AIが直す。この依頼では、台帳（PROJECT.md・作業ファイル）の書き間違い、存在しない作業場所（workdir）の記録の整理、親・関連の参照切れも直してよい。Hub管理の欄を普段変更しない決まりに対する、この問題解決の明示的な許可です。'),
    lt('原因と実物を確認し、直す前にGitへ保存する。消す時はゴミ箱へ移す。資料の原本と他プロジェクトのファイルには触らない。'),
    lt('最後に「台帳とリンクを確認」と同じ観点で全件okを確かめ、作業ファイルの「## やったこと」「## 成果」に修正と確認結果を書く。未解決があれば理由と必要な判断を記録する。')
  ].join('\n\n');
}
class ProblemResolution {
  constructor(options) { Object.assign(this, options); this.pending = new Set(); this.starting = new Set(); }
  async solve(project) {
    if (this.pending.has(project)) throw Error(lt('問題解決の受付中です。終わってから操作してください'));
    this.pending.add(project);
    try {
      const p = this.maintenance.project(project);
      let t = p.tasks.find(t => t.via === MARKER && t.state !== '完了');
      // 動いている既存の解決作業には新しい依頼を重ねない。
      if (t && this.active(p.id, t.id)) return { ok: true, task: t.id, reused: true, active: true };
      const verified = await this.maintenance.verify(p.id);
      const checks = verified.checks.filter(c => c.ok === false);
      if (!checks.length) return { ok: true, clear: true, note: lt('確認し直したところ、台帳とリンクに問題は見つかりませんでした。作業は作りませんでした。') };
      this.maintenance.idle(p.id);
      const pick = this.pick(); this.validate(pick);
      this.starting.add(p.id);
      const reused = Boolean(t);
      t ||= this.store.createTask(p.id, { title: '問題解決', parent: '', via: MARKER, owner: pick.ai, role: '司令塔',
        steps: [lt('最新の確認結果と原因を調べる'), lt('変更前をGitに保存して直せる問題を直す'), lt('台帳とリンクを全件確認して成果を記録する')] });
      if (!t) throw Error(lt('問題解決の作業を作れませんでした'));
      const r = await this.start({ project: p.id, task: t.id, ...pick, text: problemPrompt(p, checks), images: [], request: 'maintenance-' + randomUUID() });
      if (r.status !== 200) { const e = Error(r.body.error || lt('AIを開始できませんでした')); e.task = t.id; throw e; }
      return { ...r.body, reused };
    } finally { this.starting.delete(project); this.pending.delete(project); }
  }
}
module.exports = { ProblemResolution, problemPrompt, MARKER };
