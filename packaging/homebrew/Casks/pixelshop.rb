cask "pixelshop" do
  version "13.0.0"
  sha256 :no_check

  url "https://github.com/Groennesby/PixelShop/archive/refs/heads/main.tar.gz"
  name "PixelShop"
  desc "As a lifelong Linux fan, there was always one dealbreaker: no real Photoshop. GIMP just wasn't it. So I'm fixing it myself."
  homepage "https://collabs-photography.com/software"

  caveats <<~EOS
    As a lifelong Linux fan, there was always one dealbreaker: no real Photoshop. GIMP just wasn't it.
    So I'm fixing it myself. For all designers who want to finally go 100% Linux and leave Microsoft's hidden controls and endless lock-in behind.
    This is the end of that era.

    Designed by Dave Groennesby  •  Fuse Coding  •  Made in Belgium
    https://collabs-photography.com/software  •  dave.groennesby@hotmail.com
  EOS
end
