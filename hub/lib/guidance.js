'use strict';
const { lt } = require('./locale');

// 画面を見たという主張をせず、public/app.js と同じ表示条件を伝える。
const name = value => String(value || '').replace(/[\r\n]+/g, ' ');
function guidance(p, t, { where = 'chat', copy = false, copyMissing = false, mergeExcluded = t.mergeExcluded, projects = [p] } = {}) {
  const phases = p.phases || [], cur = phases.findIndex(ph => ph.state !== '完了');
  const current = phases[cur];
  const tasks = current ? (p.tasks || []).filter(task => phases.some(ph => ph.name === task.phase)
    ? task.phase === current.name : true) : [];
  const continued = p.phaseContinueKey && p.phaseContinueKey === p.phaseOfferKey;
  const phasePending = current && ((tasks.length > 0 && tasks.every(task => task.state === '完了') && !continued) || current.completionPending);
  const stepCount = (t.steps || []).filter(step => step.done).length;
  const lines = [
    lt('【人への操作案内の決まり】'),
    lt`画面に見えるプロジェクト「${name(p.name)}」・作業「${name(t.title)}」と正式な［ボタン名］・場所で案内する。内部IDや「Hub」だけで探させない。IDは最後の補足にとどめる。`,
    lt('あなたは人の画面を見ていない。「会話画面なら上部の帯」のように条件付きで示す。今の画面で操作できるなら不要な画面移動やリンクを出さない。ボタンが無い・押せない時は理由と可能な次の操作を示す。'),
    lt('操作の対象と効果を区別する：作業の完了はこの作業1つだけ（フェーズ・全体は完了にしない）。フェーズを次へは現在のフェーズを完了して次へ。プロジェクト全体の完了は全体の状態変更。本体への取り込みはコピーの変更を本体へ入れ、コピーを片付けてこの作業も完了にする。'),
    lt('作業1つの完了に全体完了を勧めない。AI稼働中は完了承認を断られるので「この返事が終わってから」と案内する。フェーズ・全体の完了も、そのプロジェクトのAI終了後に行う。'),
    lt('ボタン名の無い停止や終了の操作を頼まない。人に止めてもらう必要がある時は、理由・場所（作業画面の［ターミナル］の、その AI の欄）・ボタン（［停止］）を書く。画面を切り替えただけでは止まらない。'),
    lt`【操作情報（${where === 'terminal' ? lt('ターミナル') : lt('会話画面')}からの依頼を受け取った時点。順番待ち・作業中に変わるため現在の画面と一致する時だけ案内）】`,
    lt`プロジェクト「${name(p.name)}」／作業「${name(t.title)}」／状態：${name(t.state)}／手順 ${stepCount}/${(t.steps || []).length}`,
    where === 'terminal' ? lt('人はターミナルか別の画面を見ている可能性がある。作業画面を開いているとは断定しない。') : lt('この作業の会話画面なら、以下の作業操作はその画面の上部でできる。'),
  ];
  if (t.question && t.state !== '完了') lines.push(lt('作業の完了：質問への返事が先。完了の操作はまだ出ない。まず質問に答える。'));
  else if (t.resultsPending) lines.push(t.resultsPending.auto === 'running' ? lt('作業の完了：AIが成果の記録を整えています。整ってから完了確認が出ます。') : lt('作業の完了：成果の記録が整っていません。上部の帯の［成果の整理を頼む］でAIへ依頼できます。'));
  else if (t.completionPending) lines.push(lt('作業の完了：作業画面の上部に黄色い帯「AI が手順をすべて済にしました。完了に移しますか？」と［完了に移す］［まだ続ける］がある。作業一覧の行の下、［あなたの番］の［完了確認］にも同じ操作がある。'));
  else if (t.state === '完了') lines.push(lt('作業の完了：完了済み。続ける時は作業画面の上部に［再開する］がある。'));
  else lines.push(lt('作業の完了：作業画面の上部に［完了に移す］がある（今は確認の黄色い帯なし）。'));
  if (phasePending) lines.push(lt`フェーズ：プロジェクト画面の上部「「${name(current.name)}」を完了に移しますか？」の帯に［${phases[cur + 1] ? lt`次のフェーズ「${name(phases[cur + 1].name)}」へ進む` : lt('プロジェクトを完了にする')}］［まだ続ける］がある。${phases[cur + 1] ? '' : lt('最終フェーズなので全体も完了になる。')}`);
  else if (current) lines.push(lt('フェーズ：次へ進む確認帯はまだ無い。現在のフェーズの作業を進める（「まだ続ける」を選んだ場合は手順の更新後に再確認）。'));
  else lines.push(phases.length ? lt('フェーズ：すべて完了済みなので、次へ進む確認帯は無い。必要ならプロジェクト全体の状態を確認する。') : lt('フェーズ：フェーズが設定されていないので、次へ進む確認帯は無い。この作業の操作を案内する。'));
  lines.push(lt`プロジェクト全体：プロジェクト画面の上部に［${p.status === '完了' ? lt('完了を取り消す') : lt('プロジェクトを完了にする')}］がある。`);
  const graph=require('../public/project-order'),integrators=graph.integrators(p,t,projects);
  if (copyMissing) lines.push(lt('取り込み：作業用コピーが見つからない。作業画面の上部に［記録を片付ける］がある。古い場所の記録を消すだけで取り込みではない。'));
  else if (copy && integrators.length) lines.push(lt`取り込み：子自身には取り込みボタンが無い。祖先作業「${name(integrators[0].task.title)}」の上部「子作業の成果」の［統合…］で取り込む。${mergeExcluded ? lt('今は取り込み対象外。子の作業画面の名前の右に［取り込み対象に戻す］がある。戻してから祖先で統合する。') : ''}`);
  else if (copy) lines.push(mergeExcluded ? lt('取り込み：対象から外してある。作業画面の名前の右に［取り込み対象に戻す］がある。') : lt('取り込み：作業画面の名前の右に［本体に取り込む］がある。AI終了後、確認結果を見て行う。'));
  else lines.push(lt('取り込み：この時点では作業用コピーが無く、取り込みは不要。'));
  const target = require('../public/project-order').taskTarget(p,t,projects);
  if (target) lines.push(graph.finished(t)&&!t.question&&!t.resultsPending?lt`引渡し：作業画面の名前の右に［成果を渡す］がある。渡す先は「${name((integrators[0]||target).task.title)}」。AIが成果を整理する。人は内容説明を確認して渡す。渡す操作は通知だけでコピーと会話は残し、祖先の［統合…］が成功した後に片付ける。`:lt('引渡し：完了条件を満たすと作業画面の名前の右に［成果を渡す］が出る。今は手順・質問を済ませる。祖先は引渡し操作なしでも完了子の成果を拾える。'));
  if(projects.some(q=>q.tasks?.some(x=>graph.canIntegrate({project:p,task:t},q,x,projects)&&graph.finished(x))))lines.push(lt('子作業の統合：上部「子作業の成果」［統合…］。AI終了後、内容説明を見て［統合して片付ける］。記録なしは［この子のAIに成果の整理を頼む］。'));
  lines.push(lt('本作業で成果を受け取ったら、必要に応じGitHubへの更新・ソフトやホームページの本番適用の対象と変更内容・検証結果を確認し、人へ最終確認する。引渡し・作業完了だけでpushや公開を実行しない。'));
  return lines.join('\n');
}
module.exports = { guidance };
