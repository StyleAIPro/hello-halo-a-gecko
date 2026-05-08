import type { LevelOption } from 'electron-log';

export type LogFn = (...params: unknown[]) => void;

export interface ScopedLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  silly: LogFn;
}

export interface LogConfig {
  /** 日志目录路径 */
  logDir: string;
  /** 是否为开发环境 */
  isDev: boolean;
  /** 文件日志最低级别，默认 'info' */
  fileLevel?: LevelOption;
  /** 控制台日志最低级别，默认 dev='debug' / prod='info' */
  consoleLevel?: LevelOption;
  /** 单文件最大字节数，默认 5MB */
  maxFileSize?: number;
}
