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
