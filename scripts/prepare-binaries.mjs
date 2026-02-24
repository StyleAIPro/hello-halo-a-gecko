#!/usr/bin/env node

/**
 * Auto-detect and download missing binary dependencies
 *
 * Usage:
 *   node scripts/prepare-binaries.mjs                    # Auto-detect current platform
 *   node scripts/prepare-binaries.mjs --platform all     # Download for all platforms
 *   node scripts/prepare-binaries.mjs --platform mac-arm64
 *
 * This script checks for missing binaries and downloads them automatically.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ANSI colors
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
}

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`)
}

// Cloudflared download URLs
const CLOUDFLARED_URLS = {
  'mac-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
  'mac-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'win': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'linux': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
}

// Cloudflared output paths
const CLOUDFLARED_PATHS = {
  'mac-arm64': 'node_modules/cloudflared/bin/cloudflared',
  'mac-x64': 'node_modules/cloudflared/bin/cloudflared-darwin-x64',
  'win': 'node_modules/cloudflared/bin/cloudflared.exe',
  'linux': 'node_modules/cloudflared/bin/cloudflared-linux-x64'
}

// @parcel/watcher packages per platform
const WATCHER_PACKAGES = {
  'mac-arm64': '@parcel/watcher-darwin-arm64',
  'mac-x64': '@parcel/watcher-darwin-x64',
  'win': '@parcel/watcher-win32-x64',
  'linux': '@parcel/watcher-linux-x64-glibc'
}

// better-sqlite3 prebuild configuration
// Prebuilds are platform-specific .node binaries downloaded from GitHub releases.
// They are stored in node_modules/better-sqlite3/prebuilds/{os}-{arch}/ and
// swapped into the packaged app by afterPack.cjs during electron-builder packaging.
const BETTER_SQLITE3_PREBUILDS_DIR = 'node_modules/better-sqlite3/prebuilds'
const BETTER_SQLITE3_PLATFORMS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  'win': { platform: 'win32', arch: 'x64' },
  'linux': { platform: 'linux', arch: 'x64' }
}

/**
 * Detect current platform
 */
function detectPlatform() {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  } else if (platform === 'win32') {
    return 'win'
  } else if (platform === 'linux') {
    return 'linux'
  }
  return null
}

/**
 * Check if cloudflared exists and is valid for platform
 */
function checkCloudflared(platform) {
  const filePath = path.join(PROJECT_ROOT, CLOUDFLARED_PATHS[platform])
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }

  // Basic size validation
  const stats = fs.statSync(filePath)
  const minSize = platform === 'win' ? 10 * 1024 * 1024 : 30 * 1024 * 1024
  return { exists: true, valid: stats.size > minSize, size: stats.size }
}

/**
 * Check if @parcel/watcher exists for platform
 */
function checkWatcher(platform) {
  const dirPath = path.join(PROJECT_ROOT, 'node_modules', WATCHER_PACKAGES[platform])
  if (!fs.existsSync(dirPath)) {
    return { exists: false }
  }

  try {
    const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
    const hasNodeFile = files.some(f => f.endsWith('.node'))
    return { exists: true, valid: hasNodeFile }
  } catch {
    return { exists: true, valid: false }
  }
}

/**
 * Download cloudflared for platform
 */
function downloadCloudflared(platform) {
  const url = CLOUDFLARED_URLS[platform]
  const outputPath = path.join(PROJECT_ROOT, CLOUDFLARED_PATHS[platform])
  const outputDir = path.dirname(outputPath)

  log.info(`Downloading cloudflared for ${platform}...`)

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Remove existing file
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
  }

  if (url.endsWith('.tgz')) {
    // Mac: download and extract tgz
    const tgzPath = outputPath + '.tgz'
    curlDownload(url, tgzPath)
    execSync(`tar -xzf "${tgzPath}" -C "${outputDir}"`, { stdio: 'pipe' })

    // Rename extracted file if needed (for mac-x64)
    const extractedPath = path.join(outputDir, 'cloudflared')
    if (platform === 'mac-x64' && fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, outputPath)
    }

    fs.unlinkSync(tgzPath)
    fs.chmodSync(outputPath, 0o755)
  } else if (url.endsWith('.exe')) {
    // Windows: direct download
    curlDownload(url, outputPath)
  } else {
    // Linux: direct download
    curlDownload(url, outputPath)
    fs.chmodSync(outputPath, 0o755)
  }

  log.success(`Downloaded cloudflared for ${platform}`)
}

