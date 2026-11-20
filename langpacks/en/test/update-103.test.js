'use strict';
// Test the actual product formatter with each optional dictionary. No app start.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
for (const language of ['en', 'zh-TW']) {
  const read = name => JSON.parse(fs.readFileSync(path.join(root, 'langpacks', language, name + '.json'), 'utf8'));
  const pack = read('ui');
  function context() {
    const c = vm.createContext({ HUB_LOCALE: { locale: language, messages: pack }, document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} }, esc: x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') });
    c.setInterval = () => 0; // Render-only fixture; never poll a live application.
    for (const file of ['locale.js', 'app-update.js']) vm.runInContext(fs.readFileSync(path.join(root, 'hub/public', file), 'utf8'), c);
    return c;
  }
  test(language + ': update summaries and manual-check feedback use the new pack', () => {
    const c = context();
    for (const d of [
      { currentVersion: '4.126.103', latestVersion: '4.126.103', phase: 'idle' },
      { currentVersion: '4.126.102', latestVersion: '4.126.103', phase: 'ready' },
      { phase: 'checking' }, { phase: 'failed', error: 'opaque error' }, {},
    ]) {
      const key = c.appUpdateSummary(d).text;
      assert.ok(pack[key]);
      assert.notEqual(c.UI.text(key), key);
      assert.ok(c.appUpdateHtml(d).includes(pack[key]));
    }
    for (const key of [
      '連続した確認を防ぐため、前回の手動確認から60秒は再確認できません。',
      '前回の更新を確認できなかったため、24時間の再確認待ちです。',
      '更新の処理中です。終わるまで手動確認はできません。',
      '準備済みの更新があるため、配信元への再確認はしていません。',
    ]) {
      const d = { checkPerformed: false, checkSkippedReason: key, manualCheckBlockedReason: key, nextManualCheck: '2026-11-17T20:00:00+09:00' };
      assert.ok(c.appUpdateCheckFeedback(d).includes(pack[key]));
      assert.ok(c.appUpdateCheckFeedback(d).includes(pack['次に手動確認できる時刻：']));
    }
    assert.equal(c.appUpdateCheckFeedback({ checkPerformed: true }), pack['配信元に更新を確認しました。']);
    assert.equal(c.appUpdateCheckFeedback({ checkPerformed: true, error: 'opaque' }), pack['更新を確認できませんでした。下の表示を確かめてください。']);
  });
  test(language + ': cancel action and stored API values survive rendering', () => {
    const c = context(), d = { supported: true, mode: 'packaged', currentVersion: '4.126.102', latestVersion: '4.126.103', phase: 'deferred', pending: true, autoReopen: { phase: 'waiting', reason: '利用者の文 <unsafe>' } };
    const before = JSON.stringify(d), html = c.appUpdateHtml(d);
    assert.ok(html.includes(pack['自動の開き直しを取り消す']));
    assert.match(html, /data-app-update="cancel-reopen"/);
    assert.match(html, /data-app-update="apply"/);
    assert.match(html, /利用者の文 &lt;unsafe&gt;/);
    assert.equal(JSON.stringify(d), before);
    const value = '<利用者の入力>'; // Plain-text template values remain opaque.
    const rendered = c.HubI18n.template`処理待ち（${value}）`;
    assert.ok(rendered.includes(value));
  });
  test(language + ': registration hold and adoption catalog retain their meanings', () => {
    const messages = read('backend').messages;
    const hold = '以前の登録記録と引継ぎ元の端末情報を照合できないため、利用権を引き継いでいません。選んだデータの保存先は使えます。有料機能・無料体験の開始・コード登録は保留しています。購入や登録を繰り返さず、この表示をお知らせください。';
    assert.ok(messages[hold]);
    assert.notEqual(messages[hold], hold);
    assert.ok(messages['会話の保存と実行状態を確認できないため、あとで更新を適用します。']);
    assert.ok(messages['自動で開き直せませんでした。処理が終わったらアプリを閉じて同じアプリを開き直してください。']);
    assert.ok(messages[' 確認箇所：古い試験版の登録記録の保管状態を確認できません。']);
  });
}
