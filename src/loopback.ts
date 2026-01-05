import { spawn } from 'node:child_process';
import { say } from './say.js';
import { killProcess } from './utilities.js';

/**
 * Speak text via TTS and return what STT transcribes.
 * Used for testing STT accuracy by creating a loopback from speaker to microphone.
 *
 * Note: This spawns its own independent hear process (not using hear()) because
 * hear() stops listening when TTS starts. Loopback needs to listen DURING TTS.
 *
 * @param text - The text to speak
 * @param timeoutMs - Silence timeout in ms after TTS finishes (default: 1800)
 * @param onLine - Optional callback for each line (text, final) - matches hear() pattern
 * @returns The transcribed text (empty string if nothing heard)
 */
export async function loopback(
  text: string,
  timeoutMs: number = 1800,
  onLine?: (text: string, final: boolean) => void
): Promise<string> {
  return new Promise((resolve) => {
    let lastTranscribedText = '';
    let silenceTimer: NodeJS.Timeout | undefined;
    let ttsFinished = false;

    // Spawn independent hear process (not subject to onSayStarted shutdown)
    const hearProcess = spawn('hear', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Drain stderr
    hearProcess.stderr?.resume();

    let resolved = false;

    // Handle hear errors
    hearProcess.on('error', () => {
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
      if (hearProcess && !hearProcess.killed) {
        killProcess(hearProcess);
      }
    };

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      const result = lastTranscribedText;
      cleanup();
      onLine?.(result, true);
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
    hearProcess.stdout!.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          lastTranscribedText = line;
          resetSilenceTimer();
          onLine?.(line, false);
        }
      }
    });

    hearProcess.on('exit', () => {
      // If hear exits unexpectedly, return what we have
      if (resolved) return;
      resolved = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
      }
      resolve(lastTranscribedText);
    });

    // Start TTS
    say(text).then(() => {
      ttsFinished = true;
      // Start silence timer now that TTS is done
      silenceTimer = setTimeout(finish, timeoutMs);
    });
  });
}
