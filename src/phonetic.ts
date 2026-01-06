import { createRequire } from 'node:module';
import { doubleMetaphone } from 'phonetics';
import { syllable } from 'syllable';
import { debug as debugLog } from './utilities.js';

// Load stopwords-en (JSON module)
const require = createRequire(import.meta.url);
const stopwordsEn: string[] = require('stopwords-en');
const stopwordSet = new Set(stopwordsEn.map((w: string) => w.toLowerCase()));

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

interface InternalPhraseEntry {
  term: string;           // Original term e.g., "match_planes"
  words: string[];        // Split words e.g., ["match", "planes"]
  wordsLower: string[];   // Lowercase words
  weight: number;
  phonetics: [string, string][];  // Phonetic codes for each word
}

// State
let singleWordDict: InternalDictEntry[] = [];
let phraseDict: InternalPhraseEntry[] = [];
// Keep original dictionary reference for backward compat
let dictionary: InternalDictEntry[] = [];
// Known words from phrases (for exact-match only, not phonetic matching)
let knownWordsFromPhrases: Set<string> = new Set();
let options: PhoneticCorrectionOptions = {
  enabled: true,
  onFinal: true,
  onStreaming: true,  // Fast enough to run on all callbacks
  minScore: 0.72,
  debug: false,
};

