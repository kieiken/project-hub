#!/bin/bash
# 「Project Hub.app」を作る（Mac 用）。ダブルクリックで起動し、専用の窓に画面が開く。
# アプリ自身が本体（node server.js）を起動するので、ターミナルは要らない。
# 使い方: bash app/build-app.sh   → ~/Applications/Project Hub.app と、デスクトップへのリンク
set -eu
export HUB_LANG="${HUB_LANG:-ja}"
# 設定済みのディスク確認が失敗したら、保存や起動より前に止める。
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"        # hub/
DEST="${HUB_APP_DIR:-$HOME/Applications}"
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -n 1)"   # package.json の版
TARGET="$DEST/Project Hub.app"
mkdir -p "$DEST"
STAGE="$(mktemp -d "$DEST/.ProjectHub-build-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Project Hub.app"
BUILD_LOG="$HOME/Library/Logs/ProjectHub-build.log"
mkdir -p "$HOME/Library/Logs"

# 先に組み立てる。失敗したら、今のアプリには触らない（壊れたアプリを残さない）
BIN=""
if command -v swiftc >/dev/null 2>&1; then
  BIN="$STAGE/ProjectHub"
  echo "アプリを組み立てています…（1分ほど）"
  SWIFT_ARGS=(-O)
  if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
    SWIFT_ARGS+=(-target "$(uname -m)-apple-macosx12.0")
  fi
  if ! swiftc "${SWIFT_ARGS[@]}" -o "$BIN" "$HERE/app/window.swift" 2>"$BUILD_LOG"; then
    echo "アプリを組み立てられませんでした（今のアプリはそのまま）。次の記録を Claude に貼ってください:"
    tail -n 20 "$BUILD_LOG"
    exit 1
  fi
fi

# 検証が済むまで旧Appに触らず、同じディスクの別の場所で作る。
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ -n "$BIN" ]; then
  EXEC="ProjectHub"
  mv "$BIN" "$APP/Contents/MacOS/$EXEC"

else
  if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
    echo "持ち運べるAppには Apple の開発ツールが必要です"
    exit 1
  fi
  # 開発ツールが無い時の代わり：台本で本体を起動してブラウザで開く
  EXEC="launch"
  node - "$HERE" "$APP/Contents/MacOS/launch" "${HUB_ROOT:-}" "${HUB_STORAGE_GUARD:-}" "${HUB_UPDATE_APP:-$TARGET}" "$HUB_LANG" <<'NODE'
const fs = require('fs');
const [hub, file, root, guard, app, language] = process.argv.slice(2);
const sq = s => "'" + s.replaceAll("'", "'\\''") + "'";
const env = { HUB_LANG:language, HUB_DIR:hub, HUB_UPDATE_SOURCE:require('path').dirname(hub), HUB_UPDATE_APP:app };
if (root) env.HUB_ROOT = root;
if (guard) env.HUB_STORAGE_GUARD = guard;
fs.writeFileSync(file, '#!/bin/bash\n' + Object.entries(env).map(([k,v]) => 'export ' + k + '=' + sq(v)).join('\n') + '\nexec /bin/bash ' + sq(hub + '/app/run.sh') + '\n');
NODE
  chmod +x "$APP/Contents/MacOS/launch"
  echo "注意: Apple の開発ツールが無いので、ブラウザで開く形で作りました（xcode-select --install で入ります）"
fi

# CI distribution embeds only runtime inputs, never a ledger or Git history.
HUB_LOCATION="$HERE"
APP_ROOT="${HUB_ROOT:-}"
APP_GUARD="${HUB_STORAGE_GUARD:-}"
if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
  RUNTIME="$APP/Contents/Resources/runtime"
  mkdir -p "$RUNTIME/hub" "$RUNTIME/docs/project-hub"
  for item in lib public locales node_modules server.js mcp.js package.json package-lock.json; do
    [ -e "$HERE/$item" ] || { echo "同梱する本体がありません: $item"; exit 1; }
    cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  cp -R "$HERE/../docs/project-hub/templates" "$RUNTIME/docs/project-hub/"
  for item in README.md README.zh-TW.md LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_NOTICES.zh-TW.md; do
    cp "$HERE/../$item" "$RUNTIME/"
  done
  for item in README.md README.zh-TW.md CHANGELOG.md CHANGELOG.zh-TW.md seed seed-zh-TW; do
    cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  HUB_LOCATION="@bundle/runtime/hub"
  # Recipient workspace/guard are provided at launch, not copied from CI.
  APP_ROOT=""
  APP_GUARD=""
