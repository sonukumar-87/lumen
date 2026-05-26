#!/usr/bin/env bash
# Lumen — one-shot macOS setup.
# Handles a well-known Electron postinstall flake: sometimes npm reports
# success but only extracts LICENSES.chromium.html into dist/. We detect
# that and download the binary directly from GitHub instead.
#
# Run from inside the lumen/ folder:   bash setup.sh

set -euo pipefail

bold()   { printf "\033[1m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }

# 0. Are we in the right place?
if [ ! -f "package.json" ] || [ ! -f "main.js" ]; then
  red "This script must be run from inside the lumen/ folder."
  echo "Try:  cd ~/Downloads/lumen && bash setup.sh"
  exit 1
fi

# 1. Check Node.js
bold "→ Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed."
  echo ""
  echo "Install one of these ways and re-run:"
  echo "  • Easiest:   download the LTS installer from https://nodejs.org"
  echo "  • Homebrew:  brew install node"
  exit 1
fi
green "  Node $(node -v), npm $(npm -v)"

# 2. npm install
bold "→ Installing dependencies"
npm install --no-audit --no-fund

# 3. Verify Electron binary, repair if missing
DIST="node_modules/electron/dist"
EXPECTED_BIN="$DIST/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$EXPECTED_BIN" ]; then
  yellow "  Electron's binary didn't extract correctly (known npm flake)."
  bold "→ Downloading Electron directly from GitHub release"

  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then PLATFORM=darwin-arm64
  else PLATFORM=darwin-x64; fi

  VERSION=$(node -p "require('./node_modules/electron/package.json').version")
  URL="https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-${PLATFORM}.zip"

  echo "  Electron $VERSION for $PLATFORM"

  (
    cd node_modules/electron
    rm -rf dist
    curl -fL --progress-bar -o electron.zip "$URL"
    unzip -q electron.zip -d dist
    rm electron.zip
  )
fi

# 4. Always rewrite path.txt with printf (no trailing newline — echo would
#    add one and Electron's index.js doesn't trim it, breaking the spawn).
printf "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt

# 5. Final verification
if [ ! -x "$EXPECTED_BIN" ]; then
  red "Electron binary still missing at:"
  echo "  $EXPECTED_BIN"
  echo "Something's blocking the GitHub download. Check your network / VPN / proxy."
  exit 1
fi

echo ""
green "✅ Lumen is ready."
echo ""
bold "Start it with:"
echo ""
echo "  npm start"
echo ""
