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
  type TerminalMessage
} from './terminal-gateway'
