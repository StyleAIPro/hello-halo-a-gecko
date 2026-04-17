/**
 * File Type Utilities - Shared constants and functions for file type detection
 *
 * Used by:
 * - canvas-lifecycle.ts (Content Canvas file opening)
 * - ArtifactCard.tsx (Card view click handling)
 * - ArtifactTree.tsx (Tree view click handling)
 */

/**
 * Binary file extensions that should NOT be opened in Canvas
 * These will open with system application or download in web mode
 */
export const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'app',
  'msi',
  'dmg',
  'pkg',
  // Archives
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'tgz',
  // Media (audio/video)
  'mp3',
  'mp4',
  'avi',
  'mov',
  'mkv',
  'flv',
  'wmv',
  'wav',
  'flac',
  'aac',
  'ogg',
  'm4a',
  'm4v',
  'webm',
  // Office documents (use external app for better experience)
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // Database
  'db',
  'sqlite',
  'sqlite3',
  'mdb',
  // Compiled/Binary code
  'class',
  'pyc',
  'pyo',
  'o',
  'obj',
  'a',
  'lib',
  // Disk images
  'iso',
  'img',
  'vmdk',
  'vdi',
]);

/**
 * Check if extension is a known binary format
 */
export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Check if a file can be opened in Canvas
 * Uses blacklist approach: anything NOT in binary list can be attempted
 */
export function canOpenInCanvas(extension: string | undefined): boolean {
  if (!extension) return true; // Files without extension - try to open, backend will detect
  return !BINARY_EXTENSIONS.has(extension.toLowerCase());
}
