// ============================================================================
// afterPack hook - Post-packaging cleanup, native binary swap, and signing
//
// Runs after electron-builder creates the unpacked app directory.
//
// 1. Remove non-target @parcel/watcher platform packages from the unpacked
//    output. All 4 platform packages exist in node_modules (so every build
//    sees a complete set), but only the target platform's package is needed
//    at runtime. Cleaning here avoids mutating the shared node_modules.
//
// 2. Swap better-sqlite3 .node binary with the correct platform-specific
//    prebuild. The host-compiled binary (darwin-arm64 on M4 Mac) is replaced
//    with the prebuild matching the target platform. Prebuilds are downloaded
//    by prepare-binaries.mjs and stored in node_modules/better-sqlite3/prebuilds/.
//
// 3. macOS ad-hoc signing (prevents "damaged app" prompts on unsigned builds).
// ============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// Maps platform-arch to the @parcel/watcher package name to KEEP.
// Everything else under @parcel/watcher-* gets removed.
const WATCHER_TARGETS = {
  'darwin-arm64': 'watcher-darwin-arm64',
  'darwin-x64':   'watcher-darwin-x64',
  'win32-x64':    'watcher-win32-x64',
  'linux-x64':    'watcher-linux-x64-glibc',
};

/**
 * Resolve the app.asar.unpacked directory from electron-builder context.
 *
 * macOS:       <appOutDir>/<ProductName>.app/Contents/Resources/app.asar.unpacked
 * win32/linux: <appOutDir>/resources/app.asar.unpacked
 */
function getUnpackedDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar.unpacked');
  }
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
}

/**
 * Remove non-target @parcel/watcher-* packages from the unpacked output.
 */
function cleanNonTargetWatchers(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const targetPkg = WATCHER_TARGETS[key];

  if (!targetPkg) {
    console.warn(`[afterPack] No watcher mapping for ${key}, skipping cleanup`);
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  const parcelDir = path.join(unpackedDir, 'node_modules', '@parcel');

  if (!fs.existsSync(parcelDir)) {
    console.log(`[afterPack] No @parcel dir in unpacked output, skipping cleanup`);
    return;
  }

  const entries = fs.readdirSync(parcelDir, { withFileTypes: true });
  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('watcher-')) continue;
    if (entry.name === targetPkg) continue;

    const fullPath = path.join(parcelDir, entry.name);
    fs.rmSync(fullPath, { recursive: true });
    removed.push(entry.name);
  }

  if (removed.length > 0) {
    console.log(`[afterPack] ${key}: removed ${removed.length} non-target watcher(s): ${removed.join(', ')}`);
  }
  console.log(`[afterPack] ${key}: keeping @parcel/${targetPkg}`);
}

/**
 * Swap better-sqlite3 .node binary with the correct platform-specific prebuild.
 *
 * The binary in the unpacked output is whatever was in node_modules at pack time
 * (the host platform's binary, e.g. darwin-arm64 when building on M4 Mac).
 * This function replaces it with the prebuild matching the target platform.
 *
 * Prebuilds are stored at:
 *   {projectRoot}/node_modules/better-sqlite3/prebuilds/{platform}-{arch}/better_sqlite3.node
 *
 * Target location in unpacked output:
 *   app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
 */
function swapBetterSqlite3Binary(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;

  const projectRoot = path.resolve(__dirname, '..');
  const prebuildSrc = path.join(
    projectRoot, 'node_modules/better-sqlite3/prebuilds', `${platform}-${archStr}`, 'better_sqlite3.node'
  );

  if (!fs.existsSync(prebuildSrc)) {
    console.error(`[afterPack] Missing better-sqlite3 prebuild for ${key}: ${prebuildSrc}`);
    console.error(`[afterPack] Run "npm run prepare:all" to download prebuilds for all platforms`);
    throw new Error(`Missing better-sqlite3 prebuild for ${key}`);
  }

  const unpackedDir = getUnpackedDir(context);
  const targetNode = path.join(
    unpackedDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );

  if (!fs.existsSync(targetNode)) {
    console.error(`[afterPack] ${key}: better_sqlite3.node not found in unpacked output`);
    console.error(`[afterPack] Check that asarUnpack includes "node_modules/better-sqlite3/build/Release/*.node"`);
    throw new Error(`better_sqlite3.node not found in unpacked output for ${key}`);
  }

  fs.copyFileSync(prebuildSrc, targetNode);

  const sizeMB = (fs.statSync(targetNode).size / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] ${key}: swapped better-sqlite3 binary (${sizeMB} MB)`);
}

module.exports = async function(context) {
  // Clean non-target watcher packages from unpacked output
  cleanNonTargetWatchers(context);

  // Swap better-sqlite3 native binary for the target platform
  swapBetterSqlite3Binary(context);

  // macOS ad-hoc signing (other platforms skip)
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlementsPath = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');

  console.log(`[afterPack] Professional ad-hoc signing: ${appPath}`);

  try {
    // 1. Remove quarantine attribute (if exists)
    try {
      execSync(`xattr -dr com.apple.quarantine "${appPath}"`, { stdio: 'pipe' });
    } catch { }

    // 2. Ad-hoc sign with entitlements
    const codesignCmd = `codesign --force --deep -s - --entitlements "${entitlementsPath}" --timestamp=none "${appPath}"`;
    console.log(`[afterPack] Executing: ${codesignCmd}`);
    execSync(codesignCmd, { stdio: 'inherit' });

    // 3. Verify signature
    console.log('[afterPack] Verifying signature...');
    const verifyOutput = execSync(`codesign -dv "${appPath}" 2>&1`, { encoding: 'utf8' });
    console.log(verifyOutput);

    console.log('[afterPack] Ad-hoc signing complete');
  } catch (error) {
    console.error('[afterPack] Signing failed:', error.message);
    // Don't throw error, let build continue
  }
};
