cask "nomo" do
  version "0.5.10"
  sha256 "53f46f94bcce36df4d49ba7421d9cf16a5612d1492d81276df313fac015e2dbc"

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
