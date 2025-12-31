import { ChildProcess } from 'node:child_process';

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
