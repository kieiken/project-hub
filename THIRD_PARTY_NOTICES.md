# THIRD_PARTY_NOTICES

Project Hub に関係する第三者のソフトと、由来の表記です。各ソフトの著作権はそれぞれの著作権者にあります。

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


## Windows fork: sharp

Windows image conversion additionally uses sharp 0.35.5 (Apache-2.0), Copyright Lovell Fuller and contributors. Its platform packages include libvips and additional image libraries; their notices are distributed in the installed npm packages. See https://github.com/lovell/sharp and the installed node_modules/sharp/LICENSE and node_modules/@img package notices.
