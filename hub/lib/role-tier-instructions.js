'use strict';
const { lt } = require('./locale');
function active(data) { return !data?.specialMode?.enabled && Object.entries(data?.tierSettings?.roles || {}).filter(([,r])=>r.routing==='on'&&(r.light||r.standard)).map(([name])=>name); }
function summary(data) {
  const on=active(data);if(!on?.length)return '';
  const stopped=Object.entries(data.tierSettings.roles).filter(([,r])=>r.routing==='stopped').map(([name])=>name);
  return lt`【段分け】振り分け中：${on.join('・')}（停止中：${stopped.join('・')||lt('なし')}）。モデルの決まりの表示は一番上の段。対象の委任はrole・tier（軽い/標準/難しい）・reasonを付け、model・effortは付けない。基準は委任時だけ全文 ## 段分け。迷ったら上の段。`;
}
function full(data) {
  if(!active(data)?.length)return '';
  return lt`## 段分け
${summary(data)}
段の担当（難しいはモデルの決まりにあるいつもの担当）：${JSON.stringify(data.tierSettings.roles)}
渡し方：同じ作業の POST /api/delegate に role・tier（軽い/標準/難しい）・reason（理由1〜80字）を付ける。model・effortは付けない。渡した後、返事に選ばれた段・モデル・理由を一言書く。
コーディング 軽い：1つのファイルで完結する文言・表示・設定値の変更や決まった形の追加。既存の動作・データ・権限・外部連携を変えず、確認方法がはっきりしているものだけ。
コーディング 標準：影響範囲がはっきりしたふつうの実装や修正。複数ファイルでもよい。
コーディング 難しい：設計判断、データ構造・権限・認証・金銭・削除・外部連携、共通部の変更、原因不明の不具合、影響範囲が不明なもの。
調査 軽い：公式ページ1〜2か所で答えが出る少量の事実確認だけ。
調査 標準：複数の資料を読み比べるふつうの調査。
調査 難しい：情報の食い違い、判断・おすすめ、法務・金銭・安全・公開内容、大きな決定の根拠になるもの。
共通：迷ったら上の段。安い段の思考は保存値（既定は極高）。Ultraを自動で付けない。調査は情報の出どころ（URL・資料名・見た日）と確認できなかった点を書く。
失敗・チェックの差し戻しは redo:true を付けて同じ役割へ。Hubが一段上にする。同じモデルで繰り返さない。連なりの最初が難しい段なら同じ段で直す。安い段から上がった仕事が一番上でも失敗した時だけ止めて人に報告する。
同じ作業（自由対話なら同じ話題）で安い段のやり直し2回になるとHubがその役割の振り分けを停止し、一番上だけにする。誤った結果の使用で実害や手戻りが出た時は POST /api/roles/tiers/stop（role・reason・project・task）で止めて報告する。再開は設定画面で人だけが決める。AIは再開しない。
段のモデルが会話のアカウントに無い時は上の段、それも無ければ保存された「上限の時」の担当。下の段・古いモデルへ下げない。利用上限の時の既存の交代・保持・待機はそのまま。
統合の担当指定・話し合い・アイデア自動実行・役割見直し・別置きの確認・Muse・ターミナル・特殊モードでは段を使わない。`;
}
module.exports={active,summary,full};
