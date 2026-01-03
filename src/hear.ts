import { spawn, ChildProcess } from 'node:child_process';
import { isSpeaking, onSayStarted, onSayFinished, onSayGapStart, onSayGapEnd, signalGapSpeechComplete } from './say.js';
import { killProcess, debug as debugLog } from './utilities.js';
import { isHearMuted } from './mute.js';
import { correctText, clearCaches } from './phonetic.js';

function debug(...arguments_: unknown[]): void {
  debugLog('[hear]', ...arguments_);
}

type Callback = (text: string, stop: () => void, final: boolean) => void;

let activeProcess: ChildProcess | undefined;
let currentCallback: Callback | undefined;
let silenceTimer: NodeJS.Timeout | undefined;
let lastTranscribedText: string = '';
let timeoutDuration: number = 2500;
let shouldContinueListening: boolean = false;
let inGap: boolean = false;

// Gap listener unregister functions (only registered when hear() is active)
let unregisterGapStart: (() => void) | undefined;
let unregisterGapEnd: (() => void) | undefined;

function clearSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
  }
}

function cleanup(): void {
  shouldContinueListening = false;
  currentCallback = undefined;
  clearSilenceTimer();

  if (activeProcess) {
    killProcess(activeProcess);
    activeProcess = undefined;
  }

  lastTranscribedText = '';

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
  shouldContinueListening = false;
  cleanup();
}

function resetSilenceTimer(): void {
  clearSilenceTimer();

  silenceTimer = setTimeout(() => {
    onSilence();
  }, timeoutDuration);
}

function onSilence(): void {
  debug('[hear] onSilence: lastTranscribedText?', !!lastTranscribedText, 'currentCallback?', !!currentCallback, 'muted?', isHearMuted());
  // Only fire if we have accumulated text and a callback
  if (!lastTranscribedText || !currentCallback) {
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
  debug('[hear] startListening called');
  lastTranscribedText = '';
  shouldContinueListening = true;
  clearCaches(); // Fresh phonetic caches for new utterance

  activeProcess = spawn('hear', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Drain stderr to prevent blocking
  activeProcess.stderr?.resume();

  // Handle errors (e.g., missing binary)
  activeProcess.on('error', () => {
    activeProcess = undefined;
    clearSilenceTimer();
  });

  let lineBuffer = '';

  activeProcess.stdout!.on('data', (chunk: Buffer) => {
    // Handle partial chunks
    lineBuffer += chunk.toString();

    // Process complete lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        lastTranscribedText = line;
        resetSilenceTimer();
        // Call callback for each line with final=false (skip if muted)
        if (currentCallback && !isHearMuted()) {
          currentCallback(correctText(line, false), stopListening, false);
        }
      }
    }
  });

  activeProcess.on('exit', () => {
    activeProcess = undefined;
    clearSilenceTimer();

    // Restart if we should and have a callback
    if (shouldContinueListening && currentCallback) {
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
      debug('[hear] onSayGapStart: currentCallback?', !!currentCallback, 'activeProcess?', !!activeProcess);
      inGap = true;
      lastTranscribedText = '';
      if (currentCallback && !activeProcess) {
        debug('[hear] starting hear during gap');
        startListening();
      }
    });
    unregisterGapEnd = onSayGapEnd(() => {
      debug('[hear] onSayGapEnd: activeProcess?', !!activeProcess);
      inGap = false;
      if (activeProcess) {
        shouldContinueListening = false;  // Don't auto-restart
        killProcess(activeProcess);
        activeProcess = undefined;
        clearSilenceTimer();
        lastTranscribedText = '';
        debug('[hear] killed hear process at gap end');
      }
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

// When TTS starts, stop hearing (caller will start hear() again when ready)
onSayStarted(() => {
  debug('[hear] onSayStarted: activeProcess?', !!activeProcess);
  if (activeProcess) {
    shouldContinueListening = false;  // Don't auto-restart
    killProcess(activeProcess);
    activeProcess = undefined;
    clearSilenceTimer();
    lastTranscribedText = '';
    debug('[hear] killed hear process');
  }
});

// When TTS finishes (say process exits), start hear if callback is waiting
onSayFinished(() => {
  debug('[hear] onSayFinished: currentCallback?', !!currentCallback, 'activeProcess?', !!activeProcess);
  lastTranscribedText = '';
  inGap = false;
  if (currentCallback && !activeProcess) {
    debug('[hear] starting hear after TTS finished');
    startListening();
  }
});
