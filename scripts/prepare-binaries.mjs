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
import https from 'node:https'
import http from 'node:http'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

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

// GitHub CLI (gh) binary configuration
// Binaries are stored in resources/gh/{platform}/ and bundled with the app
// via asarUnpack so they work at runtime without system installation.
const GH_PATHS = {
  'mac-arm64': 'resources/gh/mac-arm64/gh',
  'mac-x64': 'resources/gh/mac-x64/gh',
  'win': 'resources/gh/win-x64/gh.exe',
  'linux': 'resources/gh/linux-x64/gh'
}

// gh release asset name patterns (version placeholder: {version})
const GH_ASSET_NAMES = {
  'mac-arm64': 'gh_{version}_macOS_arm64.zip',
  'mac-x64': 'gh_{version}_macOS_amd64.zip',
  'win': 'gh_{version}_windows_amd64.zip',
  'linux': 'gh_{version}_linux_amd64.tar.gz'
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
async function downloadCloudflared(platform) {
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
    await httpsDownload(url, tgzPath)
    extractTgz(tgzPath, outputDir)

    // Rename extracted file if needed (for mac-x64)
    const extractedPath = path.join(outputDir, 'cloudflared')
    if (platform === 'mac-x64' && fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, outputPath)
    }

    fs.unlinkSync(tgzPath)
    fs.chmodSync(outputPath, 0o755)
  } else if (url.endsWith('.exe')) {
    // Windows: direct download
    await httpsDownload(url, outputPath)
  } else {
    // Linux: direct download
    await httpsDownload(url, outputPath)
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
 * Download a file using Node.js native https/http (cross-platform, no curl dependency)
 */
function httpsDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const destStream = fs.createWriteStream(dest)

    const request = (retryNoProxy = false) => {
      const req = protocol.get(url, retryNoProxy ? { rejectUnauthorized: false } : {}, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          destStream.close()
          fs.unlinkSync(dest)
          httpsDownload(res.headers.location, dest).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          destStream.close()
          fs.unlinkSync(dest)
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          return
        }
        res.pipe(destStream)
        destStream.on('finish', () => {
          destStream.close()
          resolve()
        })
      })

      req.on('error', (err) => {
        destStream.close()
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
        if (!retryNoProxy && err.message.includes('ENOTFOUND')) {
          log.warn('Download failed, retrying without proxy...')
          request(true)
        } else {
          reject(err)
        }
      })
    }

    request()
  })
}

/**
 * Extract a .tar.gz file using Node.js native zlib
 * Supports extracting specific files from the tarball
 */
function extractTgz(tgzPath, outputDir, stripComponents = 0) {
  const data = fs.readFileSync(tgzPath)
  const decompressed = zlib.gunzipSync(data)
  const entries = parseTar(decompressed)

  for (const entry of entries) {
    let name = entry.name
    // Strip leading directory components
    if (stripComponents > 0) {
      const parts = name.split('/').filter(Boolean)
      name = parts.slice(stripComponents).join('/')
    }
    if (!name) continue

    const fullPath = path.join(outputDir, name)

    if (entry.type === 'directory') {
      fs.mkdirSync(fullPath, { recursive: true })
    } else if (entry.type === 'file') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, entry.content)
    }
  }
}

/**
 * Parse tar archive buffer and return entries
 */
