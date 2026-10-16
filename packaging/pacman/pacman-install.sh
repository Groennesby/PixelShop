#!/usr/bin/env bash
# Arch Linux / Manjaro / Pacman Installer for PixelShop
set -e
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
echo "Building and installing PixelShop via makepkg / pacman..."
curl -fsSL "https://raw.githubusercontent.com/Groennesby/PixelShop/main/packaging/pacman/PKGBUILD" -o "$BUILD_DIR/PKGBUILD"
cd "$BUILD_DIR"
makepkg -si --noconfirm
echo "PixelShop installed via Pacman!"