/**
 * Get the installed @parcel/watcher version to match platform-specific packages
 */
function getWatcherVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'node_modules', '@parcel', 'watcher', 'package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
}

/**
 * Download a file with curl, retrying without proxy on failure
 */
function curlDownload(url, dest) {
  try {
    execSync(`curl -fsSL -o "${dest}" "${url}"`, { stdio: 'pipe' })
  } catch {
    log.warn('Download failed, retrying without proxy...')
    execSync(`curl -fsSL --noproxy '*' -o "${dest}" "${url}"`, { stdio: 'pipe' })
  }
}

/**
 * Get better-sqlite3 version and Electron ABI for constructing prebuild download URLs.
 *
 * Reads installed package versions and uses node-abi to map the Electron version
 * to the correct native module ABI number. This ABI is embedded in the prebuild
 * tarball filename on GitHub releases.
 */
function getBetterSqlite3Info() {
  const bsPkg = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8'
  ))
  const electronPkg = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'node_modules/electron/package.json'), 'utf8'
  ))
  const abi = execSync(
    `node -e "console.log(require('node-abi').getAbi('${electronPkg.version}', 'electron'))"`,
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  ).trim()

  return { version: bsPkg.version, electronVersion: electronPkg.version, abi }
}

/**
 * Check if better-sqlite3 prebuild exists and is valid for platform
 */
function checkBetterSqlite3(platform) {
  const { platform: os, arch } = BETTER_SQLITE3_PLATFORMS[platform]
  const prebuildPath = path.join(
    PROJECT_ROOT, BETTER_SQLITE3_PREBUILDS_DIR, `${os}-${arch}`, 'better_sqlite3.node'
  )
  if (!fs.existsSync(prebuildPath)) {
    return { exists: false }
  }
  const stats = fs.statSync(prebuildPath)
  // Compiled .node binary should be > 500 KB
  return { exists: true, valid: stats.size > 500 * 1024, size: stats.size }
}

/**
 * Download better-sqlite3 prebuild for a target platform.
 *
 * Downloads the prebuilt .node binary from better-sqlite3 GitHub releases.
 * The tarball naming convention is:
 *   better-sqlite3-v{version}-electron-v{abi}-{platform}-{arch}.tar.gz
 *
 * The tarball contains: build/Release/better_sqlite3.node
 * We extract it to: node_modules/better-sqlite3/prebuilds/{platform}-{arch}/
 */
