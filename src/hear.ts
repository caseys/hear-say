import { spawn, ChildProcess } from 'node:child_process';
import { isSpeaking, onSayStarted, onSayFinished, onSayGapStart, onSayGapEnd, signalGapSpeechComplete } from './say.js';
import { killProcess, debug as debugLog } from './utilities.js';
import { isHearMuted, onMuteChange } from './mute.js';
import { correctText, clearCaches } from './phonetic.js';

function debug(...arguments_: unknown[]): void {
  debugLog('[hear]', ...arguments_);
}

type Callback = (text: string, stop: () => void, final: boolean) => void;

// Core state
let activeProcess: ChildProcess | undefined;
let currentCallback: Callback | undefined;
let silenceTimer: NodeJS.Timeout | undefined;
let lastTranscribedText: string = '';
let timeoutDuration: number = 2500;
let shouldContinueListening: boolean = false;
let inGap: boolean = false;
let suppressCallbacks: boolean = false;

// Generation token - incremented on every intentional stop to invalidate stale exit handlers
let hearGeneration: number = 0;

// Gap listener unregister functions (only registered when hear() is active)
let unregisterGapStart: (() => void) | undefined;
let unregisterGapEnd: (() => void) | undefined;

function clearSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
  }
}

/**
 * Centralized helper to stop the active hear process.
 * Bumps the generation token to invalidate any pending exit handlers.
 */
function stopActiveProcess(): void {
  debug('[hear] stopActiveProcess: gen', hearGeneration, '->', hearGeneration + 1);
  shouldContinueListening = false;
  suppressCallbacks = true;
  hearGeneration++;  // Invalidate any pending exit handlers

  if (activeProcess) {
    killProcess(activeProcess);
    activeProcess = undefined;  // Clear immediately so scheduleRestart() can work
  }
  clearSilenceTimer();
  lastTranscribedText = '';
}

/**
 * Centralized helper to restart hearing if conditions allow.
 * Checks generation token to avoid races with stopActiveProcess().
 */
function scheduleRestart(): void {
  const myGeneration = hearGeneration;
  debug('[hear] scheduleRestart: gen', myGeneration, 'activeProcess?', !!activeProcess, 'speaking?', isSpeaking(), 'muted?', isHearMuted(), 'callback?', !!currentCallback);

  // Don't restart if already listening, speaking, or muted
  if (activeProcess || isSpeaking() || isHearMuted()) {
    return;
  }

  // Don't restart if no callback registered
  if (!currentCallback) {
    return;
  }

  // Verify generation hasn't changed (something else stopped us)
  if (myGeneration !== hearGeneration) {
    debug('[hear] scheduleRestart: generation changed, aborting');
    return;
  }

  debug('[hear] scheduleRestart: starting');
  startListening();
}

function cleanup(): void {
  stopActiveProcess();
  suppressCallbacks = false;  // Reset after stop
  currentCallback = undefined;

  // Unregister gap listeners
  if (unregisterGapStart) {
    unregisterGapStart();
    unregisterGapStart = undefined;
  }
  if (unregisterGapEnd) {
    unregisterGapEnd();
    unregisterGapEnd = undefined;
  }
}

/** Shared stop function passed to callbacks */
function stopListening(): void {
  cleanup();
}

function resetSilenceTimer(): void {
  clearSilenceTimer();

  silenceTimer = setTimeout(() => {
    onSilence();
  }, timeoutDuration);
}

function onSilence(): void {
  debug('[hear] onSilence: lastTranscribedText?', !!lastTranscribedText, 'currentCallback?', !!currentCallback, 'muted?', isHearMuted(), 'suppressed?', suppressCallbacks);
  // Only fire if we have accumulated text and a callback, and not suppressed
  if (!lastTranscribedText || !currentCallback || suppressCallbacks) {
    // Keep timer running if we're still listening
    if (currentCallback && activeProcess) {
      resetSilenceTimer();
    }
    return;
  }

  const text = lastTranscribedText;
  debug('[hear] onSilence: text="' + text + '"');
  const callback = currentCallback;

  // Reset for next utterance
  lastTranscribedText = '';

  // Kill process first to start respawn immediately (runs in parallel with callback)
  if (shouldContinueListening && activeProcess) {
    killProcess(activeProcess);
  }

  // Skip callback if muted (Caps Lock active)
  if (isHearMuted()) {
    debug('[hear] onSilence: muted, discarding text');
    return;
  }

  // Invoke callback with final=true - new process is already spawning
  callback(correctText(text, true), stopListening, true);

  // If we're in a gap and speech was captured, signal completion
  if (inGap) {
    debug('[hear] signaling gap speech complete');
    signalGapSpeechComplete();
  }
}

