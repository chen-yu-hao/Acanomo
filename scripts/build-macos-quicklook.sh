#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "AcaNomo Quick Look extension can only be built on macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_SRC_DIR="$ROOT_DIR/src-tauri/macos/NomoQuickLookPreview"
RENDERER_DIR="$ROOT_DIR/src-tauri/target/quicklook-renderer"
OUTPUT_DIR="$ROOT_DIR/src-tauri/target/quicklook/NomoQuickLookPreview.appex"
CONTENTS_DIR="$OUTPUT_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

PNPM_BIN="${PNPM_BIN:-pnpm}"

report_build_failure() {
  local label="$1"
  local log_file="$2"
  local summary
  summary="$(tail -n 40 "$log_file" | tr '\r\n' ' ')"
  echo "::error title=$label::$summary"
}

cd "$ROOT_DIR"
RENDERER_LOG="$(mktemp)"
set +e
"$PNPM_BIN" run build:quicklook-renderer 2>&1 | tee "$RENDERER_LOG"
RENDERER_STATUS="${PIPESTATUS[0]}"
set -e
if [[ "$RENDERER_STATUS" != "0" ]]; then
  report_build_failure "Build Quick Look renderer" "$RENDERER_LOG"
  exit "$RENDERER_STATUS"
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$EXTENSION_SRC_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
cp -R "$RENDERER_DIR" "$RESOURCES_DIR/quicklook-renderer"

APP_VERSION="$(node -p "require('./package.json').version")"
APP_BUNDLE_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').bundle.macOS.bundleVersion || require('./src-tauri/tauri.conf.json').version")"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$CONTENTS_DIR/Info.plist"
# 扩展构建版本必须与主 App 的 CFBundleVersion 一致，覆盖同一营销版本时也让 PlugInKit 刷新扩展。
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_BUNDLE_VERSION" "$CONTENTS_DIR/Info.plist"

ARCH="${QUICKLOOK_ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64)
    SWIFT_TARGET_ARCH="arm64"
    ;;
  x86_64|amd64)
    SWIFT_TARGET_ARCH="x86_64"
    ;;
  *)
    echo "Unsupported Quick Look architecture: $ARCH" >&2
    exit 1
    ;;
esac

# Xcode 的 App Extension target 会自动把入口设为 _NSExtensionMain；
# 直接调用 swiftc 时必须显式设置，否则生成的进程会启动后立即退出，导致 PlugInKit XPC Code=4097。
ENTITLEMENTS="$EXTENSION_SRC_DIR/NomoQuickLookPreview.entitlements"
# Tauri 使用 APPLE_SIGNING_IDENTITY；保留旧变量作为显式扩展签名覆盖，并确保嵌套扩展与主 App 同身份。
CODESIGN_IDENTITY="${APPLE_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:--}}"
# Keep the hand-built extension on the Swift 5 language mode. The Quick Look
# protocol is imported from an SDK whose concurrency annotations vary between
# Xcode releases; Swift 6 otherwise turns the existing actor-isolation
# compatibility warning into a hard error before the app can be bundled.
SWIFTC_LOG="$(mktemp)"
set +e
xcrun swiftc \
  "$EXTENSION_SRC_DIR/PreviewViewController.swift" \
  -emit-executable \
  -parse-as-library \
  -swift-version 5 \
  -module-name NomoQuickLookPreview \
  -application-extension \
  -target "${SWIFT_TARGET_ARCH}-apple-macosx12.0" \
  -Xlinker -e \
  -Xlinker _NSExtensionMain \
  -Xlinker -rpath \
  -Xlinker @executable_path/../Frameworks \
  -Xlinker -rpath \
  -Xlinker @executable_path/../../../../Frameworks \
  -o "$MACOS_DIR/NomoQuickLookPreview" \
  -framework Cocoa \
  -framework QuickLook \
  -framework QuickLookUI \
  -framework WebKit >"$SWIFTC_LOG" 2>&1
SWIFTC_STATUS="$?"
set -e
if [[ "$SWIFTC_STATUS" != "0" ]]; then
  cat "$SWIFTC_LOG" >&2
  report_build_failure "Compile Quick Look extension" "$SWIFTC_LOG"
  exit "$SWIFTC_STATUS"
fi

/usr/bin/codesign \
  --force \
  --sign "$CODESIGN_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$OUTPUT_DIR"

echo "Built $OUTPUT_DIR"
