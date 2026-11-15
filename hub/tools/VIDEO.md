# 動画の文字起こし（任意）

通常の setup.sh は変更せず、文字起こしを使う人だけが導入します。人が承認した後に、Hub 専用の `.venv-video` へ入れます。他の作業の環境は使いません。有料 API、API キーやログインは不要です。

## Apple Silicon Mac

Python 3.11 を推奨します（システム付属の 3.9 は使いません）。既に Python 3.11 と uv がある場合は、Hub フォルダで次を実行します。`--no-python-downloads` は Python 自体の取得を禁止します。部品は PyPI から取得します。

```sh
uv venv --python 3.11 --no-python-downloads .venv-video
uv pip install --python .venv-video/bin/python --index-url https://pypi.org/simple --only-binary=:all: -r tools/video-requirements-mlx.txt
.venv-video/bin/python -I tools/transcribe-video.py --check
```

`mlx-whisper==0.4.3` を使い、`{"status": "ready", "backend": "mlx"}` なら準備できています。取得済みの `mlx-community/whisper-large-v3-mlx` の `config.json` と `weights.npz` が必要です。標準の保存場所は `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/snapshots/` です。turbo 版や別のモデルへは切り替えません。この Mac で導入・確認した依存部品の版は `video-environment-macos-arm64.txt` に記録しています（CPU 比較用の faster-whisper も含む記録で、他の OS 共通の固定表ではありません）。

## Intel Mac・Windows など

既存の Python 3.11 で専用環境を作り、`tools/video-requirements-cpu.txt` を入れます。Mac 等では次の形です。

```sh
python3.11 -m venv .venv-video
.venv-video/bin/python -m pip install --index-url https://pypi.org/simple --only-binary=:all: -r tools/video-requirements-cpu.txt
.venv-video/bin/python -I tools/transcribe-video.py --check
```

Windows は環境作成を `py -3.11 -m venv .venv-video`、以降の Python を `.venv-video\Scripts\python.exe` に読み替えます。`faster-whisper==1.2.1` を CPU・int8・最大4スレッド・beam size 5 で使います。表示は `{"status": "ready", "backend": "faster-whisper"}` です。取得済みの `Systran/faster-whisper-large-v3` が必要です。標準の保存場所は `~/.cache/huggingface/hub/models--Systran--faster-whisper-large-v3/snapshots/` です。無音除去（VAD）が発話まで取り除いた実測を踏まえ、VAD を無効にして全音声を認識します。Hub 専用環境で同じ15分の日本語音声を比較し、VAD 有効では約8分37秒・文字誤り率28.2%、無効では約7分23秒・17.1%でした（前文の引継ぎはいずれも無効、正解との時刻単位の照合）。無効でも発話の抜けや時刻ずれは残り、解消を保証しません。Intel Mac・Windows の実機確認は行っていません。

`tools/video-requirements.txt` は実行環境で上記のどちらかを選ぶ互換用の入口です。ネットに接続せず導入する場合は、別途用意した対応 wheel 一式を `pip install --no-index --find-links <部品のフォルダ> -r <対応する requirements>` で指定します。

## 認識・待ち時間・失敗時の扱い

両方式とも言語は自動判定、`condition_on_previous_text=False` で認識します。Mac 向けでも、誤りと時間が増えた `hallucination_silence_threshold` は指定しません。`HF_HOME` / `HF_HUB_CACHE` を設定している場合はその保存場所を使います。取得済みモデルの実在するパスだけを渡し、動作中は Hugging Face のオフライン設定とテレメトリ無効化を強制します。モデルの自動取得はしません。道具・モデルが使えなければ場面だけで続けます。

音声は16kHz・モノラルの一時 PCM16 WAV にし、成功・失敗を問わず処理後に削除します。Mac 向けには WAV を配列として渡し、mlx-whisper 自身の追加 ffmpeg 起動を避けます。時刻付き本文は同じ添付フォルダの `transcript.txt`、場面と本文の場所は `video.txt` に保存します。「ご視聴ありがとうございました」「謝謝收看」「请不吝点赞」などは消さずに「音声認識の定型句の疑い」と印を付けます。本当に話している可能性もあるため、印は誤認識の断定ではありません。自動認識なので聞き間違いや発話の見落としはあり得ます。

