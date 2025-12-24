import { spawn, ChildProcess } from 'node:child_process';

let activeProcess: ChildProcess | undefined;
let lastSpoken: string = '';
let speaking: boolean = false;
let onSpeakingDone: (() => void) | undefined;
let onSpeakingStart: (() => void) | undefined;

// Queue for pending speech
const speechQueue: string[] = [];
let processingQueue = false;

function killProcess(proc: ChildProcess): void {
  proc.kill('SIGINT');
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 100);
}

/**
 * Speak a single text and return a promise that resolves when done.
 */
function speakOne(text: string): Promise<void> {
  return new Promise((resolve) => {
    lastSpoken = text;

    const proc = spawn('say', [text], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcess = proc;

    // Drain stdout/stderr to prevent blocking
    proc.stdout?.resume();
    proc.stderr?.resume();

    // Handle errors (e.g., missing binary)
    proc.on('error', () => {
      if (activeProcess === proc) {
        activeProcess = undefined;
      }
      resolve();
    });

    proc.on('exit', () => {
      if (activeProcess === proc) {
        activeProcess = undefined;
      }
      resolve();
    });
  });
}

/**
 * Process the speech queue sequentially.
 * Only fires onSpeakingStart when queue processing begins,
 * and onSpeakingDone when queue is fully empty.
 */
async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  speaking = true;
  onSpeakingStart?.();

  while (speechQueue.length > 0) {
    const text = speechQueue.shift()!;
    await speakOne(text);
  }

  speaking = false;
  processingQueue = false;
  onSpeakingDone?.();
}

/**
 * Queue text to be spoken. Returns a promise that resolves when this text finishes.
 * Pass false to stop all speech and clear the queue.
 */
export function say(text: string | false): Promise<void> {
  // If false, stop everything and clear queue
  if (text === false) {
    speechQueue.length = 0; // Clear queue
    if (activeProcess) {
      killProcess(activeProcess);
      activeProcess = undefined;
      speaking = false;
    }
    return Promise.resolve();
  }

  // Add to queue and start processing
  speechQueue.push(text);

  // Return a promise that resolves when this specific text is spoken
  return new Promise((resolve) => {
    const checkDone = (): void => {
      // If queue is empty and not speaking, we're done
      if (speechQueue.length === 0 && !speaking) {
        resolve();
      } else {
        // Check again soon
        setTimeout(checkDone, 50);
      }
    };

    processQueue().then(checkDone);
  });
}

export function getLastSpoken(): string {
  return lastSpoken;
}

export function isSpeaking(): boolean {
  return speaking;
}

export function onSayStarted(callback: () => void): void {
  onSpeakingStart = callback;
}

export function onSayFinished(callback: () => void): void {
  onSpeakingDone = callback;
}

// Cleanup on process exit
function cleanup(): void {
  if (activeProcess) {
    killProcess(activeProcess);
    activeProcess = undefined;
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
