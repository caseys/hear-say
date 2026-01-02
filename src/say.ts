import { spawn, ChildProcess } from 'node:child_process';
import { killProcess, debug as debugLog } from './utilities.js';

// Re-export setDebug for public API
export { setDebug } from './utilities.js';

function debug(...arguments_: unknown[]): void {
  debugLog('[say]', ...arguments_);
}

let activeProcess: ChildProcess | undefined;
let lastSpoken: string = '';
let speaking: boolean = false;

// Event listeners (supports multiple)
const startListeners: Array<() => void> = [];
const finishListeners: Array<() => void> = [];
const gapStartListeners: Array<() => void> = [];
const gapEndListeners: Array<() => void> = [];

// Gap configuration (pause between queue items to allow hearing) - SAY_QUEUE_BREAK in seconds
let gapDuration = (Number(process.env.SAY_QUEUE_BREAK) || 2) * 1000;
let gapCompletionResolver: (() => void) | undefined;
let queueCancelled = false;

// Queue entries with their resolvers
interface QueueEntry {
  text: string;
  resolve: () => void;
}
const speechQueue: QueueEntry[] = [];
let processingQueue = false;

// Options for say() behavior
export interface SayOptions {
  interrupt?: boolean;  // Skip to be next in queue (wait for current to finish)
  clear?: boolean;      // Clear the queue (implies interrupt)
  rude?: boolean;       // Cut off current speaker immediately, speak now; interrupted text is rescheduled after
  latest?: boolean;     // Only the last call with this flag wins (supersedes previous)
}

// Pending interrupt entry (only one, newer calls supersede)
interface PendingInterrupt extends QueueEntry {
  clear: boolean;
}

// Track the current "latest" queue entry (if any) - for latest without interrupt
let latestEntry: QueueEntry | undefined;
let pendingInterrupt: PendingInterrupt | undefined;

// Speech rate configuration (words per minute) - configurable via env vars
const MIN_RATE = Number(process.env.MIN_RATE) || 230;
const MAX_RATE = Number(process.env.MAX_RATE) || 370;
const WORD_THRESHOLD = Number(process.env.WORD_QUEUE_PLATEAU) || 15;
const VOICE = process.env.VOICE || '';

function calculateRate(currentText: string): number {
  // Count words in current text + remaining queue
  let wordCount = currentText.split(/\s+/).filter(w => w.length > 0).length;
  for (const entry of speechQueue) {
    wordCount += entry.text.split(/\s+/).filter(w => w.length > 0).length;
  }
  const scale = Math.min(wordCount, WORD_THRESHOLD) / WORD_THRESHOLD;
  const rate = Math.round(MIN_RATE + scale * (MAX_RATE - MIN_RATE));
  debug(`rate=${rate} (${wordCount} words in ${speechQueue.length + 1} items)`);
  return rate;
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

function emitGapStart(): void {
  for (const listener of gapStartListeners) {
    listener();
  }
}

function emitGapEnd(): void {
  gapCompletionResolver = undefined;
  for (const listener of gapEndListeners) {
    listener();
  }
}

/**
 * Speak a single text and return a promise that resolves when done.
 */
function speakOne(text: string): Promise<void> {
  return new Promise((resolve) => {
    lastSpoken = text;
    const rate = calculateRate(text);

    const sayArguments = ['-r', String(rate)];
    if (VOICE) {
      sayArguments.push('-v', VOICE);
    }
    sayArguments.push(text);

    debug(`exec: say ${sayArguments.join(' ')}`);

    const proc = spawn('say', sayArguments, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcess = proc;

    // Capture stdout/stderr for logging
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Handle errors (e.g., missing binary)
    proc.on('error', (error) => {
      debug(`error: ${error.message}`);
      if (activeProcess === proc) {
        activeProcess = undefined;
      }
      resolve();
    });

    proc.on('exit', (code) => {
      if (stdout) debug(`stdout: ${stdout.trim()}`);
      if (stderr) debug(`stderr: ${stderr.trim()}`);
      debug(`exit: ${code}`);
      if (activeProcess === proc) {
        activeProcess = undefined;
      }
      resolve();
    });
  });
}

/**
 * Wait for a gap period, allowing hear to capture speech.
 * Resolves when either gapDuration passes or speech is detected and completed.
 */
async function waitForGap(): Promise<void> {
  if (gapDuration <= 0 || gapStartListeners.length === 0) return;

  emitGapStart();

  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, gapDuration)),
    new Promise<void>((resolve) => {
      gapCompletionResolver = resolve;
    }),
  ]);

  emitGapEnd();
}

