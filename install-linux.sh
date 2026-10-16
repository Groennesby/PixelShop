#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/pixelshop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"

echo "Installing PixelShop Studio Edition (Linux)..."
mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$DESKTOP_DIR"

if [ -d "$SCRIPT_DIR/PixelShop-Linux-x64" ]; then
    cp -r "$SCRIPT_DIR/PixelShop-Linux-x64/"* "$INSTALL_DIR/"
elif [ -d "$SCRIPT_DIR/../src" ]; then
    cp -r "$SCRIPT_DIR/../src/"* "$INSTALL_DIR/"
else
    cp -r "$SCRIPT_DIR/"* "$INSTALL_DIR/"
fi

chmod +x "$INSTALL_DIR/pixelshop" 2>/dev/null || true
chmod +x "$INSTALL_DIR/launcher.py" 2>/dev/null || true

cat > "$BIN_DIR/pixelshop" << 'EOF'
#!/usr/bin/env bash
INSTALL_DIR="$HOME/.local/share/pixelshop"
if [ -x "$INSTALL_DIR/pixelshop" ]; then
    exec "$INSTALL_DIR/pixelshop" --no-sandbox "$@"
else
    exec python3 "$INSTALL_DIR/launcher.py" "$@"
fi
EOF
chmod +x "$BIN_DIR/pixelshop"

cat > "$DESKTOP_DIR/pixelshop.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=PixelShop
Comment=High-Speed Studio Retouching & Frequency Separation Suite
Exec=$BIN_DIR/pixelshop
Icon=$INSTALL_DIR/icon.png
Terminal=false
Categories=Graphics;Photography;2DGraphics;RasterGraphics;
StartupWMClass=pixelshop
EOF
chmod +x "$DESKTOP_DIR/pixelshop.desktop"

echo "PixelShop installed successfully! Launch via 'pixelshop' or from your Applications menu."
