/**
 * Terminal Module - Shared terminal for human-agent collaboration
 */

export {
  terminalGateway,
  TerminalGateway,
  initTerminalGateway,
  shutdownTerminalGateway,
  getSessionCount,
  type TerminalSession,
  type TerminalCommand,
  type TerminalMessage,
} from './terminal-gateway';

export {
  initTerminalHistory,
  getTerminalHistoryStore,
  shutdownTerminalHistory,
  TerminalHistoryStore,
  type TerminalCommandRow,
} from './terminal-history-store';

export {
  saveTerminalOutput,
  saveTerminalOutputImmediate,
  loadTerminalOutput,
  clearTerminalOutput,
  flushAllPendingOutputWrites,
} from './terminal-output-store';

// Git Bash
export {
  detectGitBash,
  getAppLocalGitBashDir,
  isAppLocalInstallation,
  setGitBashPathEnv,
  getGitBashStatus,
  initializeGitBashOnStartup,
  setGitBashSkipped,
  completeGitBashInstallation,
  type GitBashDetectionResult,
  type GitBashStatus,
} from './git-bash.service';

export {
  createMockBash,
  isMockBashMode,
  getMockBashErrorMessage,
  getMockBashDir,
  cleanupMockBash,
} from './mock-bash.service';

export {
  downloadAndInstallGitBash,
  getEstimatedDownloadSize,
  getPortableGitVersion,
  type DownloadProgress,
  type ProgressCallback,
} from './git-bash-installer.service';
