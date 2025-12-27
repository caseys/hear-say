import { execSync } from 'node:child_process';

const isMacOS = process.platform === 'darwin';
let hearAvailable: boolean | undefined;
let warnedPlatform = false;
let warnedHear = false;

export function checkPlatform(): boolean {
  if (!isMacOS && !warnedPlatform) {
    warnedPlatform = true;
    console.warn('[hear-say] Warning: This library only works on macOS. Current platform:', process.platform);
  }
  return isMacOS;
}

export function checkHearBinary(): boolean {
  if (!checkPlatform()) return false;

  if (hearAvailable === undefined) {
    try {
      execSync('which hear', { stdio: 'ignore' });
      hearAvailable = true;
    } catch {
      hearAvailable = false;
    }
  }

  if (!hearAvailable && !warnedHear) {
    warnedHear = true;
    console.warn('[hear-say] Warning: "hear" CLI not found. Install with: brew install hear');
    console.warn('[hear-say] See: https://sveinbjorn.org/hear');
  }

  return hearAvailable;
}
