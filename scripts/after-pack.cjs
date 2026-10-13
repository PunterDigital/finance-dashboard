// electron-builder afterPack hook: ad-hoc sign the macOS app before it is packed into the DMG.
// electron-builder can't ad-hoc sign itself (it treats identity '-' as a keychain name and skips),
// and an app whose signature seal is broken won't open on Apple Silicon.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
