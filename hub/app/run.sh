#!/bin/bash
# 設定済みのディスク確認が失敗したら、保存や起動より前に止める。
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
export HUB_LANG="${HUB_LANG:-ja}"
# .app の中から呼ばれる。本体（server.js）を裏で動かし、専用の窓（WebKit）で画面を開く。
HUB_DIR="${HUB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${HUB_PORT:-4545}"
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/ProjectHub.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
log() { echo "[$(date '+%H:%M:%S')] $*"; }
log "起動: HUB_DIR=$HUB_DIR WINDOW=${HUB_APP_WINDOW:-なし}"
cd "$HUB_DIR" || { log "HUB_DIR に移動できません"; exit 1; }

# 何か答えが返れば動いているとみなす（一覧は重いことがあるので、軽い /api/ping に聞く）
alive() { [ "$(curl --noproxy '*' -s -m 4 -o /dev/null -w '%{http_code}' "$URL/api/ping")" != "000" ]; }

if ! alive; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$HOME/.grok/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE="$(command -v node || true)"
  [ -z "$NODE" ] && NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
  log "node: ${NODE:-見つからない}"
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    osascript -e 'display dialog "Node.js が見つかりません。https://nodejs.org から入れてください。" buttons {"OK"} with icon stop' >/dev/null
    exit 1
  fi
  log "本体を起動します"
  nohup "$NODE" server.js >> "$LOG" 2>&1 &
  for _ in $(seq 1 30); do alive && break; sleep 0.3; done
  if ! alive; then
    osascript -e "display dialog \"Project Hub を起動できませんでした。ログ: $LOG\" buttons {\"OK\"} with icon stop" >/dev/null
    exit 1
  fi
fi

# 専用の窓で開く（Mac 内蔵の WebKit）。組み立て済みの窓が無ければブラウザで開く
log "本体は動いています。窓を開きます"
if [ -n "${HUB_APP_WINDOW:-}" ] && [ -x "$HUB_APP_WINDOW" ]; then
  exec "$HUB_APP_WINDOW" "$URL"
fi
log "専用の窓が無いので、ブラウザで開きます"
open "$URL"
