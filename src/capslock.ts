import { execSync } from 'node:child_process';
import { say } from './say.js';

const DEBUG = process.env.HEAR_SAY_DEBUG === '1' || process.env.HEAR_SAY_DEBUG === 'true';

function debug(...arguments_: unknown[]): void {
  if (DEBUG) {
    console.log('[capslock]', ...arguments_);
  }
}

let capsLockMuteEnabled = false;
let pollInterval: NodeJS.Timeout | undefined;
let currentCapsLockState = false;

/**
 * Check if Caps Lock is currently active using macOS CoreGraphics.
 * Uses JXA (JavaScript for Automation) to call CGEventSourceKeyState.
 */
function checkCapsLock(): boolean {
  try {
    // kCGEventSourceStateHIDSystemState = 0, kVK_CapsLock = 57 (0x39)
    const result = execSync(
      `osascript -l JavaScript -e "ObjC.import('Cocoa'); $.CGEventSourceKeyState(0, 57)"`,
      { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

function startPolling(): void {
  if (pollInterval) return;

  // Check immediately
  currentCapsLockState = checkCapsLock();
  debug('started polling, initial state:', currentCapsLockState);

  // Poll every 250ms
  pollInterval = setInterval(() => {
    const newState = checkCapsLock();
    if (newState !== currentCapsLockState) {
      debug('caps lock changed:', newState ? 'ON (muted)' : 'OFF (unmuted)');
      currentCapsLockState = newState;
      // Announce state change
      say(newState ? 'muted' : 'unmuted', { rude: true });
    }
  }, 250);
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
    debug('stopped polling');
  }
  currentCapsLockState = false;
}

/**
 * Returns true if hear() should be muted (Caps Lock is ON and feature is enabled).
 */
export function isHearMuted(): boolean {
  return capsLockMuteEnabled && currentCapsLockState;
}

/**
 * Enable or disable Caps Lock mute feature.
 * When enabled, hear() will suppress callbacks while Caps Lock is active.
 *
 * @param enabled - true to enable, false to disable
 */
export function setCapsLockMute(enabled: boolean): void {
  if (enabled === capsLockMuteEnabled) return;

  capsLockMuteEnabled = enabled;
  debug('setCapsLockMute:', enabled);

  if (enabled) {
    startPolling();
  } else {
    stopPolling();
  }
}

/**
 * Returns whether the Caps Lock mute feature is currently enabled.
 */
export function isCapsLockMuteEnabled(): boolean {
  return capsLockMuteEnabled;
}

// Cleanup on process exit
process.on('exit', stopPolling);
