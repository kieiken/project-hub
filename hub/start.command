#!/bin/bash
# 設定済みのディスク確認が失敗したら、保存や起動より前に止める。
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
# Project Hub を起動して、ブラウザで開く
cd "$(dirname "$0")"
PORT="${HUB_PORT:-4545}"
URL="http://127.0.0.1:$PORT"

# すでに動いていれば、ブラウザで開くだけ
if curl --noproxy '*' -fs -o /dev/null "$URL/api/state"; then
  open "$URL"
  exit 0
fi

# デスクトップから開くと Node.js の場所が見つからないことがあるので、よくある場所を足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$HOME/.grok/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "Node.js が見つかりません。https://nodejs.org から入れてください。"
  read -r -p "Enter で閉じます"
  exit 1
fi

"$NODE" server.js &
PID=$!

# 本体の準備ができてからブラウザを開く（最大10秒待つ）
for _ in $(seq 1 20); do
  if curl --noproxy '*' -fs -o /dev/null "$URL/api/state"; then
    open "$URL"
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.5
done

wait "$PID"
echo ""
echo "Project Hub が止まりました。上に出ているメッセージを Claude に貼ってください。"
read -r -p "Enter で閉じます"