映像の処理はメタデータ確認10秒、場面検出最大12秒を含む場面抽出45秒までです。音声抽出は30秒まで。音声抽出と認識を合わせた上限は、Mac 向けが10分、CPU 方式が30分です。M4 の公開音声15分の実測は Mac 向けで約2分でしたが、長い発話や他の作業の負荷に備え、十分な余裕を残しています。これは処理時間の保証ではありません。

画面は処理環境を判別していないため、共通の「通常数分、環境により最大30分」という案内を使います。進捗率や処理段階の表示ではありません。添付を送るのは準備終了後ですが、ほかの会話は使えます。メモリと CPU/GPU の負荷を抑えるため、文字起こしは全体で同時に1件だけとし、重なった添付は待たせず場面だけで続け、理由を表示します。ブラウザを閉じても、開始済みの処理は上限時間まで続く場合があります。今回の案内・制限時間を含め、変更を稼働中の Hub にすべて反映するには、別途承認したうえで再起動が必要です。

音声があり、道具またはモデルを使えない時は従来の均等8枚になります。それ以外は長さに応じて4〜16枚とし、最大半数を場面の切替えから、残りを全体の等間隔から選びます。場面検出が失敗しても等間隔で続けます。画像は各辺960px以内。動画の文字起こしが失敗・時間切れになっても、取り出せた場面は保持します。動画は引き続き50MB・10分まで、他の画像・動画と合計20枚を超える場合は送信時に添付を減らす案内を出します。動画1本は最大16枚なので、場面が16枚の動画と画像4枚を一度に送れます。

字幕帯画像は、回転を反映した画面の下側約35%だけを対象とします。約0.25秒ごとの区間から実際のフレームを1本ずつ選び、元の時刻を保持したまま mpdecimate でほぼ同じ帯を除きます。固定4fpsへ時刻を丸めると、切り出し直した画像が前の字幕になる場合があるため、実フレームの時刻で照合します。2本未満なら画像を作らず「字幕の変化は見つかりませんでした」と案内します。文字認識で字幕の有無を判定しているわけではなく、背景の動きも拾う場合があります。字幕の全行や短い表示の網羅は保証できません。縦長動画の中央字幕への対応は今後の課題です。

切り出し1本の幅は最大640px、縦横比を保って高さ最大800pxとし、2列・最大12行（24本）、画像全体は1600px以内に収めます。帯が縦に長い動画では、文字を潰す縮小を避けるため収録本数を減らします。入り切らない時は先頭・末尾を含め全体から均等に選び「字幕帯は一部のみ」と伝えます。画像に時刻を描き込まず、`video.txt` に「字幕帯 n本目＝[mm:ss]」と秒の小数値を記録します。並び順は左上から右、その次の行です。画像は `subtitles.jpg` に保存し、場面画像と同じくAIへ渡します。

字幕帯画像も動画1本16枚の上限に含め、上限時は場面15枚＋字幕帯1枚です。音声の道具・モデルが使えない従来方式では場面8枚＋字幕帯1枚になります。合計20枚の上限は変えません。字幕帯の処理全体は追加で20秒まで（各子処理は残り時間を上限とし、時間切れはSIGKILL）。一時画像は専用の一時フォルダへ `-n` で作り、成功・失敗にかかわらず片付け、完成画像だけを上書き禁止で保存します。各画像は4MBまで。字幕帯で失敗・時間切れが起きても場面と文字起こしは続行し、省略理由を案内します。

変換と文字起こしでは外部への送信・モデル取得を行いません。AI に渡す参照情報には文字起こし本文の場所も加わるため、会話で選んだ AI はほかの添付資料と同じようにその内容を参照できます。AI 自身の道具や権限は変更しません。