fi

# 起動設定をXMLとしてエスケープして保存する（パスの & や引用符を保持）。
node - "$HERE/package.json" "$APP/Contents/Info.plist" "$EXEC" "$HUB_LOCATION" "${HUB_PORT:-4545}" "$APP_ROOT" "$APP_GUARD" "$HUB_LANG" <<'NODE'
const fs = require('fs');
const [pkg, file, executable, hub, port, root, guard, language] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync(pkg)).version;
const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const tr = (ja, zh) => language === 'zh-TW' ? zh : ja;
const values = {
 CFBundleName:'Project Hub', CFBundleDisplayName:'Project Hub', CFBundleIdentifier:'local.projecthub',
 CFBundleVersion:version, CFBundleShortVersionString:version, CFBundleDevelopmentRegion:language === 'zh-TW' ? 'zh-TW' : 'ja',
 CFBundlePackageType:'APPL', CFBundleExecutable:executable, CFBundleIconFile:'AppIcon', LSMinimumSystemVersion:'12.0',
 NSDocumentsFolderUsageDescription:tr('書類フォルダにあるプロジェクトの台帳と本体を読み書きするために使います。', '用於讀寫文件資料夾中的專案台帳與本體。'),
 NSDesktopFolderUsageDescription:tr('デスクトップにある資料を開くために使います。', '用於開啟桌面上的資料。'),
 NSAppleEventsUsageDescription:tr('Finder に、フォルダやファイルの場所を開いてもらうために使います。', '用於透過 Finder 開啟資料夾或檔案位置。'),
 NSDownloadsFolderUsageDescription:tr('ダウンロードフォルダにある資料を開くために使います。', '用於開啟下載資料夾中的資料。'),
 HubDir:hub, HubPort:port, HubRoot:root, HubStorageGuard:guard, HubLanguage:language
};
fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' + Object.entries(values).map(([k,v]) => '<key>'+k+'</key><string>'+xml(v)+'</string>').join('\n') + '\n<key>CFBundleLocalizations</key><array><string>ja</string><string>zh-TW</string></array>\n<key>NSHighResolutionCapable</key><true/>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict></plist>\n');
NODE

# アイコン：app/icon.png（Codex が仕上げた 1024×1024）→ 無ければ見本の icon-concept.png から .icns を作る
ICON_SRC=""
for f in "$HERE/app/icon.png" "$HERE/app/icon-concept.png"; do [ -f "$f" ] && { ICON_SRC="$f"; break; }; done
if [ -n "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  SET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null; then echo "作成: アイコン（$(basename "$ICON_SRC")）"; else echo "注意: アイコンを作れませんでした"; fi
  rm -rf "$(dirname "$SET")"
fi
touch "$APP"   # Finder・Dock にアイコンの変更を知らせる

# 署名（自分のパソコン用）。Mac が「同じアプリ」と覚え、許可の確認を正しく出せるようにする
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
fi
touch "$APP"

# 完成・署名検証後に旧Appを残して入れ替える。移動失敗では元に戻す。
BACKUP=""
if [ -e "$TARGET" ]; then
  BACKUP="$TARGET.backup-$(date '+%Y%m%d-%H%M%S')-$$"
  mv "$TARGET" "$BACKUP"
fi
if ! mv "$APP" "$TARGET"; then
  [ -z "$BACKUP" ] || mv "$BACKUP" "$TARGET"
  exit 1
fi
touch "$TARGET"
# 更新準備中はデスクトップに触らない。既存の実体も消さない。
if [ "${HUB_NO_DESKTOP_LINK:-0}" != "1" ] && [ -d "$HOME/Desktop" ]; then
  LINK="$HOME/Desktop/Project Hub.app"
  if [ -L "$LINK" ]; then rm "$LINK"; fi
  if [ ! -e "$LINK" ]; then ln -s "$TARGET" "$LINK"; fi
fi
echo "作成: $TARGET"
