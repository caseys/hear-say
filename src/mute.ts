let hearMuted = false;

// Mute state change listeners
type MuteListener = (muted: boolean) => void;
const listeners: MuteListener[] = [];

/**
 * Register a listener for mute state changes.
 * Returns an unregister function.
 */
export function onMuteChange(listener: MuteListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  };
}

/**
 * Mute or unmute hear() callbacks.
 * When muted, hear() will still run but callbacks are suppressed.
 *
 * @param enabled - true to mute, false to unmute
 */
export function setHearMuted(enabled: boolean): void {
  hearMuted = enabled;
  for (const listener of listeners) {
    listener(enabled);
  }
}

/**
 * Returns true if hear() is currently muted.
 */
export function isHearMuted(): boolean {
  return hearMuted;
}
