import { debug as debugLog } from './utilities.js';
import { splitSentences } from './segment.js';
import { restorePunctuation, warmPunctuator } from './punctuate.js';

function debug(...arguments_: unknown[]): void {
  debugLog('[segpunc]', ...arguments_);
}

// Configuration - enabled by default, controllable via env or API
let segpuncEnabled = process.env.SEGPUNC !== '0' && process.env.SEGPUNC !== 'false';

// Start loading immediately if enabled
if (segpuncEnabled) {
  warmPunctuator();
}

/**
 * Enable or disable segpunc processing.
 */
export function setSegpuncEnabled(enabled: boolean): void {
  const wasEnabled = segpuncEnabled;
  segpuncEnabled = enabled;
  debug('segpunc enabled:', enabled);

  // If just enabled, start warming up
  if (enabled && !wasEnabled) {
    warmPunctuator();
  }
}

/**
 * Check if segpunc is enabled.
 */
export function isSegpuncEnabled(): boolean {
  return segpuncEnabled;
}

/**
 * Prewarm the segpunc system (loads punctuation model).
 */
export async function warmSegpunc(): Promise<void> {
  if (!segpuncEnabled) {
    debug('segpunc disabled, skipping warmup');
    return;
  }
  await warmPunctuator();
}

/**
 * Capitalize the first character of a string.
 */
function capitalizeFirst(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Process text with punctuation restoration and sentence segmentation.
 * For short inputs (4 words or less), just capitalizes first character.
 */
export async function processSegpunc(text: string): Promise<string> {
  if (!segpuncEnabled) {
    return text;
  }

  debug('processing:', text);

  // Short-circuit for 4 words or less: just capitalize
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 4) {
    const result = capitalizeFirst(text);
    debug('short input, capitalized:', result);
    return result;
  }

  // Full processing for longer input
  const processed = await restorePunctuation(text);
  debug('punctuated:', processed);

  // Split into sentences, capitalize each, then rejoin
  const sentences = splitSentences(processed).map((s) => capitalizeFirst(s));
  if (sentences.length > 1) {
    debug('sentences:', sentences);
  }

  const result = sentences.join(' ');
  debug('result:', result);

  return result;
}

// Re-export utilities for public API
export { splitSentences } from './segment.js';
