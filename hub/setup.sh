#!/bin/bash
# Project Hub の準備（何度実行しても大丈夫）
# - 架空のサンプル台帳を ~/Documents/AI-Workspace/Product/ に作る（すでにある台帳は触らない）
# - 役割分担（roles.yaml）を置く
# - 画面の中の作業画面に使う部品（node-pty）を入れる
# - デスクトップに「Project Hub」を置く（ダブルクリックで起動）
set -eu
# 設定済みのディスク確認が失敗したら、保存や起動より前に止める。
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HUB_ROOT:-$HOME/Documents/AI-Workspace}"
export HUB_LANG="${HUB_LANG:-ja}"
TPL="$HERE/../docs/project-hub/templates"
SEED="$HERE/seed"
if [ "$HUB_LANG" = "zh-TW" ]; then
  TPL="$TPL/zh-TW"
  SEED="$HERE/seed-zh-TW"
fi

mkdir -p "$ROOT/_hub" "$ROOT/Product" "$ROOT/Work"
if [ ! -f "$ROOT/_hub/roles.yaml" ]; then
  cp "$TPL/_hub/roles.yaml" "$ROOT/_hub/roles.yaml"
  echo "作成: _hub/roles.yaml"
fi

for seed in "$SEED"/*/; do
  name="$(basename "$seed")"
  dest="$ROOT/Product/$name"
  if [ -f "$dest/PROJECT.md" ]; then
    echo "そのまま: ${name}（台帳あり）"
    continue
  fi
  mkdir -p "$dest"
  cp -R "$TPL/project/." "$dest/"
  cp -R "$seed." "$dest/"
  find "$dest" -name .gitkeep -delete
  echo "作成: $name"
done

# 画面の中の作業画面に使う部品
if [ "${HUB_SKIP_NPM:-0}" != "1" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if command -v npm >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
      echo "部品の組み立てに Apple の開発ツールが要ります。表示された窓で「インストール」を押し、終わったらもう一度 setup.sh を実行してください。"
      xcode-select --install || true
      exit 0
    fi
    echo "部品（node-pty）を入れています…（1〜2分）"
    if (cd "$HERE" && npm install --no-audit --no-fund --loglevel=error \
        && { find node_modules/node-pty -name spawn-helper -exec chmod 755 {} + 2>/dev/null || true; }); then
      echo "作成: 作業画面の部品"
    else
      echo "注意: 部品を入れられませんでした。管理ソフトは動きますが、作業は別の窓で開きます。上のメッセージを Claude に貼ってください。"
    fi
  else
    echo "注意: npm が見つかりません。作業は別の窓で開きます。"
  fi
fi

chmod +x "$HERE/start.command" "$HERE/app/run.sh" "$HERE/app/build-app.sh"
if [ "$(uname)" = "Darwin" ] && [ "${HUB_SKIP_APP:-0}" != "1" ]; then
  bash "$HERE/app/build-app.sh"
elif [ "${HUB_SKIP_APP:-0}" != "1" ]; then
  if [ "${OS:-}" = "Windows_NT" ]; then
    echo "準備できました（Windows なので .app は作りません）。hub/start.bat をダブルクリックで起動します。"
  else
    echo "準備できました（Mac 以外なので .app は作りません）。bash start.command で起動します。"
  fi
fi
