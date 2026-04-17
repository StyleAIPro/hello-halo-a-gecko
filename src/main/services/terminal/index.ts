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
