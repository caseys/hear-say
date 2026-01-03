import { doubleMetaphone } from 'phonetics';
import { removeStopwords } from 'stopword';
import { debug as debugLog } from './utilities.js';

function debug(...arguments_: unknown[]): void {
  if (options.debug) {
    debugLog('[phonetic]', ...arguments_);
  }
}

// Types
export interface DictionaryEntry {
  term: string;
  weight?: number;
}

export interface PhoneticCorrectionOptions {
  enabled?: boolean;
  onFinal?: boolean;
  onStreaming?: boolean;
  minScore?: number;
  debug?: boolean;
}

interface InternalDictEntry {
  term: string;
  termLower: string;
  weight: number;
  phonetic: [string, string];
}

// State
let dictionary: InternalDictEntry[] = [];
let options: PhoneticCorrectionOptions = {
  enabled: true,
  onFinal: true,
  onStreaming: true,  // Fast enough to run on all callbacks
  minScore: 0.65,
  debug: false,
};

// Caches
const phoneticCache = new Map<string, [string, string]>();
// Cache: key=wordLower, value=correction or empty string for "no correction found"
const correctionCache = new Map<string, string>();

/**
 * Simple Levenshtein distance implementation.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let index = 0; index <= b.length; index++) {
    matrix[index] = [index];
  }
  for (let index = 0; index <= a.length; index++) {
    matrix[0][index] = index;
  }

  for (let index = 1; index <= b.length; index++) {
    for (let index_ = 1; index_ <= a.length; index_++) {
      matrix[index][index_] = b[index - 1] === a[index_ - 1] ? matrix[index - 1][index_ - 1] : Math.min(
          matrix[index - 1][index_ - 1] + 1,
          matrix[index][index_ - 1] + 1,
          matrix[index - 1][index_] + 1
        );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Get phonetic codes for a word, using cache.
 */
function getPhonetic(word: string): [string, string] {
  const lower = word.toLowerCase();
  const cached = phoneticCache.get(lower);
  if (cached) return cached;

  const codes = doubleMetaphone(lower) as [string, string];
  phoneticCache.set(lower, codes);
  return codes;
}

/**
 * Compute phonetic similarity score between two words.
 */
function phoneticScore(wordCodes: [string, string], dictCodes: [string, string]): number {
  let bestScore = 0;

  for (const c1 of wordCodes) {
    if (!c1) continue;
    for (const c2 of dictCodes) {
      if (!c2) continue;

      if (c1 === c2) {
        bestScore = Math.max(bestScore, 1);
      } else {
        const distribution = levenshtein(c1, c2);
        const maxLength = Math.max(c1.length, c2.length);
        if (maxLength > 0) {
          const sim = 1 - distribution / maxLength;
          bestScore = Math.max(bestScore, sim);
        }
      }
    }
  }

  return bestScore;
}

/**
 * Check if two words are phonetically similar (within threshold).
 */
function isPhoneticallySimilar(wordCodes: [string, string], dictCodes: [string, string]): boolean {
  for (const c1 of wordCodes) {
    if (!c1) continue;
    for (const c2 of dictCodes) {
      if (!c2) continue;
      if (c1 === c2) return true;
      if (levenshtein(c1, c2) <= 2) return true;
    }
  }
  return false;
}

/**
 * Compute combined match score.
 */
function scoreMatch(word: string, wordCodes: [string, string], entry: InternalDictEntry): number {
  const pScore = phoneticScore(wordCodes, entry.phonetic);
  const wordLower = word.toLowerCase();
  const distribution = levenshtein(wordLower, entry.termLower);
  const maxLength = Math.max(wordLower.length, entry.termLower.length);
  const tScore = maxLength > 0 ? 1 - distribution / maxLength : 0;

  // 50% phonetic + 30% text + 20% weight
  return pScore * 0.5 + tScore * 0.3 + entry.weight * 0.2;
}

/**
 * Find best dictionary match for a word.
 * Returns the correction term, or undefined if no correction needed/found.
 */
