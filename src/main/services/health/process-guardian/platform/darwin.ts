/**
 * Platform-specific process operations for macOS (Darwin)
 *
 * Uses POSIX-compatible commands for process discovery and management.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { PlatformProcessOps, ProcessInfo, ChildProcessInfo } from '../../types';

const execAsync = promisify(exec);

/**
 * Darwin (macOS) implementation of platform process operations
 */
export class DarwinProcessOps implements PlatformProcessOps {
  /**
   * Find processes by command-line pattern
   * Uses `ps` command with grep to find matching processes
   */
  async findByArgs(pattern: string): Promise<ProcessInfo[]> {
    const results: ProcessInfo[] = [];

    try {
      // ps -eo pid,command: list all processes with PID and full command
      // grep: filter by pattern
      // grep -v grep: exclude the grep process itself
      const { stdout } = await execAsync(`ps -eo pid,command | grep "${pattern}" | grep -v grep`, {
        timeout: 5000,
      });

      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const trimmed = line.trim();
        // Parse: "  PID COMMAND..."
        const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          const commandLine = match[2];

          // Extract process name from command (first token)
          const name = commandLine.split(/\s+/)[0].split('/').pop();

          results.push({
            pid,
            commandLine,
            name,
          });
        }
      }
    } catch (error: unknown) {
      // grep returns exit code 1 when no matches found - this is not an error
      const err = error as { code?: number };
      if (err.code === 1) {
        return [];
      }
      console.error('[Health][Darwin] Failed to find processes:', error);
    }

    return results;
  }

  /**
   * Kill a process by PID
   * @param pid - Process ID to kill
   * @param signal - Signal to send (default: SIGTERM)
   */
  async killProcess(pid: number, signal: string = 'SIGTERM'): Promise<void> {
    try {
      // Use kill command with specified signal
      const signalArg = signal === 'SIGKILL' ? '-9' : '-15';
      await execAsync(`kill ${signalArg} ${pid}`, { timeout: 5000 });
      console.log(`[Health][Darwin] Killed process ${pid} with ${signal}`);
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      // Process may have already exited
      if (err.message?.includes('No such process')) {
        console.log(`[Health][Darwin] Process ${pid} already exited`);
        return;
      }
      console.error(`[Health][Darwin] Failed to kill process ${pid}:`, error);
      throw error;
    }
  }

  /**
   * Check if a process is still alive
   * Uses kill -0 which doesn't actually send a signal
   */
  isProcessAlive(pid: number): boolean {
    try {
      // kill -0 checks if process exists without sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find child processes by parent PID (PPID scanning)
   * Uses ps with awk to filter by PPID
   */
  async findChildProcesses(ppid: number): Promise<ChildProcessInfo[]> {
    const results: ChildProcessInfo[] = [];

    try {
      // ps -eo pid,ppid,comm: list all processes with PID, PPID, and command name
      // awk filters by PPID column (column 2)
      const { stdout } = await execAsync(
        `ps -eo pid,ppid,comm | awk '$2 == ${ppid} { print $1, $2, $3 }'`,
        { timeout: 5000 },
      );

      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const parentPid = parseInt(parts[1], 10);
          // Extract just the process name (last part of path)
          const name = parts[2].split('/').pop() || parts[2];

          if (!isNaN(pid) && !isNaN(parentPid)) {
            results.push({
              pid,
              ppid: parentPid,
              name,
            });
          }
        }
      }
    } catch (error: unknown) {
      // Empty result is not an error
      const err = error as { code?: number };
      if (err.code === 1) {
        return [];
      }
      console.error('[Health][Darwin] Failed to find child processes:', error);
    }

    return results;
  }
}
