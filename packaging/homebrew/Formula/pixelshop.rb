class Pixelshop < Formula
  desc "High-Speed Studio Retouching, Frequency Separation & Smart Matting Suite"
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

  test do
    assert_predicate bin/"pixelshop", :exist?
  end
end
