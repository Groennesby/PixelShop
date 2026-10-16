class Pixelshop < Formula
  desc "As a lifelong Linux fan, there was always one dealbreaker: no real Photoshop. GIMP just wasn't it. So I'm fixing it myself."
  homepage "https://collabs-photography.com/software"
  url "https://github.com/Groennesby/PixelShop/archive/refs/heads/main.tar.gz"
  version "13.0.0"
  license "MIT"

  depends_on "python@3.11"

  def install
    libexec.install Dir["src/*"]
    chmod 0755, libexec/"launcher.py"
    (bin/"pixelshop").write <<~EOS
      #!/usr/bin/env bash
      exec "#{Formula["python@3.11"].opt_bin}/python3" "#{libexec}/launcher.py" "$@"
    EOS
    chmod 0755, bin/"pixelshop"
  end

  def caveats
    <<~EOS
      As a lifelong Linux fan, there was always one dealbreaker: no real Photoshop. GIMP just wasn't it.
      So I'm fixing it myself. For all designers who want to finally go 100% Linux and leave Microsoft's hidden controls and endless lock-in behind.
      This is the end of that era.

      Designed by Dave Groennesby  •  Fuse Coding  •  Made in Belgium
      https://collabs-photography.com/software  •  dave.groennesby@hotmail.com
    EOS
  end

  test do
    assert_predicate bin/"pixelshop", :exist?
  end
end
