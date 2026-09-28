cask "nomo" do
  version "0.5.9"
  sha256 "002d4042ca95313a7bd11463cd1aae963bd78c1008e93da006b18ea26225c620"

  url "https://github.com/chen-yu-hao/Acanomo/releases/download/v#{version}/AcaNomo_#{version}_aarch64.dmg"
  name "AcaNomo"
  desc "Local-first Markdown desktop editor"
  homepage "https://github.com/chen-yu-hao/Acanomo"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :monterey

  app "AcaNomo.app"

  zap trash: [
    "~/Library/Application Support/com.nomo.desktop",
    "~/Library/Caches/com.nomo.desktop",
    "~/Library/Logs/com.nomo.desktop",
    "~/Library/Preferences/com.nomo.desktop.plist",
    "~/Library/WebKit/com.nomo.desktop",
  ]
end