/**
 * Process the speech queue sequentially.
 * Fires start event when processing begins, finish event when queue empties.
 * Pending interrupts are processed before continuing with the regular queue.
 * Gaps between items allow hear to capture user speech.
 */
async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  speaking = true;
  emitStart();

  while (speechQueue.length > 0 || pendingInterrupt) {
    // Check cancellation flag (set by say(false))
    if (queueCancelled) {
      queueCancelled = false;
      return;  // Exit without emitting finish (already done in say(false))
    }

    // Check for pending interrupt BEFORE processing more queue items
    if (pendingInterrupt) {
      const entry = pendingInterrupt;
      pendingInterrupt = undefined;
      if (entry.clear) {
        // Clear remaining queue (including latest entry)
        for (const queueEntry of speechQueue) {
          queueEntry.resolve();
        }
        speechQueue.length = 0;
        latestEntry = undefined;
      }
      await speakOne(entry.text);
      if (queueCancelled) {
        queueCancelled = false;
        return;
      }
      entry.resolve();

      // Gap after interrupt if more to say
      if (speechQueue.length > 0 || pendingInterrupt) {
        await waitForGap();
        if (queueCancelled) {
          queueCancelled = false;
          return;
        }
      }
      continue;  // Re-check for another interrupt
    }

    // Process one queue item
    if (speechQueue.length > 0) {
      const entry = speechQueue.shift()!;
      // Clear latest tracking if this was the latest entry
      if (entry === latestEntry) {
        latestEntry = undefined;
      }
      await speakOne(entry.text);
      if (queueCancelled) {
        queueCancelled = false;
        return;
      }
      entry.resolve();

      // Gap after item if more to say
      if (speechQueue.length > 0 || pendingInterrupt) {
        await waitForGap();
        if (queueCancelled) {
          queueCancelled = false;
          return;
        }
      }
    }
  }

  speaking = false;
  processingQueue = false;
  emitFinish();
}

/**
 * Queue text to be spoken. Returns a promise that resolves when THIS text finishes.
 * Pass false to stop all speech and clear the queue.
 *
 * Options:
 * - interrupt: Skip to be next in queue (wait for current to finish, last wins)
 * - clear: Clear the queue (implies interrupt)
 * - rude: Cut off current speaker immediately, speak now. Interrupted text is rescheduled
 *         to play right after the rude text.
 * - latest: Only the last call wins. Combine with interrupt/clear to control position.
 */
