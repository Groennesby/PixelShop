# Maintainer: Dave Groennesby <dave.groennesby@hotmail.com>
pkgname=pixelshop
pkgver=13.0.0
pkgrel=1
pkgdesc="High-Speed Studio Retouching, Frequency Separation & Smart Matting Suite (Fuse Coding)"
arch=('any')
url="https://collabs-photography.com/software"
license=('MIT')
depends=('python' 'tk' 'python-pillow')
optdepends=('chromium: Standalone native app window mode')
source=("pixelshop-${pkgver}.tar.gz::https://github.com/Groennesby/PixelShop/archive/refs/heads/main.tar.gz")
sha256sums=('SKIP')

package() {
  cd "$srcdir/PixelShop-main"
  install -dm755 "$pkgdir/opt/pixelshop"
  cp -r src/* "$pkgdir/opt/pixelshop/"
  chmod 0755 "$pkgdir/opt/pixelshop/launcher.py"

  install -dm755 "$pkgdir/usr/bin"
  cat > "$pkgdir/usr/bin/pixelshop" << 'EOF'
#!/usr/bin/env bash
exec python3 /opt/pixelshop/launcher.py "$@"
EOF
  chmod 0755 "$pkgdir/usr/bin/pixelshop"

  install -Dm644 icon.png "$pkgdir/usr/share/pixmaps/pixelshop.png"
  install -dm755 "$pkgdir/usr/share/applications"
  cat > "$pkgdir/usr/share/applications/pixelshop.desktop" << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=PixelShop
Comment=High-Speed Studio Retouching & Frequency Separation Suite
Exec=/usr/bin/pixelshop %F
Icon=pixelshop
Terminal=false
Categories=Graphics;Photography;2DGraphics;RasterGraphics;
EOF
}