function parseTar(buffer) {
  const entries = []
  let offset = 0

  while (offset < buffer.length - 512) {
    const header = buffer.slice(offset, offset + 512)
    // Empty block = end of archive
    if (header.every(b => b === 0)) break

    const name = header.slice(0, 100).toString('ascii').replace(/\0.*$/, '').trim()
    const typeFlag = String.fromCharCode(header[156])
    const sizeStr = header.slice(124, 136).toString('ascii').replace(/\0/g, '').trim()
    const size = parseInt(sizeStr, 8) || 0

    offset += 512

    if (typeFlag === '0' || typeFlag === '') {
      // Regular file
      const content = buffer.slice(offset, offset + size)
      entries.push({ name, type: 'file', content })
    } else if (typeFlag === '5') {
      entries.push({ name, type: 'directory', content: null })
    }

    // Move to next entry (512-byte aligned blocks)
    offset += Math.ceil(size / 512) * 512
  }

  return entries
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
async function downloadBetterSqlite3(platform) {
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
    await httpsDownload(url, tmpTgz)

    // Extract .node file from tarball (contains build/Release/better_sqlite3.node)
    const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-extract-${targetPlatform}-${targetArch}`)
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
    fs.mkdirSync(tmpExtract, { recursive: true })
    extractTgz(tmpTgz, tmpExtract)

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
async function installWatcher(platform) {
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
    await httpsDownload(tarballUrl, tmpTgz)
    extractTgz(tmpTgz, destDir, 1)
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
 * Check if gh CLI binary exists and is valid for platform
 */
function checkGh(platform) {
  const filePath = path.join(PROJECT_ROOT, GH_PATHS[platform])
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }
  // gh binary should be > 5 MB
  const stats = fs.statSync(filePath)
  return { exists: true, valid: stats.size > 5 * 1024 * 1024, size: stats.size }
}

/**
 * Get the latest gh CLI release version from GitHub API
 */
async function getLatestGhVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/cli/cli/releases/latest',
      headers: { 'User-Agent': 'aico-bot-prepare-binaries' }
    }
    https.get(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          // tag_name is like "v2.67.0"
          const version = json.tag_name.replace(/^v/, '')
          resolve(version)
        } catch (err) {
          reject(new Error(`Failed to parse gh latest version: ${err.message}`))
        }
      })
    }).on('error', reject)
  })
}

/**
 * Download and extract gh CLI binary for platform
 */
async function downloadGh(platform) {
  const version = await getLatestGhVersion()
  const assetName = GH_ASSET_NAMES[platform].replace('{version}', version)
  const url = `https://github.com/cli/cli/releases/download/v${version}/${assetName}`
  const outputPath = path.join(PROJECT_ROOT, GH_PATHS[platform])
  const outputDir = path.dirname(outputPath)

  log.info(`Downloading gh CLI v${version} for ${platform}...`)

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Remove existing file
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
  }

  const tmpArchive = path.join(PROJECT_ROOT, `node_modules/.gh-download-${platform}`)

  try {
    await httpsDownload(url, tmpArchive)

    if (assetName.endsWith('.zip')) {
      // Windows/macOS: extract zip and find gh binary
      const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.gh-extract-${platform}`)
      if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
      fs.mkdirSync(tmpExtract, { recursive: true })

      extractZip(tmpArchive, tmpExtract)

      // Find the gh binary in the extracted directory
      const binaryName = platform === 'win' ? 'gh.exe' : 'gh'
      const ghBinary = findFile(tmpExtract, binaryName)

      if (!ghBinary) {
        throw new Error(`Could not find ${binaryName} in downloaded archive`)
      }

      fs.copyFileSync(ghBinary, outputPath)

      // Cleanup
      fs.rmSync(tmpExtract, { recursive: true })
    } else {
      // Linux: extract tar.gz and find gh binary
      const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.gh-extract-${platform}`)
      if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
      fs.mkdirSync(tmpExtract, { recursive: true })

      extractTgz(tmpArchive, tmpExtract)

      const ghBinary = findFile(tmpExtract, 'gh')
      if (!ghBinary) {
        throw new Error('Could not find gh binary in downloaded archive')
      }

      fs.copyFileSync(ghBinary, outputPath)
      fs.rmSync(tmpExtract, { recursive: true })
    }

    // Clean up archive
    fs.unlinkSync(tmpArchive)

    // Set executable permissions (non-Windows)
    if (platform !== 'win') {
      fs.chmodSync(outputPath, 0o755)
    }

    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)
    log.success(`Downloaded gh CLI v${version} for ${platform} (${sizeMB} MB)`)
  } catch (err) {
    // Cleanup on failure
    if (fs.existsSync(tmpArchive)) fs.unlinkSync(tmpArchive)
    const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.gh-extract-${platform}`)
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
    log.error(`Failed to download gh CLI for ${platform}: ${err.message}`)
    throw err
  }
}

/**
 * Extract a zip file using built-in Node.js (cross-platform, no external tools)
 */
function extractZip(zipPath, outputDir) {
  const data = fs.readFileSync(zipPath)

  // Parse ZIP file format manually
  // End of central directory record
  let eocdOffset = -1
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP file: EOCD not found')
  }

  const centralDirOffset = data.readUInt32LE(eocdOffset + 16)
  const centralDirEntries = data.readUInt16LE(eocdOffset + 10)

  let offset = centralDirOffset
  for (let i = 0; i < centralDirEntries; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) break

    const compressionMethod = data.readUInt16LE(offset + 10)
    const compressedSize = data.readUInt32LE(offset + 20)
    const uncompressedSize = data.readUInt32LE(offset + 24)
    const fileNameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const localHeaderOffset = data.readUInt32LE(offset + 42)

    const fileName = data.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8')

    offset += 46 + extraLength + fileNameLength + commentLength

    // Skip directories
    if (fileName.endsWith('/')) continue

    // Read local file header to get actual data
    const localExtraLength = data.readUInt16LE(localHeaderOffset + 28)
    const localFileNameLength = data.readUInt16LE(localHeaderOffset + 26)
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength

    const fullPath = path.join(outputDir, fileName)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })

    if (compressionMethod === 0) {
      // Stored (no compression)
      fs.writeFileSync(fullPath, data.slice(dataOffset, dataOffset + uncompressedSize))
    } else if (compressionMethod === 8) {
      // Deflate
      const compressed = data.slice(dataOffset, dataOffset + compressedSize)
      const decompressed = zlib.inflateRawSync(compressed)
      fs.writeFileSync(fullPath, decompressed)
    } else {
      throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`)
    }
  }
}

/**
 * Recursively find a file by name in a directory
 */
function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name)
      if (found) return found
    } else if (entry.name === name) {
      return fullPath
    }
  }
  return null
}

/**
 * Prepare all binaries for a platform
 */
async function preparePlatform(platform) {
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

  // Check and download GitHub CLI binary
  const ghStatus = checkGh(platform)
  if (!ghStatus.exists || !ghStatus.valid) {
    await downloadGh(platform)
  } else {
    log.success(`gh CLI binary already exists for ${platform}`)
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
    await preparePlatform(platform)
  }

  console.log('\n' + colors.green + '✅ All binaries prepared successfully!' + colors.reset)
}

main().catch(err => {
  log.error(err.message)
  process.exit(1)
})
