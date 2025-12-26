import { spawn, ChildProcess } from 'node:child_process';
import { say } from './say.js';

function killProcess(proc: ChildProcess): void {
  proc.kill('SIGINT');
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 100);
}

/**
 * Speak text via TTS and return what STT transcribes.
 * Used for testing STT accuracy by creating a loopback from speaker to microphone.
 *
 * @param text - The text to speak
 * @param timeoutMs - Silence timeout in ms after TTS finishes (default: 1200)
 * @returns The transcribed text (empty string if nothing heard)
 */
export async function loopback(text: string, timeoutMs: number = 1200): Promise<string> {
  return new Promise((resolve) => {
    let lastLine = '';
    let silenceTimer: NodeJS.Timeout | undefined;
    let ttsFinished = false;

    // Spawn hear process
    const hearProc = spawn('hear', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Drain stderr
    hearProc.stderr?.resume();

    let resolved = false;

    // Handle hear errors
    hearProc.on('error', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      say(false); // Stop any in-flight TTS
      resolve('');
    });

    const cleanup = (): void => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }
      if (hearProc && !hearProc.killed) {
        killProcess(hearProc);
      }
    };

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      const result = lastLine;
      cleanup();
      resolve(result);
    };

    const resetSilenceTimer = (): void => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
      }
      // Only start silence timer after TTS is done
      if (ttsFinished) {
        silenceTimer = setTimeout(finish, timeoutMs);
      }
    };

    // Process hear output
    let lineBuffer = '';
    hearProc.stdout!.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          lastLine = line;
          resetSilenceTimer();
        }
      }
    });

    hearProc.on('exit', () => {
      // If hear exits unexpectedly, return what we have
      if (resolved) return;
      resolved = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
      }
      resolve(lastLine);
    });

    // Start TTS
    say(text).then(() => {
      ttsFinished = true;
      // Start silence timer now that TTS is done
      silenceTimer = setTimeout(finish, timeoutMs);
    });
  });
}
