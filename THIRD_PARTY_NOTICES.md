# THIRD_PARTY_NOTICES

Project Hub に関係する第三者のソフトと、由来の表記です。各ソフトの著作権はそれぞれの著作権者にあります。

## Hermes Web Community（音声入力のブラウザ経路を改変利用）

- 元ソース：https://github.com/arumwu/Hermes-Web-Community/blob/6079b133b244212fb972b69c8099c68939d2cae2/web/app.js#L1567-L1591
- 固定版：`6079b133b244212fb972b69c8099c68939d2cae2`。LICENSEとTHIRD_PARTY_NOTICES.mdを照合。
- 場所：`hub/public/speech-input.js`。日本語、カーソル挿入、停止・遅延結果の保護を追加。
- HermesNative、サーバー文字起こし、Hermes Agent/Android/Desktopのソース・ブランドは含めません。

```
MIT License

Copyright (c) 2026 Hermes Web contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## xterm.js（同梱）

- 場所：`hub/public/vendor/`（`xterm.js`・`xterm.css`・`addon-fit.js`）
- ライセンス：MIT。原文は `hub/public/vendor/LICENSE-xterm` にあり、そのまま残しています

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## node-pty（同梱しない・npm で取得）

- 版：1.1.0（`hub/package.json` の dependencies）
- この公開物には入っていません。`setup.sh` が npm で取得します
- ライセンスと著作権表示は、インストール先（`hub/node_modules/node-pty/`）にある LICENSE などに従ってください

## 由来：discordpy-startup

Project Hub は、Discord Bot テンプレート「discordpy-startup」のリポジトリで作り始めました。テンプレートの Bot・Python・Heroku の設定はこの公開物に入っていませんが、由来として次の表記を残します。

```
MIT License

Copyright (c) 2019-2020 Discord Bot Portal JP

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 参考にしたもの（ソースは同梱しない）

考え方を参考にしました。ソースは入っておらず、依存もしていません。

- teddashh/bat-agent-connector（MIT）：入力待ちの見張り、取り込み前の確認、操作の記録
- arumwu/goose-acp-handoff：AI を交代する時の引き継ぎ資料

## 取り入れた Pull Request

- [walkpod1007 / PR #6](https://github.com/kieiken/project-hub/pull/6)（7191e559e796d487805d3843c1dff26b9d15626c）：中継接続の判定・接続元取得を現行版へ適応しました。
- [arumwu / PR #2](https://github.com/kieiken/project-hub/pull/2)（af9c4d824d772a5be7a4f299d01a14ecdde6179b）：一覧の幅調整（sidebar-resize.js、対応する画面・試験）だけを現行版へ適応しました。
- いずれも Project Hub の MIT ライセンスで提供された変更です。各投稿者の由来をここに残します。

## Microsoft WebView2（Windows専用窓に同梱）

- Microsoft.Web.WebView2 1.0.4258.31、net462 の Core / WinForms と x64 WebView2Loader の3 DLL
- 公式 NuGet 由来。取得URLとSHA256は `hub/app/windows/vendor/webview2/1.0.4258.31/manifest.json`
- 許諾・著作権・免責の原文：`hub/app/windows/vendor/webview2/1.0.4258.31/LICENSE.txt`（Microsoft Corporation）。バイナリと一緒に配布します。
- WebView2 Evergreen Runtime は同梱・自動導入しません。

## CodexBar（Museの利用枠取得の探索・解析手順をPythonへ移植）

- 元ソース：https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/Sources/CodexBarCore/Resources/Plugins/museai.js
- 場所：`hub/lib/muse/usage.py`。ブラウザ・他アカウントの探索を除き、既存の登録1件・宛先・容量・時間を制限。

```
MIT License
Copyright (c) 2026 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
