#!/bin/zsh
# Lumen installer — strips macOS quarantine and applies ad-hoc signature.
# Run with: chmod +x install.sh && ./install.sh

echo "Installing Lumen..."

# Find the DMG on Desktop
DMG=$(ls ~/Desktop/Lumen-*.dmg 2>/dev/null | sort -V | tail -1)

if [ -z "$DMG" ]; then
  echo "ERROR: No Lumen DMG found on Desktop. Download it first."
  exit 1
fi

echo "Found: $DMG"

# Strip quarantine from DMG
xattr -dr com.apple.quarantine "$DMG" 2>/dev/null

# Mount silently
MOUNT_OUTPUT=$(hdiutil attach "$DMG" -nobrowse -noautoopen 2>/dev/null)
MOUNT=$(echo "$MOUNT_OUTPUT" | grep Volumes | awk '{print $NF}')

if [ -z "$MOUNT" ]; then
  echo "ERROR: Could not mount DMG."
  exit 1
fi

echo "Mounted at: $MOUNT"

# Copy to Applications
rm -rf /Applications/Lumen.app
cp -R "$MOUNT/Lumen.app" /Applications/Lumen.app

# Unmount
hdiutil detach "$MOUNT" -quiet 2>/dev/null

# Apply ad-hoc signature (fixes "damaged" without Apple Developer cert)
codesign --sign - --force --deep /Applications/Lumen.app 2>/dev/null

# Strip quarantine from installed app
xattr -dr com.apple.quarantine /Applications/Lumen.app 2>/dev/null

echo ""
echo "✓ Lumen installed successfully!"
echo "  Launch it from Applications or Spotlight (⌘Space → Lumen)."
echo "  First launch: right-click → Open if macOS asks for confirmation."
