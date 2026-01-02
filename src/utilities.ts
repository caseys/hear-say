import { ChildProcess } from 'node:child_process';

// Shared debug state - reads env var at module load, can be overridden at runtime
let debugEnabled = process.env.HEAR_SAY_DEBUG === '1' || process.env.HEAR_SAY_DEBUG === 'true';

/**
 * Enable or disable debug logging at runtime.
 */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * Check if debug logging is enabled.
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Log a debug message with a prefix.
 */
export function debug(prefix: string, ...arguments_: unknown[]): void {
  if (debugEnabled) {
    console.log(prefix, ...arguments_);
  }
}

/**
 * Kill a child process gracefully with SIGINT, falling back to SIGKILL.
 */
export function killProcess(proc: ChildProcess): void {
  proc.kill('SIGINT');
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 100);
}
