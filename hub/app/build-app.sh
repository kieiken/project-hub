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
if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ] && [ -e "$HERE/lib/license/owner-edition.js" ]; then
  echo "一般配布物には製作者版の印を含められません。公開用に抽出した本体から作成してください"
  exit 1
fi
PACK=""
if [ "$HUB_LANG" != "ja" ]; then
  PACK="$(node - "$HERE" <<'NODEJS'
const needs = process.env.HUB_BUNDLE_RUNTIME === '1' ? ['native', 'templates', 'seed', 'docs'] : ['native'];
console.log(require(process.argv[2] + '/lib/locale').activePack(needs)?.directory || '');
NODEJS
)"
  [ -n "$PACK" ] || export HUB_LANG=ja
fi
DEST="${HUB_APP_DIR:-$HOME/Applications}"
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -n 1)"   # package.json の版
TARGET="$DEST/Project Hub.app"
mkdir -p "$DEST"
STAGE="$(mktemp -d "$DEST/.ProjectHub-build-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Project Hub.app"
BUILD_LOG="${HUB_BUILD_LOG:-$HOME/Library/Logs/ProjectHub-build.log}"
mkdir -p "$(dirname "$BUILD_LOG")"

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
  node - "$HERE" "$APP/Contents/MacOS/launch" "${HUB_ROOT:-}" "${HUB_STORAGE_GUARD:-}" "${HUB_UPDATE_APP:-$TARGET}" "$HUB_LANG" "$PACK" <<'NODE'
const fs = require('fs');
const [hub, file, root, guard, app, language, pack] = process.argv.slice(2);
const sq = s => "'" + s.replaceAll("'", "'\\''") + "'";
const env = { HUB_LANG:language, HUB_DIR:hub, HUB_UPDATE_SOURCE:require('path').dirname(hub), HUB_UPDATE_APP:app, HUB_LANGPACK_DIR:pack };
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
APP_PACK="$PACK"
if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
  RUNTIME="$APP/Contents/Resources/runtime"
  mkdir -p "$RUNTIME/hub" "$RUNTIME/docs/project-hub"
  for item in app lib public node_modules server.js mcp.js package.json package-lock.json; do
    [ -e "$HERE/$item" ] || { echo "同梱する本体がありません: $item"; exit 1; }
    cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  # The private bundle is optional in an OSS build; an official bundle marker
  # requires every declared feature and its UI before the old App is touched.
  node - "$HERE" "$RUNTIME/hub" <<'CHECKPAID'
const path=require('node:path');
const extensions=require(path.join(process.argv[2],'lib/extensions')).loadExtensions({hub:process.argv[2]});
if(extensions.state().missing.length)throw Error(extensions.state().notice);
extensions.uiSource(); extensions.uiSource('style');
const fs=require('node:fs'), source=process.argv[2], target=process.argv[3];
if(fs.existsSync(path.join(source,'paid')))fs.cpSync(path.join(source,'paid'),path.join(target,'paid'),{recursive:true,filter:file=>path.basename(file)!=='test'});
if(fs.existsSync(path.join(source,'paid-bundle.json')))fs.copyFileSync(path.join(source,'paid-bundle.json'),path.join(target,'paid-bundle.json'));
CHECKPAID
  cp -R "$HERE/../docs/project-hub/templates" "$RUNTIME/docs/project-hub/"
  # Embed the Keychain/continuous-clock bridge so recipients need no Swift compiler.
  swiftc "${SWIFT_ARGS[@]}" -o "$RUNTIME/hub/lib/license/mac-native" "$HERE/lib/license/mac-native.swift"
  for item in README.md README.zh-TW.md LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_NOTICES.zh-TW.md; do
    cp "$HERE/../$item" "$RUNTIME/"
  done
  for item in README.md CHANGELOG.md seed; do
    cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  if [ -n "$PACK" ]; then
    mkdir -p "$RUNTIME/langpacks/$HUB_LANG"
    node - "$PACK" "$RUNTIME/langpacks/$HUB_LANG" <<'NODEPACK'
const fs = require('node:fs'), path = require('node:path');
const [source, destination] = process.argv.slice(2);
const files = new Set(['pack.json', 'ui.json', 'backend.json', 'native.json', 'README.md']);
function copy(directory, parts = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const next = [...parts, entry.name], file = path.join(directory, entry.name);
    if (entry.isDirectory() && (parts.length || ['docs', 'templates', 'seed'].includes(entry.name))) copy(file, next);
    else if (entry.isFile() && (next.length === 1 ? files.has(entry.name) : /(?:\.(?:json|md|yaml|yml|txt)|^\.gitkeep)$/.test(entry.name))) {
      const target = path.join(destination, ...next);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, fs.readFileSync(file), { mode: 0o644 });
    }
  }
}
copy(source);
NODEPACK
    APP_PACK="@bundle/runtime/langpacks/$HUB_LANG"
  fi
  HUB_LOCATION="@bundle/runtime/hub"
  # Recipient workspace/guard are provided at launch, not copied from CI.
  APP_ROOT=""
  APP_GUARD=""
fi

# 起動設定をXMLとしてエスケープして保存する（パスの & や引用符を保持）。
node - "$HERE/package.json" "$APP/Contents/Info.plist" "$EXEC" "$HUB_LOCATION" "${HUB_PORT:-4545}" "$APP_ROOT" "$APP_GUARD" "$HUB_LANG" "$HERE/app/window.swift" "$APP_PACK" "$PACK" <<'NODE'
const fs = require('fs');
const [pkg, file, executable, hub, port, root, guard, language, shell, packDir, sourcePack] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync(pkg)).version;
const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const native = language !== 'ja' ? JSON.parse(fs.readFileSync(require('path').join(sourcePack, 'native.json'))) : {};
const tr = ja => native[ja] || ja;
const values = {
 CFBundleName:'Project Hub', CFBundleDisplayName:'Project Hub', CFBundleIdentifier:'local.projecthub',
 CFBundleVersion:version, CFBundleShortVersionString:version, CFBundleDevelopmentRegion:language,
 CFBundlePackageType:'APPL', CFBundleExecutable:executable, CFBundleIconFile:'AppIcon', LSMinimumSystemVersion:'12.0',
 NSDocumentsFolderUsageDescription:tr('書類フォルダにあるプロジェクトの台帳と本体を読み書きするために使います。'),
 NSDesktopFolderUsageDescription:tr('デスクトップにある資料を開くために使います。'),
 NSAppleEventsUsageDescription:tr('Finder に、フォルダやファイルの場所を開いてもらうために使います。'),
 NSDownloadsFolderUsageDescription:tr('ダウンロードフォルダにある資料を開くために使います。'),
 NSMicrophoneUsageDescription:tr('音声入力ボタンを押した時に、話した内容を入力欄へ入れるためにマイクを使います。'),
 NSSpeechRecognitionUsageDescription:tr('話した内容を日本語の文字にします。音声はAppleなどの音声認識サービスで処理される場合があります。'),
 HubShellHash:require('crypto').createHash('sha256').update(fs.readFileSync(shell)).digest('hex'),
 HubDir:hub, HubPort:port, HubRoot:root, HubStorageGuard:guard, HubLanguage:language, HubLangpackDir:packDir
};
fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' + Object.entries(values).map(([k,v]) => '<key>'+k+'</key><string>'+xml(v)+'</string>').join('\n') + '\n<key>CFBundleLocalizations</key><array><string>ja</string>' + (language !== 'ja' ? '<string>'+xml(language)+'</string>' : '') + '</array>\n<key>NSHighResolutionCapable</key><true/>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict></plist>\n');
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
