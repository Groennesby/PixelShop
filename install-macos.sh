#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DEST="/Applications/PixelShop.app"

echo "Installing PixelShop Studio Edition for macOS..."
if [ -d "$SCRIPT_DIR/PixelShop.app" ]; then
    rm -rf "$APP_DEST"
    cp -R "$SCRIPT_DIR/PixelShop.app" "$APP_DEST"
    xattr -cr "$APP_DEST" 2>/dev/null || true
    echo "PixelShop.app installed to /Applications/PixelShop.app"
elif [ -f "$SCRIPT_DIR/PixelShop-Mac-Installer.dmg" ]; then
    hdiutil attach "$SCRIPT_DIR/PixelShop-Mac-Installer.dmg"
    echo "Mounted PixelShop-Mac-Installer.dmg — drag PixelShop.app to /Applications"
else
    echo "Installing portable bundle to $HOME/Applications/PixelShop..."
    mkdir -p "$HOME/Applications/PixelShop"
    cp -R "$SCRIPT_DIR/"* "$HOME/Applications/PixelShop/"
fi
