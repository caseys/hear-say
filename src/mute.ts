let hearMuted = false;

/**
 * Mute or unmute hear() callbacks.
 * When muted, hear() will still run but callbacks are suppressed.
 *
 * @param enabled - true to mute, false to unmute
 */
export function setHearMuted(enabled: boolean): void {
  hearMuted = enabled;
}

/**
 * Returns true if hear() is currently muted.
 */
export function isHearMuted(): boolean {
  return hearMuted;
}
