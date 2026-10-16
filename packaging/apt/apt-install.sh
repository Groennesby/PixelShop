#!/usr/bin/env bash
# One-liner APT Installer for Debian / Ubuntu / Linux Mint / Pop!_OS
set -e
TMP_DEB="/tmp/pixelshop_13.0.0_all.deb"
echo "Downloading PixelShop APT package..."
curl -fsSL "https://raw.githubusercontent.com/Groennesby/PixelShop/main/packaging/apt/pixelshop_13.0.0_all.deb" -o "$TMP_DEB"
sudo apt-get update -y
sudo apt-get install -y "$TMP_DEB"
rm -f "$TMP_DEB"
echo "PixelShop installed via APT! Run 'pixelshop' or launch from Applications."
