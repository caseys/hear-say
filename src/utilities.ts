import { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Debug log file path - configurable via env, defaults to /tmp/
const DEBUG_LOG_FILE = process.env.HEAR_SAY_DEBUG_LOG || '/tmp/hear-say-debug.log';

/**
 * Log a debug message with a prefix to debug.log file.
 */
export function debug(prefix: string, ...arguments_: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `${timestamp} ${prefix} ${arguments_.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try {
    appendFileSync(DEBUG_LOG_FILE, message);
  } catch {
    // Ignore file write errors
  }
}

/**
 * Kill a child process gracefully with SIGTERM, falling back to SIGKILL.
 * Returns a Promise that resolves when the process actually exits.
 */
export function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // If already exited, resolve immediately
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }

    // Set up exit handler
    const onExit = () => {
      clearTimeout(forceKillTimer);
      resolve();
    };
    proc.once('exit', onExit);

    // Try graceful shutdown first
    proc.kill('SIGTERM');

    // Force kill after 200ms if still running
    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }, 200);
  });
}
