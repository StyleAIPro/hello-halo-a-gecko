/**
 * Tool Result Viewer Types
 * Type definitions for intelligent tool result rendering
 */

// Content type for tool result rendering
export type ToolResultContentType =
  | 'code' // Read/Bash - syntax highlighted code
  | 'search-result' // Grep - search matches with file paths
  | 'file-list' // Glob - file/folder list
  | 'markdown' // WebFetch/Task - rendered markdown
  | 'json' // Structured JSON data
  | 'plaintext'; // Fallback plain text

// Props for all tool result viewers
export interface ToolResultViewerProps {
  toolName: string;
  toolInput?: Record<string, unknown>;
  output: string;
  isError?: boolean;
}

// Props for individual viewer components
export interface ViewerBaseProps {
  output: string;
  isError?: boolean;
  language?: string;
  toolInput?: Record<string, unknown>;
}

// Parsed search result for Grep
export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  content: string;
  matchStart?: number;
  matchEnd?: number;
}

export interface ParsedSearchResult {
  matches: SearchMatch[];
  fileCount: number;
  matchCount: number;
  pattern?: string;
}

// Parsed file list for Glob
export interface FileListItem {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface ParsedFileList {
  items: FileListItem[];
  fileCount: number;
  folderCount: number;
}
