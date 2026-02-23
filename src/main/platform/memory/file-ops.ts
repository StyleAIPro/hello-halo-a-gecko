/**
 * platform/memory -- File Operations
 *
 * Low-level filesystem operations for memory files.
 * All functions are async and operate on absolute paths.
 * Path resolution and permission checks happen in the calling layer.
 */

import { readFile, writeFile, appendFile, mkdir, readdir, rename, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

// ============================================================================
// Read
// ============================================================================

/**
 * Read a memory file.
 *
 * @param filePath - Absolute path to the file
 * @returns File content as string, or null if file does not exist
 */
export async function readMemoryFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Extract all markdown headings from a memory file.
 *
 * Returns heading lines prefixed with their line numbers, e.g.:
 *   L1:  # State
 *   L15: ## Tracked Items
 *   L30: ## Patterns
 *
 * @param filePath - Absolute path to the file
 * @returns Heading lines with line numbers, or null if file does not exist
 */
export async function readMemoryHeadings(filePath: string): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const headings: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) {
      headings.push(`L${i + 1}: ${line}`)
    }
  }

  if (headings.length === 0) {
    return '(No markdown headings found in memory file)'
  }

  return headings.join('\n')
}

/**
 * Extract a specific section from a memory file by heading text.
 *
 * A section starts at the matched heading line and ends at the next heading
 * of equal or higher level, or at the end of the file.
 *
 * Matching is case-insensitive substring: section="tracked" matches "## Tracked Items".
 *
 * @param filePath - Absolute path to the file
 * @param heading  - Heading text to match (case-insensitive substring)
 * @returns Section content including the heading line, or null if file/section not found
 */
export async function readMemorySection(filePath: string, heading: string): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const needle = heading.toLowerCase()

  // Find the first heading line that matches
  let startIdx = -1
  let startLevel = 0

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)/)
    if (match && match[2].toLowerCase().includes(needle)) {
      startIdx = i
      startLevel = match[1].length
      break
    }
  }

  if (startIdx === -1) {
    return null // Section not found
  }

  // Find the end: next heading at same or higher level (fewer or equal #)
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/)
    if (match && match[1].length <= startLevel) {
      endIdx = i
      break
    }
  }

  return lines.slice(startIdx, endIdx).join('\n')
}

/**
 * Read the last N lines of a memory file.
 *
 * @param filePath - Absolute path to the file
 * @param limit    - Number of lines to return (default: 50)
 * @returns Last N lines as string, or null if file does not exist
 */
export async function readMemoryTail(filePath: string, limit: number = 50): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const startLine = Math.max(0, lines.length - limit)
  const tailLines = lines.slice(startLine)

  if (startLine > 0) {
    return `... (showing last ${limit} of ${lines.length} lines)\n` + tailLines.join('\n')
  }

  return tailLines.join('\n')
}

// ============================================================================
// Write
// ============================================================================

/**
 * Append content to a memory file.
 *
 * Ensures the parent directory exists. Prepends a metadata comment
 * with timestamp and source identifier for audit trail.
 *
 * @param filePath - Absolute path to the file
 * @param content  - Content to append
 * @param source   - Identifier of the writer (e.g., 'user', 'app:my-app')
 */
export async function appendToMemoryFile(
  filePath: string,
  content: string,
  source: string
): Promise<void> {
  await ensureDir(dirname(filePath))

  const timestamp = new Date().toISOString()
  const header = `\n<!-- ${timestamp} by ${source} -->\n`
  const payload = header + content.trimEnd() + '\n'

  await appendFile(filePath, payload, 'utf-8')
}

/**
 * Replace the entire content of a memory file.
 *
 * Uses atomic write pattern: write to temp file, then rename.
 * Ensures the parent directory exists.
 *
 * @param filePath - Absolute path to the file
 * @param content  - New content
 */
export async function replaceMemoryFile(
  filePath: string,
  content: string
): Promise<void> {
  await ensureDir(dirname(filePath))

  const tmpPath = filePath + '.tmp'
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

// ============================================================================
// List
// ============================================================================

/**
 * List files in a memory archive directory.
 *
 * @param dirPath - Absolute path to the directory
 * @returns Array of filenames (not full paths), sorted newest first
 */
export async function listMemoryFiles(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) {
    return []
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)

    // Sort newest first (lexicographic descending works for YYYY-MM-DD format)
    files.sort((a, b) => b.localeCompare(a))
    return files
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return []
    }
    throw err
  }
}

// ============================================================================
// Archive (for compaction)
// ============================================================================

/**
 * Archive a memory file by moving it to the archive directory.
 *
 * @param filePath   - Path to the current memory.md
 * @param archiveDir - Path to the memory/ archive directory
 * @returns Path to the archived file
 */
export async function archiveMemoryFile(
  filePath: string,
  archiveDir: string
): Promise<string> {
  await ensureDir(archiveDir)

  const now = new Date()
  const slug = formatTimestamp(now)
  const archiveName = `${slug}.md`
  const archivePath = join(archiveDir, archiveName)

  // Handle name collision (very unlikely -- same minute)
  let finalPath = archivePath
  if (existsSync(archivePath)) {
    const deduped = `${slug}-${now.getSeconds().toString().padStart(2, '0')}.md`
    finalPath = join(archiveDir, deduped)
  }

  await rename(filePath, finalPath)
  return finalPath
}

/**
 * Get the size of a file in bytes.
 *
 * @returns File size in bytes, or 0 if file does not exist
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath)
    return stats.size
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return 0
    }
    throw err
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true })
  }
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
