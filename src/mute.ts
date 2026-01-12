import { createListenerRegistry } from './listeners.js';

let hearMuted = false;

// Mute state change listeners
type MuteListener = (muted: boolean) => void;
const listeners = createListenerRegistry<[boolean]>();

/**
 * Register a listener for mute state changes.
 * Returns an unregister function.
 */
export function onMuteChange(listener: MuteListener): () => void {
  return listeners.on(listener);
}

/**
 * Mute or unmute hear() callbacks.
 * When muted, hear() will still run but callbacks are suppressed.
 *
 * @param enabled - true to mute, false to unmute
 */
export function setHearMuted(enabled: boolean): void {
  hearMuted = enabled;
  listeners.emit(enabled);
}

/**
 * Returns true if hear() is currently muted.
 */
export function isHearMuted(): boolean {
  return hearMuted;
}