function downloadBetterSqlite3(platform) {
  const { platform: targetPlatform, arch: targetArch } = BETTER_SQLITE3_PLATFORMS[platform]
  const { version, abi } = getBetterSqlite3Info()
  const prebuildDir = path.join(PROJECT_ROOT, BETTER_SQLITE3_PREBUILDS_DIR, `${targetPlatform}-${targetArch}`)
  const outputPath = path.join(prebuildDir, 'better_sqlite3.node')

  const tarballName = `better-sqlite3-v${version}-electron-v${abi}-${targetPlatform}-${targetArch}.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${tarballName}`
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-${targetPlatform}-${targetArch}.tgz`)

  log.info(`Downloading better-sqlite3 prebuild for ${platform}...`)

  fs.mkdirSync(prebuildDir, { recursive: true })

  try {
    curlDownload(url, tmpTgz)

    // Extract .node file from tarball (contains build/Release/better_sqlite3.node)
    const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-extract-${targetPlatform}-${targetArch}`)
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
    fs.mkdirSync(tmpExtract, { recursive: true })
    execSync(`tar -xzf "${tmpTgz}" -C "${tmpExtract}"`, { stdio: 'pipe' })

    const extractedNode = path.join(tmpExtract, 'build', 'Release', 'better_sqlite3.node')
    if (!fs.existsSync(extractedNode)) {
      throw new Error('Tarball does not contain build/Release/better_sqlite3.node')
    }

    fs.copyFileSync(extractedNode, outputPath)

    // Cleanup temp files
    fs.unlinkSync(tmpTgz)
    fs.rmSync(tmpExtract, { recursive: true })

    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)
    log.success(`Downloaded better-sqlite3 prebuild for ${platform} (${sizeMB} MB)`)
  } catch (err) {
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    const tmpExtractCleanup = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-extract-${targetPlatform}-${targetArch}`)
    if (fs.existsSync(tmpExtractCleanup)) fs.rmSync(tmpExtractCleanup, { recursive: true })
    log.error(`Failed to download better-sqlite3 prebuild for ${platform}: ${err.message}`)
    throw err
  }
}

/**
 * Install @parcel/watcher for platform
 * Downloads tarball directly from npm registry to bypass platform compatibility checks
 */
function installWatcher(platform) {
  const pkg = WATCHER_PACKAGES[platform]
  const pkgName = pkg.replace('@parcel/', '')
  const version = getWatcherVersion()
  const registry = execSync('npm config get registry', { encoding: 'utf8' }).trim()
  const tarballUrl = `${registry}/@parcel/${pkgName}/-/${pkgName}-${version}.tgz`
  const destDir = path.join(PROJECT_ROOT, 'node_modules', pkg)
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.${pkgName}.tgz`)

  log.info(`Installing ${pkg}@${version} from registry...`)

  try {
    // Clean up destination
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.mkdirSync(destDir, { recursive: true })

    // Download tarball and extract (--strip-components=1 removes the "package/" prefix)
    curlDownload(tarballUrl, tmpTgz)
    execSync(`tar -xzf "${tmpTgz}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' })
    fs.unlinkSync(tmpTgz)

    // Verify .node file exists
    const files = fs.readdirSync(destDir, { recursive: true }).map(String)
    if (!files.some(f => f.endsWith('.node'))) {
      throw new Error(`No .node binary found in downloaded ${pkg}`)
    }

    log.success(`Installed ${pkg}@${version}`)
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    log.error(`Failed to install ${pkg}: ${err.message}`)
    throw err
  }
}

/**
 * Prepare all binaries for a platform
 */
function preparePlatform(platform) {
  console.log(`\n=== Preparing binaries for ${platform} ===\n`)

  // Check and download cloudflared
  const cfStatus = checkCloudflared(platform)
  if (!cfStatus.exists || !cfStatus.valid) {
    downloadCloudflared(platform)
  } else {
    log.success(`cloudflared already exists for ${platform}`)
  }

  // Check and install @parcel/watcher
  const watcherStatus = checkWatcher(platform)
  if (!watcherStatus.exists || !watcherStatus.valid) {
    installWatcher(platform)
  } else {
    log.success(`@parcel/watcher already exists for ${platform}`)
  }

  // Check and download better-sqlite3 prebuild
  const sqliteStatus = checkBetterSqlite3(platform)
  if (!sqliteStatus.exists || !sqliteStatus.valid) {
    downloadBetterSqlite3(platform)
  } else {
    log.success(`better-sqlite3 prebuild already exists for ${platform}`)
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2)
  let platform = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1]
    }
  }

  return { platform }
}

/**
 * Main entry point
 */
async function main() {
  const { platform: targetPlatform } = parseArgs()
  const validPlatforms = ['mac-arm64', 'mac-x64', 'win', 'linux', 'all']

  let platforms = []

  if (targetPlatform === 'all') {
    platforms = ['mac-arm64', 'mac-x64', 'win', 'linux']
  } else if (targetPlatform) {
    if (!validPlatforms.includes(targetPlatform)) {
      log.error(`Invalid platform: ${targetPlatform}`)
      console.log(`Valid platforms: ${validPlatforms.join(', ')}`)
      process.exit(1)
    }
    platforms = [targetPlatform]
  } else {
    // Auto-detect current platform
    const detected = detectPlatform()
    if (!detected) {
      log.error('Could not detect current platform')
      process.exit(1)
    }
    log.info(`Auto-detected platform: ${detected}`)
    platforms = [detected]
  }

  for (const platform of platforms) {
    preparePlatform(platform)
  }

  console.log('\n' + colors.green + '✅ All binaries prepared successfully!' + colors.reset)
}

main().catch(err => {
  log.error(err.message)
  process.exit(1)
})