export function say(text: string | false, options?: SayOptions): Promise<void> {
  // Empty strings are no-ops (avoid spawning process with no text)
  if (text === '') {
    return Promise.resolve();
  }

  // If false, stop everything and clear queue
  if (text === false) {
    // Set cancellation flag first so processQueue() exits cleanly
    queueCancelled = true;

    // Abort any pending gap
    if (gapCompletionResolver) {
      gapCompletionResolver();
      gapCompletionResolver = undefined;
    }

    // Resolve all pending promises before clearing
    for (const entry of speechQueue) {
      entry.resolve();
    }
    speechQueue.length = 0;
    latestEntry = undefined;
    if (pendingInterrupt) {
      pendingInterrupt.resolve();
      pendingInterrupt = undefined;
    }
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

  const sayOptions = options ?? {};
  const isInterrupt = sayOptions.rude || sayOptions.clear || sayOptions.interrupt;

  if (isInterrupt) {
    if (sayOptions.rude) {
      // Set cancellation flag so old processQueue() exits cleanly
      queueCancelled = true;

      // Capture interrupted text before killing (to reschedule after rude text)
      let interruptedText: string | undefined;
      if (activeProcess && lastSpoken) {
        interruptedText = lastSpoken;
        debug(`rude: interrupted "${interruptedText}"`);
      }

      // Rude mode: kill current speech immediately, speak now
      // Only clear queue if clear option is also set
      if (sayOptions.clear) {
        for (const entry of speechQueue) {
          entry.resolve();
        }
        speechQueue.length = 0;
        latestEntry = undefined;
      }
      if (pendingInterrupt) {
        pendingInterrupt.resolve();
        pendingInterrupt = undefined;
      }
      if (activeProcess) {
        killProcess(activeProcess);
        activeProcess = undefined;
      }
      speaking = false;
      processingQueue = false;

      // Insert at front of queue (before other queued items)
      const entry = { text, resolve: () => {} };
      return new Promise((resolve) => {
        entry.resolve = resolve;
        // Track as latest if flag set
        if (sayOptions.latest) {
          if (latestEntry) {
            // Remove old latest from queue and resolve its promise
            const index = speechQueue.indexOf(latestEntry);
            if (index !== -1) {
              speechQueue.splice(index, 1);
              latestEntry.resolve();
            }
          }
          latestEntry = entry;
        }
        speechQueue.unshift(entry);
        // Reschedule interrupted text right after rude text
        if (interruptedText) {
          debug(`rude: rescheduling "${interruptedText}" after rude text`);
          speechQueue.splice(1, 0, { text: interruptedText, resolve: () => {} });
        }
        processQueue();
      });
    } else {
      // Polite interrupt: wait for current to finish, then speak (supersedes previous)
      if (pendingInterrupt) {
        pendingInterrupt.resolve();  // Supersede previous
      }
      return new Promise((resolve) => {
        pendingInterrupt = { text, resolve, clear: !!sayOptions.clear };
        // If nothing is processing, start now
        if (!processingQueue) {
          processQueue();
        }
      });
    }
  }

  // Latest without interrupt: append to queue, but replace if already exists
  if (sayOptions.latest) {
    if (latestEntry) {
      // Replace existing latest entry in place
      latestEntry.resolve();  // Resolve old promise (superseded)
      latestEntry.text = text;  // Update text
      // Return new promise for caller
      return new Promise((resolve) => {
        latestEntry!.resolve = resolve;
        // If nothing is processing, start now
        if (!processingQueue) {
          processQueue();
        }
      });
    } else {
      // Add new latest entry at end
      return new Promise((resolve) => {
        latestEntry = { text, resolve };
        speechQueue.push(latestEntry);
        processQueue();
      });
    }
  }

  // Normal queue behavior
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

/**
 * Register a callback for when a gap starts between queue items.
 * During the gap, hear can listen for user speech.
 * Returns a function to unregister the listener.
 */
export function onSayGapStart(callback: () => void): () => void {
  gapStartListeners.push(callback);
  return () => {
    const index = gapStartListeners.indexOf(callback);
    if (index !== -1) {
      gapStartListeners.splice(index, 1);
    }
  };
}

/**
 * Register a callback for when a gap ends between queue items.
 * Returns a function to unregister the listener.
 */
export function onSayGapEnd(callback: () => void): () => void {
  gapEndListeners.push(callback);
  return () => {
    const index = gapEndListeners.indexOf(callback);
    if (index !== -1) {
      gapEndListeners.splice(index, 1);
    }
  };
}

/**
 * Signal that speech was captured during a gap and processing is complete.
 * This ends the gap early so the queue can continue.
 */
export function signalGapSpeechComplete(): void {
  if (gapCompletionResolver) {
    gapCompletionResolver();
    gapCompletionResolver = undefined;
  }
}

/**
 * Set the gap duration between queue items (in milliseconds).
 * Default is 2000ms. Set to 0 to disable gaps.
 */
export function setGapDuration(ms: number): void {
  gapDuration = ms;
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
