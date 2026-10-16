#!/usr/bin/env bash
# Universal One-Command Installer for PixelShop (Linux, macOS, Windows Git-Bash/WSL)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS_NAME="$(uname -s)"

case "$OS_NAME" in
    Linux*)
        bash "$SCRIPT_DIR/install-linux.sh"
        ;;
    Darwin*)
        bash "$SCRIPT_DIR/install-macos.sh"
        ;;
    CYGWIN*|MINGW*|MSYS*)
        cmd.exe /c "$SCRIPT_DIR\\install-windows.bat"
        ;;
    *)
        echo "Detected OS: $OS_NAME — launching portable Python/Electron runner..."
        python3 "$SCRIPT_DIR/src/launcher.py"
        ;;
esac
