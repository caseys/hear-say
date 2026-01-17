import { pipeline } from '@xenova/transformers';
import { debug as debugLog } from './utilities.js';

function debug(...arguments_: unknown[]): void {
  debugLog('[punctuate]', ...arguments_);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let punctuatorPromise: Promise<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let punctuator: any;

/**
 * Get or initialize the punctuation restoration pipeline.
 * Lazy-loaded on first use.
 */
async function getPunctuator() {
  if (punctuator) return punctuator;

  if (!punctuatorPromise) {
    debug('loading punctuation model...');
    punctuatorPromise = pipeline(
      'token-classification',
      'ldenoue/fullstop-punctuation-multilang-large',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { aggregation_strategy: 'simple' } as any
    );
  }

  punctuator = await punctuatorPromise;
  debug('punctuation model loaded');
  return punctuator;
}

/**
 * Prewarm the punctuation model (call early to avoid latency on first use).
 */
export async function warmPunctuator(): Promise<void> {
  await getPunctuator();
}

/**
 * Check if the punctuator is loaded and ready.
 */
export function isPunctuatorReady(): boolean {
  return punctuator !== undefined;
}

// Map entity labels to punctuation characters
const PUNCTUATION_MAP: Record<string, string> = {
  '0': '',
  'O': '',
  '.': '.',
  'PERIOD': '.',
  ',': ',',
  'COMMA': ',',
  '?': '?',
  'QUESTION': '?',
  '!': '!',
  ':': ':',
  'COLON': ':',
};

/**
 * Get punctuation from entity label.
 */
function getPunctuation(entity: string): string | undefined {
  let punctuation = PUNCTUATION_MAP[entity];
  if (punctuation === undefined && entity) {
    const upperEntity = entity.toUpperCase();
    if (upperEntity.includes('PERIOD') || upperEntity.includes('FULLSTOP')) {
      punctuation = '.';
    } else if (upperEntity.includes('COMMA')) {
      punctuation = ',';
    } else if (upperEntity.includes('QUESTION')) {
      punctuation = '?';
    } else if (upperEntity.includes('COLON')) {
      punctuation = ':';
    }
  }
  return punctuation;
}

/**
 * Restore punctuation to unpunctuated text.
 * Keeps original text, adds punctuation based on model predictions.
 */
export async function restorePunctuation(text: string): Promise<string> {
  const punct = await getPunctuator();
  const tokens = await punct(text);

  debug('token count:', tokens.length);

  // Split original text into words
  const words = text.split(/\s+/);
  debug('word count:', words.length);

  // Map tokens to words by matching text content
  const wordPunctuation: (string | undefined)[] = Array.from({ length: words.length });
  let tokenIndex = 0;

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex].toLowerCase();
    let accumulated = '';

    // Consume tokens until we've accumulated enough chars to match this word
    while (tokenIndex < tokens.length && accumulated.length < word.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tokens[tokenIndex] as any;
      const tokenWord = (t.word || '').replace(/^##/, '');
      accumulated += tokenWord.toLowerCase();

      const entity = t.entity_group || t.entity || '';
      const p = getPunctuation(entity);

      // If this token has punctuation and it's the last token for this word, apply it
      if (p) {
        wordPunctuation[wordIndex] = p;
        debug('word', wordIndex, `"${words[wordIndex]}"`, 'gets', p, 'from token', tokenWord);
      }

      tokenIndex++;
    }
  }

  // Build result
  let result = words.map((w, i) => w + (wordPunctuation[i] || '')).join(' ');

  // Capitalize first letter
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  debug('final result:', result);
  return result;
}
