import { spawn, ChildProcess } from 'node:child_process';
import { getLastSpoken, isSpeaking, onSayStarted, onSayFinished } from './say.js';

const DEBUG = process.env.HEAR_SAY_DEBUG === '1' || process.env.HEAR_SAY_DEBUG === 'true';

function debug(...arguments_: unknown[]): void {
  if (DEBUG) {
    console.log(...arguments_);
  }
}

type Callback = (text: string, stop: () => void) => void;

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

function normalize(s: string): string {
  return s.toLowerCase().replaceAll(/[^\w\s]/g, '').trim();
}

const MATCH_THRESHOLD = 0.7;
const BOUNDARY_WORDS = 3; // Last N words must match at TTS/user boundary

// Check if spokenTokens appear as a subsequence in heardSlice
// Returns which spoken indices were matched
function findSubsequenceMatches(spokenTokens: string[], heardSlice: string[]): Set<number> {
  const matched = new Set<number>();
  if (spokenTokens.length === 0) return matched;

  let spokenIndex = 0;
  for (const heardToken of heardSlice) {
    if (heardToken === spokenTokens[spokenIndex]) {
      matched.add(spokenIndex);
      spokenIndex++;
      if (spokenIndex === spokenTokens.length) break;
    }
  }

  return matched;
}

// Check if the boundary words (last N for start match, first N for end match) are mostly matched
function boundaryMatches(spokenTokens: string[], matched: Set<number>, atStart: boolean): boolean {
  const boundaryCount = Math.min(BOUNDARY_WORDS, Math.ceil(spokenTokens.length / 3));
  let boundaryHits = 0;

  if (atStart) {
    // For start match (TTS then user), check LAST words of spoken phrase
    for (let index = spokenTokens.length - boundaryCount; index < spokenTokens.length; index++) {
      if (matched.has(index)) boundaryHits++;
    }
  } else {
    // For end match (user then TTS), check FIRST words of spoken phrase
    for (let index = 0; index < boundaryCount; index++) {
      if (matched.has(index)) boundaryHits++;
    }
  }

  // Require at least 2/3 of boundary words to match
  return boundaryHits >= Math.ceil(boundaryCount * 0.66);
}

function filterSpokenText(heard: string): string {
  const spoken = getLastSpoken();
  if (!spoken) return heard;

  const spokenTokens = normalize(spoken).split(/\s+/);
  const heardTokens = normalize(heard).split(/\s+/);
  const originalWords = heard.trim().split(/\s+/);

  // Allow some buffer for inserted words (e.g., "um", "uh", or STT errors)
  const windowSize = Math.min(
    heardTokens.length,
    Math.ceil(spokenTokens.length * 1.3)
  );

  // Check if heard STARTS with the spoken tokens (fuzzy)
  const startSlice = heardTokens.slice(0, windowSize);
  const startMatched = findSubsequenceMatches(spokenTokens, startSlice);
  const startRatio = startMatched.size / spokenTokens.length;

  // Must meet threshold AND have boundary words match (last words of TTS)
  if (startRatio >= MATCH_THRESHOLD && boundaryMatches(spokenTokens, startMatched, true)) {
    // Find where the match actually ends in heard tokens
    let removeCount = 0;
    let matchIndex = 0;
    for (let index = 0; index < heardTokens.length && matchIndex < spokenTokens.length; index++) {
      if (heardTokens[index] === spokenTokens[matchIndex]) {
        matchIndex++;
      }
      removeCount = index + 1;
    }
    return originalWords.slice(removeCount).join(' ');
  }

  // Check if heard ENDS with the spoken tokens (fuzzy)
  const endStart = Math.max(0, heardTokens.length - windowSize);
  const endSlice = heardTokens.slice(endStart);
  const endMatched = findSubsequenceMatches(spokenTokens, endSlice);
  const endRatio = endMatched.size / spokenTokens.length;

  // Must meet threshold AND have boundary words match (first words of TTS)
  if (endRatio >= MATCH_THRESHOLD && boundaryMatches(spokenTokens, endMatched, false)) {
    // Find where the match starts in heard tokens (from the end)
    let keepCount = heardTokens.length;
    let matchIndex = spokenTokens.length - 1;
    for (let index = heardTokens.length - 1; index >= 0 && matchIndex >= 0; index--) {
      if (heardTokens[index] === spokenTokens[matchIndex]) {
        matchIndex--;
      }
      keepCount = index;
    }
    return originalWords.slice(0, keepCount).join(' ');
  }

  return heard;
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

  const text = filterSpokenText(lastLine);
  debug('[hear] onSilence: raw="' + lastLine + '" filtered="' + text + '"');
  const callback = currentCallback;

  // If nothing left after filtering, don't fire callback
  if (!text.trim()) {
    return;
  }

  // Reset for next utterance
  lastLine = '';

  // Kill process first to start respawn immediately (runs in parallel with callback)
  if (shouldRestart && activeProcess) {
    killProcess(activeProcess);
  }

  // Create stop function
  const stop = () => {
    shouldRestart = false;  // Prevent restart if already in progress
    cleanup();
  };

  // Invoke callback - new process is already spawning
  callback(text, stop);
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
