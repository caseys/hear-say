import { spawn, ChildProcess } from 'node:child_process';

let activeProcess: ChildProcess | undefined;
let lastSpoken: string = '';
let speaking: boolean = false;

// Event listeners (supports multiple)
const startListeners: Array<() => void> = [];
const finishListeners: Array<() => void> = [];

// Queue entries with their resolvers
interface QueueEntry {
  text: string;
  resolve: () => void;
}
const speechQueue: QueueEntry[] = [];
let processingQueue = false;

function killProcess(proc: ChildProcess): void {
  proc.kill('SIGINT');
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 100);
}

function emitStart(): void {
  for (const listener of startListeners) {
    listener();
  }
}

function emitFinish(): void {
  for (const listener of finishListeners) {
    listener();
  }
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
 * Fires start event when processing begins, finish event when queue empties.
 */
async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  speaking = true;
  emitStart();

  while (speechQueue.length > 0) {
    const entry = speechQueue.shift()!;
    await speakOne(entry.text);
    entry.resolve();
  }

  speaking = false;
  processingQueue = false;
  emitFinish();
}

/**
 * Queue text to be spoken. Returns a promise that resolves when THIS text finishes.
 * Pass false to stop all speech and clear the queue.
 */
export function say(text: string | false): Promise<void> {
  // If false, stop everything and clear queue
  if (text === false) {
    // Resolve all pending promises before clearing
    for (const entry of speechQueue) {
      entry.resolve();
    }
    speechQueue.length = 0;
    if (activeProcess) {
      killProcess(activeProcess);
      activeProcess = undefined;
    }
    if (speaking) {
      speaking = false;
      processingQueue = false;
      emitFinish();
    }
    return Promise.resolve();
  }

  // Add to queue with its own resolver
  return new Promise((resolve) => {
    speechQueue.push({ text, resolve });
    processQueue();
  });
}

/**
 * Interrupt current speech and speak new text immediately.
 * Clears the queue and stops any current speech before speaking.
 */
export function interrupt(text: string): Promise<void> {
  // Clear queue and resolve pending promises
  for (const entry of speechQueue) {
    entry.resolve();
  }
  speechQueue.length = 0;

  // Kill current process if speaking
  if (activeProcess) {
    killProcess(activeProcess);
    activeProcess = undefined;
  }

  // Reset state
  speaking = false;
  processingQueue = false;

  // Now queue the new text
  return new Promise((resolve) => {
    speechQueue.push({ text, resolve });
    processQueue();
  });
}

export function getLastSpoken(): string {
  return lastSpoken;
}

export function isSpeaking(): boolean {
  return speaking;
}

/**
 * Register a callback for when speech starts.
 * Returns a function to unregister the listener.
 */
export function onSayStarted(callback: () => void): () => void {
  startListeners.push(callback);
  return () => {
    const index = startListeners.indexOf(callback);
    if (index !== -1) {
      startListeners.splice(index, 1);
    }
  };
}

/**
 * Register a callback for when speech finishes.
 * Returns a function to unregister the listener.
 */
export function onSayFinished(callback: () => void): () => void {
  finishListeners.push(callback);
  return () => {
    const index = finishListeners.indexOf(callback);
    if (index !== -1) {
      finishListeners.splice(index, 1);
    }
  };
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
