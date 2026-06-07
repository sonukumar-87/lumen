#!/bin/zsh
# Lumen installer — strips macOS quarantine so the app opens without "damaged" error.
# Run with: chmod +x install.sh && ./install.sh

echo "Installing Lumen..."

# Find the DMG on Desktop
DMG=$(ls ~/Desktop/Lumen-*.dmg 2>/dev/null | sort -V | tail -1)

if [ -z "$DMG" ]; then
  echo "ERROR: No Lumen DMG found on Desktop. Download it first."
  exit 1
fi

echo "Found: $DMG"

# Strip quarantine from the DMG itself first
xattr -dr com.apple.quarantine "$DMG"

# Mount silently
MOUNT_OUTPUT=$(hdiutil attach "$DMG" -nobrowse -noautoopen 2>/dev/null)
MOUNT=$(echo "$MOUNT_OUTPUT" | grep Volumes | awk '{print $NF}')

if [ -z "$MOUNT" ]; then
  echo "ERROR: Could not mount DMG."
  exit 1
fi

echo "Mounted at: $MOUNT"

# Copy to Applications (overwrite existing)
cp -R "$MOUNT/Lumen.app" /Applications/Lumen.app

# Unmount
hdiutil detach "$MOUNT" -quiet 2>/dev/null

# Strip quarantine from the installed app
xattr -dr com.apple.quarantine /Applications/Lumen.app

echo ""
echo "✓ Lumen installed and quarantine removed!"
echo "  Launch it from Applications or Spotlight."