function startListening(): void {
  const myGeneration = hearGeneration;  // Capture current generation
  debug('[hear] startListening: gen', myGeneration);

  lastTranscribedText = '';
  shouldContinueListening = true;
  suppressCallbacks = false;  // Re-enable callbacks when intentionally starting
  clearCaches(); // Fresh phonetic caches for new utterance

  activeProcess = spawn('hear', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const proc = activeProcess;  // Capture reference for closures

  // Drain stderr to prevent blocking
  proc.stderr?.resume();

  // Handle errors (e.g., missing binary)
  proc.on('error', () => {
    if (proc === activeProcess) {
      activeProcess = undefined;
    }
    clearSilenceTimer();
  });

  let lineBuffer = '';

  proc.stdout!.on('data', (chunk: Buffer) => {
    // Ignore data from stale processes
    if (myGeneration !== hearGeneration) {
      return;
    }

    // Handle partial chunks
    lineBuffer += chunk.toString();

    // Process complete lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        lastTranscribedText = line;
        resetSilenceTimer();
        // Call callback for each line with final=false (skip if muted or suppressed)
        if (currentCallback && !isHearMuted() && !suppressCallbacks) {
          currentCallback(correctText(line, false), stopListening, false);
        }
      }
    }
  });

  proc.on('exit', () => {
    // Only do cleanup if this is still our process (not superseded)
    if (proc === activeProcess) {
      activeProcess = undefined;
      clearSilenceTimer();  // Only clear OUR timer, not a new process's timer
    }

    // Don't auto-restart if generation changed (intentional stop)
    if (myGeneration !== hearGeneration) {
      debug('[hear] skipping restart (gen mismatch:', myGeneration, '!==', hearGeneration, ')');
      return;
    }

    // Auto-restart only if explicitly requested (shouldContinueListening)
    if (shouldContinueListening && currentCallback && !isHearMuted()) {
      startListening();
    }
  });

  // Start silence timer (handles case where hear outputs nothing)
  resetSilenceTimer();
}

export function hear(
  callback: Callback | false,
  timeoutMs: number = 2500
): void {
  debug('[hear] hear() called: callback?', callback !== false, 'activeProcess?', !!activeProcess, 'isSpeaking?', isSpeaking());

  // Stop listening
  if (callback === false) {
    cleanup();
    return;
  }

  // Update timeout and callback
  const timeoutChanged = timeoutDuration !== timeoutMs;
  timeoutDuration = timeoutMs;
  currentCallback = callback;

  // Register gap listeners if not already registered
  if (!unregisterGapStart) {
    unregisterGapStart = onSayGapStart(() => {
      debug('[hear] onSayGapStart');
      inGap = true;
      lastTranscribedText = '';
      scheduleRestart();
    });
    unregisterGapEnd = onSayGapEnd(() => {
      debug('[hear] onSayGapEnd');
      inGap = false;
      stopActiveProcess();
    });
  }

  // If already listening, just replace callback (hot-swap) and re-arm timer if timeout changed
  if (activeProcess) {
    debug('[hear] hot-swapping callback');
    if (timeoutChanged) {
      resetSilenceTimer();
    }
    return;
  }

  // If TTS is playing, just wait - onSayFinished will start hear
  if (isSpeaking()) {
    debug('[hear] TTS active, waiting for onSayFinished');
    return;
  }

  // Start fresh listening session
  startListening();
}

// Cleanup on process exit
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

// When TTS starts, stop hearing
onSayStarted(() => {
  debug('[hear] onSayStarted');
  stopActiveProcess();
});

// When TTS finishes, restart hearing if callback is waiting
onSayFinished(() => {
  debug('[hear] onSayFinished');
  inGap = false;
  scheduleRestart();
});

// Stop/start hear process based on mute state
onMuteChange((muted) => {
  debug('[hear] onMuteChange:', muted);
  if (muted) {
    stopActiveProcess();
  } else {
    scheduleRestart();
  }
});