function findBestMatch(word: string): string | undefined {
  const wordLower = word.toLowerCase();

  // Check correction cache first (empty string means "no correction")
  if (correctionCache.has(wordLower)) {
    const cached = correctionCache.get(wordLower)!;
    return cached === '' ? undefined : cached;
  }

  // Check exact match in dictionary
  for (const entry of dictionary) {
    if (entry.termLower === wordLower) {
      correctionCache.set(wordLower, ''); // No correction needed
      return undefined;
    }
  }

  // Skip very short words
  if (word.length < 3) {
    correctionCache.set(wordLower, '');
    return undefined;
  }

  const wordCodes = getPhonetic(word);
  let bestMatch: InternalDictEntry | undefined;
  let bestScore = 0;

  for (const entry of dictionary) {
    // Filter: only consider phonetically similar words
    if (!isPhoneticallySimilar(wordCodes, entry.phonetic)) {
      continue;
    }

    const score = scoreMatch(word, wordCodes, entry);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  const minScore = options.minScore ?? 0.65;
  if (bestMatch && bestScore >= minScore) {
    debug(`matched "${word}" -> "${bestMatch.term}" (score: ${bestScore.toFixed(3)})`);
    correctionCache.set(wordLower, bestMatch.term);
    return bestMatch.term;
  }

  correctionCache.set(wordLower, '');
  return undefined;
}

/**
 * Set the dictionary for phonetic correction.
 */
export function setDictionary(terms: string[] | DictionaryEntry[]): void {
  // Clear caches when dictionary changes
  phoneticCache.clear();
  correctionCache.clear();

  dictionary = terms.map((item, index) => {
    const term = typeof item === 'string' ? item : item.term;
    const weight = typeof item === 'string'
      ? 1 - (index / (terms.length * 2))
      : (item.weight ?? 1 - (index / (terms.length * 2)));

    return {
      term,
      termLower: term.toLowerCase(),
      weight: Math.max(0, Math.min(1, weight)),
      phonetic: doubleMetaphone(term.toLowerCase()) as [string, string],
    };
  });

  debug(`dictionary set with ${dictionary.length} terms`);
}

/**
 * Configure phonetic correction options.
 */
export function setPhoneticCorrection(options_: PhoneticCorrectionOptions): void {
  options = { ...options, ...options_ };
  debug('options updated:', options);
}

/**
 * Clear caches (call at start of new utterance).
 */
export function clearCaches(): void {
  phoneticCache.clear();
  correctionCache.clear();
}

/**
 * Correct text using phonetic matching against dictionary.
 */
export function correctText(text: string, isFinal: boolean): string {
  // Check if enabled
  if (!options.enabled || dictionary.length === 0) {
    return text;
  }

  // Check if we should process based on final/streaming setting
  if (isFinal && !options.onFinal) {
    return text;
  }
  if (!isFinal && !options.onStreaming) {
    return text;
  }

  // Tokenize preserving structure
  const tokens: Array<{ word: string; isWord: boolean; start: number; end: number }> = [];
  const wordRegex = /\b\w+\b/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;

  while ((match = wordRegex.exec(text)) !== null) {
    // Add any non-word content before this word
    if (match.index > lastEnd) {
      tokens.push({
        word: text.slice(lastEnd, match.index),
        isWord: false,
        start: lastEnd,
        end: match.index,
      });
    }
    tokens.push({
      word: match[0],
      isWord: true,
      start: match.index,
      end: match.index + match[0].length,
    });
    lastEnd = match.index + match[0].length;
  }

  // Add trailing non-word content
  if (lastEnd < text.length) {
    tokens.push({
      word: text.slice(lastEnd),
      isWord: false,
      start: lastEnd,
      end: text.length,
    });
  }

  if (tokens.length === 0) {
    return text;
  }

  // Get word tokens only
  const wordTokens = tokens.filter(t => t.isWord);

  // Skip last word if streaming (may be partial)
  const wordsToProcess = !isFinal && wordTokens.length > 1
    ? wordTokens.slice(0, -1)
    : wordTokens;

  // Identify stopwords
  const words = wordsToProcess.map(t => t.word);
  const filtered = removeStopwords(words) as string[];
  const filteredSet = new Set(filtered.map(w => w.toLowerCase()));

  // Process each word
  const corrections = new Map<number, string>();

  for (const token of wordsToProcess) {
    // Skip if it's a stopword
    if (!filteredSet.has(token.word.toLowerCase())) {
      continue;
    }

    const correction = findBestMatch(token.word);
    if (correction) {
      corrections.set(token.start, correction);
    }
  }

  // Reconstruct with corrections
  if (corrections.size === 0) {
    return text;
  }

  let result = '';
  for (const token of tokens) {
    const correction = corrections.get(token.start);
    result += correction ?? token.word;
  }

  debug(`corrected: "${text}" -> "${result}"`);
  return result;
}

/**
 * Benchmark correction performance.
 */
export function benchmarkCorrection(text: string, iterations: number = 100): { avgMs: number; coldMs: number; warmMs: number } {
  // Cold run (fresh cache)
  clearCaches();
  const coldStart = performance.now();
  correctText(text, true);
  const coldMs = performance.now() - coldStart;

  // Warm runs
  const warmStart = performance.now();
  for (let index = 0; index < iterations - 1; index++) {
    correctText(text, true);
  }
  const warmTotal = performance.now() - warmStart;
  const warmMs = warmTotal / (iterations - 1);

  const avgMs = (coldMs + warmTotal) / iterations;

  return { avgMs, coldMs, warmMs };
}
