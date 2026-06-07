// afterPack hook — ad-hoc codesign the .app so macOS doesn't show "damaged"
// This runs after electron-builder packages the app but before making the DMG.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] Ad-hoc signing: ${appPath}`);

  try {
    // --force replaces any existing broken signature
    // --deep signs all nested frameworks/helpers
    // "-" means ad-hoc (no certificate needed)
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    
    // Verify
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
    console.log('[afterPack] Codesign verified OK');
  } catch (e) {
    console.error('[afterPack] Codesign failed:', e.message);
    // Don't fail the build — the app will still work with xattr workaround
  }
};