// Caches
const phoneticCache = new Map<string, [string, string]>();
// Cache: key=wordLower, value=correction or empty string for "no correction found"
const correctionCache = new Map<string, string>();
// Cache: key=wordLower, value=syllable count
const syllableCache = new Map<string, number>();

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
function isPhoneticallySimilar(
  wordCodes: [string, string],
  dictCodes: [string, string]
): boolean {
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
 * Prefix bonus: reward matching prefixes (mutually exclusive, pick highest).
 * - 3-char text prefix: +0.10
 * - 2-char text prefix: +0.075
 * - 1-char phonetic prefix: +0.05
 */
function prefixBonus(word: string, term: string, wordCodes: [string, string], termCodes: [string, string]): number {
  const w = word.toLowerCase();
  const t = term.toLowerCase();

  // Check text prefix (highest priority)
  if (w.slice(0, 3) === t.slice(0, 3)) return 0.1;
  if (w.slice(0, 2) === t.slice(0, 2)) return 0.075;

  // Fall back to phonetic prefix
  for (const c1 of wordCodes) {
    if (!c1) continue;
    for (const c2 of termCodes) {
      if (!c2) continue;
      if (c1[0] === c2[0]) return 0.05;
    }
  }
  return 0;
}

/**
 * Get syllable count with caching.
 */
function getSyllableCount(word: string): number {
  const lower = word.toLowerCase();
  if (!syllableCache.has(lower)) {
    syllableCache.set(lower, syllable(lower));
  }
  return syllableCache.get(lower)!;
}

/**
 * Syllable bonus: reward matching syllable count.
 * Skip for single-syllable words - too common to be useful.
 */
function syllableBonus(word: string, term: string): number {
  const wordSyllables = getSyllableCount(word);
  const termSyllables = getSyllableCount(term);
  if (wordSyllables === 1 && termSyllables === 1) return 0;
  return wordSyllables === termSyllables ? 0.1 : 0;
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

  // 50% phonetic + 40% text + 5% weight + bonuses
  let score = pScore * 0.50 + tScore * 0.40 + entry.weight * 0.05;
  score += prefixBonus(word, entry.term, wordCodes, entry.phonetic);
  score += syllableBonus(word, entry.term);

  // Dominance bonus: reward when phonetic >> text (true phonetic match)
  if (pScore - tScore > 0.3) {
    score += 0.05;
  }

  return score;
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

  // Check if word is a known component from phrases (exact match only)
  if (knownWordsFromPhrases.has(wordLower)) {
    correctionCache.set(wordLower, ''); // No correction needed
    return undefined;
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
    // Filter: only consider phonetically similar words (or prefix matches)
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

// Token type for phrase matching
interface Token {
  word: string;
  isWord: boolean;
  start: number;
  end: number;
  wordIndex?: number;      // Index among word tokens only
  prevWordToken?: Token;   // Direct reference to previous word token
  nextWordToken?: Token;   // Direct reference to next word token
}

/**
 * Check if consecutive words match a phrase entry.
 */
function matchesPhrase(wordTokens: Token[], startIndex: number, phrase: InternalPhraseEntry): boolean {
  // Bounds check
  if (startIndex + phrase.words.length > wordTokens.length) {
    return false;
  }

  let totalScore = 0;

  for (let index = 0; index < phrase.words.length; index++) {
    const inputWord = wordTokens[startIndex + index].word;
    const inputCodes = getPhonetic(inputWord);
    const phraseCodes = phrase.phonetics[index];

    // Must be phonetically similar (or prefix match)
    if (!isPhoneticallySimilar(inputCodes, phraseCodes)) {
      return false;
    }

    totalScore += scoreMatch(inputWord, inputCodes, {
      term: phrase.words[index],
      termLower: phrase.wordsLower[index],
      weight: phrase.weight,
      phonetic: phraseCodes,
    });
  }

  // Average score must meet threshold
  const avgScore = totalScore / phrase.words.length;
  return avgScore >= (options.minScore ?? 0.65);
}

/**
 * Find phrase matches in word tokens.
 * Returns map from word index to { term, wordCount }.
 */
function findPhraseMatches(
  wordTokens: Token[]
): Map<number, { term: string; wordCount: number }> {
  const matches = new Map<number, { term: string; wordCount: number }>();
  const matchedIndices = new Set<number>();

  // phraseDict is already sorted by word count descending
  for (let index = 0; index < wordTokens.length; index++) {
    // Skip if already part of a longer match
    if (matchedIndices.has(index)) continue;

    for (const phrase of phraseDict) {
      // Check if there are enough remaining words
      if (index + phrase.words.length > wordTokens.length) continue;

      // Check if any position would overlap with existing match
      let hasOverlap = false;
      for (let k = 0; k < phrase.words.length; k++) {
        if (matchedIndices.has(index + k)) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) continue;

      // Check if words match phrase
      if (matchesPhrase(wordTokens, index, phrase)) {
        matches.set(index, { term: phrase.term, wordCount: phrase.words.length });
        // Mark all positions as matched
        for (let k = 0; k < phrase.words.length; k++) {
          matchedIndices.add(index + k);
        }
        break;  // Found match, move to next position
      }
    }
  }

  return matches;
}

/**
 * Set the dictionary for phonetic correction.
 */
export function setDictionary(terms: string[] | DictionaryEntry[]): void {
  // Clear caches when dictionary changes
  phoneticCache.clear();
  correctionCache.clear();

  // Reset dictionaries
  singleWordDict = [];
  phraseDict = [];

  for (let index = 0; index < terms.length; index++) {
    const item = terms[index];
    const term = typeof item === 'string' ? item : item.term;
    const weight = typeof item === 'string'
      ? 1 - (index / (terms.length * 2))
      : (item.weight ?? 1 - (index / (terms.length * 2)));
    const normalizedWeight = Math.max(0, Math.min(1, weight));

    // Split on underscore or space to detect phrases
    const words = term.split(/[_\s]+/).filter(w => w.length > 0);

    if (words.length >= 2) {
      // Multi-word phrase entry
      phraseDict.push({
        term,
        words,
        wordsLower: words.map(w => w.toLowerCase()),
        weight: normalizedWeight,
        phonetics: words.map(w => doubleMetaphone(w.toLowerCase()) as [string, string]),
      });
    } else {
      // Single word entry
      singleWordDict.push({
        term,
        termLower: term.toLowerCase(),
        weight: normalizedWeight,
        phonetic: doubleMetaphone(term.toLowerCase()) as [string, string],
      });
    }
  }

  // Build set of known words from phrases (for exact-match only)
  // This prevents "planes" from being corrected when "match_planes" is in dictionary
  knownWordsFromPhrases = new Set();
  for (const phrase of phraseDict) {
    for (const wordLower of phrase.wordsLower) {
      knownWordsFromPhrases.add(wordLower);
    }
  }

  // Keep dictionary pointing to singleWordDict for backward compat
  dictionary = singleWordDict;

  // Sort phrases by word count descending (longest first for matching)
  phraseDict.sort((a, b) => b.words.length - a.words.length);

  debug(`dictionary set: ${singleWordDict.length} single words, ${phraseDict.length} phrases`);
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
  syllableCache.clear();
}

/**
 * Correct text using phonetic matching against dictionary.
 */
export function correctText(text: string, isFinal: boolean): string {
  // Check if enabled
  if (!options.enabled || (singleWordDict.length === 0 && phraseDict.length === 0)) {
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
  const tokens: Token[] = [];
  const wordRegex = /\b\w+\b/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  let wordIndex = 0;

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
      wordIndex: wordIndex++,
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

  // Build prev/next word token references (O(n) once, enables O(1) lookups)
  // First pass: link word tokens to each other
  let lastWordToken: Token | undefined;
  for (const token of tokens) {
    if (token.isWord) {
      if (lastWordToken) {
        lastWordToken.nextWordToken = token;
        token.prevWordToken = lastWordToken;
      }
      lastWordToken = token;
    }
  }
  // Second pass: set prev/next word refs on non-word tokens
  lastWordToken = undefined;
  for (const token of tokens) {
    if (token.isWord) {
      lastWordToken = token;
    } else {
      token.prevWordToken = lastWordToken;
      token.nextWordToken = lastWordToken?.nextWordToken;
    }
  }

  // Get word tokens only
  const wordTokens = tokens.filter(t => t.isWord);

  // Skip last word if streaming (may be partial)
  const wordsToProcess = !isFinal && wordTokens.length > 1
    ? wordTokens.slice(0, -1)
    : wordTokens;

  // Build wordIndex -> processIdx map for O(1) lookup
  const wordIndexToProcessIndex = new Map<number, number>();
  for (const [index, element] of wordsToProcess.entries()) {
    wordIndexToProcessIndex.set(element.wordIndex!, index);
  }

  // Try phrase matches first (uses wordsToProcess indices)
  const phraseMatches = phraseDict.length > 0 ? findPhraseMatches(wordsToProcess) : new Map();

  // Build set of word indices that are part of phrase matches
  const phraseMatchedIndices = new Set<number>();
  for (const [startIndex, match] of phraseMatches) {
    for (let k = 0; k < match.wordCount; k++) {
      phraseMatchedIndices.add(startIndex + k);
    }
  }

  // Identify non-stopwords for single-word matching
  const nonStopwords = new Set(
    wordsToProcess
      .map(t => t.word.toLowerCase())
      .filter(w => !stopwordSet.has(w))
  );

  // Process single words (skip those in phrase matches)
  const singleCorrections = new Map<number, string>();

  for (const [index, token] of wordsToProcess.entries()) {

    // Skip if part of phrase match
    if (phraseMatchedIndices.has(index)) {
      continue;
    }

    // Skip if it's a stopword
    if (!nonStopwords.has(token.word.toLowerCase())) {
      continue;
    }

    const correction = findBestMatch(token.word);
    if (correction) {
      singleCorrections.set(token.start, correction);
    }
  }

  // Reconstruct with corrections
  if (phraseMatches.size === 0 && singleCorrections.size === 0) {
    return text;
  }

  let result = '';
  // Track which wordIndex range we're skipping (for phrase matches)
  let skipFromWordIndex = -1;
  let skipToWordIndex = -1;  // exclusive

  for (const token of tokens) {
    if (!token.isWord) {
      // Non-word content: skip only if between phrase words
      // Use O(1) prev/next references instead of O(n) indexOf + slice
      const previousIndex = token.prevWordToken?.wordIndex ?? -1;
      const nextIndex = token.nextWordToken?.wordIndex ?? Infinity;

      // Skip if this separator is between words that are both part of the same phrase
      // Both prev and next must be IN the phrase (skipToWordIndex is exclusive)
      if (previousIndex >= skipFromWordIndex && previousIndex < skipToWordIndex &&
          nextIndex >= skipFromWordIndex && nextIndex < skipToWordIndex) {
        continue;
      }

      result += token.word;
      continue;
    }

    const wIndex = token.wordIndex!;

    // Check if we're skipping this word (part of phrase, not the first word)
    if (wIndex > skipFromWordIndex && wIndex < skipToWordIndex) {
      continue;
    }

    // Check if this starts a phrase match (O(1) lookup instead of O(n) findIndex)
    const processIndex = wordIndexToProcessIndex.get(wIndex) ?? -1;
    if (processIndex >= 0 && phraseMatches.has(processIndex)) {
      const match = phraseMatches.get(processIndex)!;
      result += match.term;
      // Set skip range for subsequent words in phrase
      skipFromWordIndex = wIndex;
      const lastPhraseWordIndex = wordsToProcess[processIndex + match.wordCount - 1]?.wordIndex ?? wIndex;
      skipToWordIndex = lastPhraseWordIndex + 1;
      continue;
    }

    // Single word: apply correction or keep original
    const correction = singleCorrections.get(token.start);
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
