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
let repeatReductionEnabled: boolean = true;

// Event listeners (supports multiple)
const startListeners: Array<() => void> = [];
const finishListeners: Array<() => void> = [];
const gapStartListeners: Array<() => void> = [];
const gapEndListeners: Array<() => void> = [];

// Gap configuration (pause between queue items to allow hearing) - SAY_QUEUE_BREAK in seconds
let gapDuration = (Number(process.env.SAY_QUEUE_BREAK) || 2) * 1000;
let gapCompletionResolver: (() => void) | undefined;

// Queue generation counter - each processQueue instance has its own generation
// Incrementing this signals any running queue to exit on next check
let queueGeneration = 0;

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
const MIN_RATE = Number(process.env.MIN_RATE) || 200;
const MAX_RATE = Number(process.env.MAX_RATE) || 300;
const WORD_THRESHOLD = Number(process.env.WORD_QUEUE_PLATEAU) || 30;
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

/**
 * Reduce repetition by stripping common prefix and suffix from new text.
 * Returns undefined if result is empty (exact duplicate - should be skipped).
 */
function reduceRepetition(newText: string, lastText: string): string | undefined {
  // Find character-level common prefix
  let prefixLength = 0;
  while (prefixLength < newText.length &&
         prefixLength < lastText.length &&
         newText[prefixLength] === lastText[prefixLength]) {
    prefixLength++;
  }

  // Snap prefix back to word boundary if mid-word
  while (prefixLength > 0 && /\w/.test(newText[prefixLength - 1]) && /\w/.test(newText[prefixLength] || '')) {
    prefixLength--;
  }
  // Extend prefix to include trailing punctuation/whitespace
  while (prefixLength < newText.length && /[^\w]/.test(newText[prefixLength])) {
    prefixLength++;
  }

  // Find character-level common suffix (don't overlap with prefix)
  let suffixLength = 0;
  const maxSuffix = Math.min(newText.length - prefixLength, lastText.length - prefixLength);
  while (suffixLength < maxSuffix &&
         newText[newText.length - 1 - suffixLength] === lastText[lastText.length - 1 - suffixLength]) {
    suffixLength++;
  }

  // Snap suffix back to word boundary if mid-word
  while (suffixLength > 0 && /\w/.test(newText[newText.length - suffixLength]) &&
         /\w/.test(newText[newText.length - suffixLength - 1] || '')) {
    suffixLength--;
  }
  // Extend suffix to include leading punctuation/whitespace
  while (suffixLength < newText.length - prefixLength && /[^\w]/.test(newText[newText.length - 1 - suffixLength])) {
    suffixLength++;
  }

  const result = newText.slice(prefixLength, newText.length - suffixLength).trim();

  if (result === '') {
    debug(`reduceRepetition: skipping duplicate "${newText}"`);
    return undefined;
  }

  if (result !== newText) {
    debug(`reduceRepetition: "${newText}" -> "${result}"`);
  }

  return result;
}

function emitStart(): void {
  for (const listener of startListeners) {
    try { listener(); } catch (error) { debug('emitStart error:', error); }
  }
}

function emitFinish(): void {
  for (const listener of finishListeners) {
    try { listener(); } catch (error) { debug('emitFinish error:', error); }
  }
}

function emitGapStart(): void {
  for (const listener of gapStartListeners) {
    try { listener(); } catch (error) { debug('emitGapStart error:', error); }
  }
}

function emitGapEnd(): void {
  gapCompletionResolver = undefined;
  for (const listener of gapEndListeners) {
    try { listener(); } catch (error) { debug('emitGapEnd error:', error); }
  }
}

/**
 * Speak a single text and return a promise that resolves when done.
 */
function speakOne(text: string): Promise<void> {
  return new Promise((resolve) => {
    // Apply repeat reduction if enabled
    let textToSpeak = text;
    if (repeatReductionEnabled && lastSpoken) {
      const reduced = reduceRepetition(text, lastSpoken);
      if (reduced === undefined) {
        // Exact duplicate - skip speaking
        lastSpoken = text;  // Still update lastSpoken
        resolve();
        return;
      }
      textToSpeak = reduced;
    }

    // Store original text for future reduction comparisons
    lastSpoken = text;
    const rate = calculateRate(textToSpeak);

    const sayArguments = ['-r', String(rate)];
    if (VOICE) {
      sayArguments.push('-v', VOICE);
    }
    sayArguments.push(textToSpeak);

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
  const myGeneration = ++queueGeneration;
  emitStart();

  try {
    while (speechQueue.length > 0 || pendingInterrupt) {
      // Check if superseded by newer queue or cancelled via say(false)
      if (queueGeneration !== myGeneration) {
        return;
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
        // Always resolve after speaking completes (even if cancelled)
        // so caller's await doesn't hang
        entry.resolve();
        if (queueGeneration !== myGeneration) {
          return;
        }

        // Gap after interrupt if more to say
        if (speechQueue.length > 0 || pendingInterrupt) {
          await waitForGap();
          if (queueGeneration !== myGeneration) {
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
        // Always resolve after speaking completes (even if cancelled)
        // so caller's await doesn't hang
        entry.resolve();
        if (queueGeneration !== myGeneration) {
          return;
        }

        // Gap after item if more to say
        if (speechQueue.length > 0 || pendingInterrupt) {
          await waitForGap();
          if (queueGeneration !== myGeneration) {
            return;
          }
        }
      }
    }
  } finally {
    // Only cleanup if we're still the current generation
    // (if superseded, the new queue or say(false) handles cleanup)
    if (queueGeneration === myGeneration) {
      speaking = false;
      processingQueue = false;
      emitFinish();
    }
  }
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

  // Self-healing: detect and recover from stuck processingQueue state
  // This is an impossible state - processingQueue true but nothing to process and no active process
  if (processingQueue && speechQueue.length === 0 && !pendingInterrupt && !activeProcess) {
    debug('self-healing: resetting stuck processingQueue');
    processingQueue = false;
    speaking = false;
  }

  // If false, stop everything and clear queue
  if (text === false) {
    // Increment generation to signal any running queue to exit
    queueGeneration++;

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
        // New processQueue() will increment generation, causing old queue to exit
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
 * Get internal state for debugging.
 */
export function getSayStatus(): {
  processingQueue: boolean;
  speaking: boolean;
  queueLength: number;
  hasPendingInterrupt: boolean;
  hasActiveProcess: boolean;
  lastSpoken: string;
} {
  return {
    processingQueue,
    speaking,
    queueLength: speechQueue.length,
    hasPendingInterrupt: !!pendingInterrupt,
    hasActiveProcess: !!activeProcess,
    lastSpoken,
  };
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

/**
 * Enable or disable repeat reduction.
 * When enabled (default), strips common prefix/suffix from consecutive texts.
 * Exact duplicates are skipped entirely.
 */
export function setRepeatReduction(enabled: boolean): void {
  repeatReductionEnabled = enabled;
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
