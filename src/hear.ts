import { spawn, ChildProcess } from 'node:child_process';
import { isSpeaking, onSayStarted, onSayFinished } from './say.js';

const DEBUG = process.env.HEAR_SAY_DEBUG === '1' || process.env.HEAR_SAY_DEBUG === 'true';

function debug(...arguments_: unknown[]): void {
  if (DEBUG) {
    console.log(...arguments_);
  }
}

type Callback = (text: string, stop: () => void, final: boolean) => void;

let activeProcess: ChildProcess | undefined;
let currentCallback: Callback | undefined;
let silenceTimer: NodeJS.Timeout | undefined;
let lastLine: string = '';
let timeoutDuration: number = 1200;
let shouldRestart: boolean = false;

function killProcess(proc: ChildProcess): void {
  proc.kill('SIGINT');
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 100);
}

function clearSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
  }
}

function cleanup(): void {
  shouldRestart = false;
  currentCallback = undefined;
  clearSilenceTimer();

  if (activeProcess) {
    killProcess(activeProcess);
    activeProcess = undefined;
  }

  lastLine = '';
}

/** Shared stop function passed to callbacks */
function stopListening(): void {
  shouldRestart = false;
  cleanup();
}

function resetSilenceTimer(): void {
  clearSilenceTimer();

  silenceTimer = setTimeout(() => {
    onSilence();
  }, timeoutDuration);
}

function onSilence(): void {
  debug('[hear] onSilence: lastLine?', !!lastLine, 'currentCallback?', !!currentCallback);
  // Only fire if we have accumulated text and a callback
  if (!lastLine || !currentCallback) {
    // Keep timer running if we're still listening
    if (currentCallback && activeProcess) {
      resetSilenceTimer();
    }
    return;
  }

  const text = lastLine;
  debug('[hear] onSilence: text="' + text + '"');
  const callback = currentCallback;

  // Reset for next utterance
  lastLine = '';

  // Kill process first to start respawn immediately (runs in parallel with callback)
  if (shouldRestart && activeProcess) {
    killProcess(activeProcess);
  }

  // Invoke callback with final=true - new process is already spawning
  callback(text, stopListening, true);
}

function startListening(): void {
  debug('[hear] startListening called');
  lastLine = '';
  shouldRestart = true;

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
        lastLine = line;
        resetSilenceTimer();
        // Call callback for each line with final=false
        if (currentCallback) {
          currentCallback(line, stopListening, false);
        }
      }
    }
  });

  activeProcess.on('exit', () => {
    activeProcess = undefined;
    clearSilenceTimer();

    // Restart if we should and have a callback
    if (shouldRestart && currentCallback) {
      startListening();
    }
  });

  // Start silence timer (handles case where hear outputs nothing)
  resetSilenceTimer();
}

export function hear(
  callback: Callback | false,
  timeoutMs: number = 1200
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
    shouldRestart = false;  // Don't auto-restart
    killProcess(activeProcess);
    activeProcess = undefined;
    clearSilenceTimer();
    lastLine = '';
    debug('[hear] killed hear process');
  }
});

// When TTS finishes (say process exits), start hear if callback is waiting
onSayFinished(() => {
  debug('[hear] onSayFinished: currentCallback?', !!currentCallback, 'activeProcess?', !!activeProcess);
  lastLine = '';
  if (currentCallback && !activeProcess) {
    debug('[hear] starting hear after TTS finished');
    startListening();
  }
});
