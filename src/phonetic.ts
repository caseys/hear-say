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
 * Requires BOTH phonetic similarity AND prefix match for better accuracy.
 */
function isPhoneticallySimilar(
  wordCodes: [string, string],
  dictCodes: [string, string],
  word?: string,
  dictTerm?: string
): boolean {
  // Check prefix match first (required)
  if (!word || !dictTerm) {
    return false;
  }
  const w = word.toLowerCase();
  const t = dictTerm.toLowerCase();
  const hasPrefix = w.length >= 2 && t.length >= 2 && w.slice(0, 2) === t.slice(0, 2);
  if (!hasPrefix) {
    return false;
  }

  // Check phonetic similarity (with relaxed threshold since prefix already matched)
  for (const c1 of wordCodes) {
    if (!c1) continue;
    for (const c2 of dictCodes) {
      if (!c2) continue;
      if (c1 === c2) return true;
      if (levenshtein(c1, c2) <= 2) return true;  // Relaxed from 1 to 2
    }
  }

  return false;
}

/**
 * Prefix bonus: reward matching first 2-3 characters.
 */
function prefixBonus(word: string, term: string): number {
  const w = word.toLowerCase();
  const t = term.toLowerCase();
  if (w.slice(0, 3) === t.slice(0, 3)) return 0.15;
  if (w.slice(0, 2) === t.slice(0, 2)) return 0.08;
  return 0;
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

  // 45% phonetic + 45% text + 10% weight + prefix bonus
  let score = pScore * 0.45 + tScore * 0.45 + entry.weight * 0.1;
  score += prefixBonus(word, entry.term);
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
    if (!isPhoneticallySimilar(wordCodes, entry.phonetic, word, entry.term)) {
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
  wordIndex?: number;  // Index among word tokens only
}

/**
 * Check if consecutive words match a phrase entry.
 */
function matchesPhrase(wordTokens: Token[], startIdx: number, phrase: InternalPhraseEntry): boolean {
  // Bounds check
  if (startIdx + phrase.words.length > wordTokens.length) {
    return false;
  }

  let totalScore = 0;

  for (let j = 0; j < phrase.words.length; j++) {
    const inputWord = wordTokens[startIdx + j].word;
    const inputCodes = getPhonetic(inputWord);
    const phraseCodes = phrase.phonetics[j];

    // Must be phonetically similar (or prefix match)
    if (!isPhoneticallySimilar(inputCodes, phraseCodes, inputWord, phrase.words[j])) {
      return false;
    }

    totalScore += scoreMatch(inputWord, inputCodes, {
      term: phrase.words[j],
      termLower: phrase.wordsLower[j],
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
  for (let i = 0; i < wordTokens.length; i++) {
    // Skip if already part of a longer match
    if (matchedIndices.has(i)) continue;

    for (const phrase of phraseDict) {
      // Check if there are enough remaining words
      if (i + phrase.words.length > wordTokens.length) continue;

      // Check if any position would overlap with existing match
      let hasOverlap = false;
      for (let k = 0; k < phrase.words.length; k++) {
        if (matchedIndices.has(i + k)) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) continue;

      // Check if words match phrase
      if (matchesPhrase(wordTokens, i, phrase)) {
        matches.set(i, { term: phrase.term, wordCount: phrase.words.length });
        // Mark all positions as matched
        for (let k = 0; k < phrase.words.length; k++) {
          matchedIndices.add(i + k);
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

  // Get word tokens only
  const wordTokens = tokens.filter(t => t.isWord);

  // Skip last word if streaming (may be partial)
  const wordsToProcess = !isFinal && wordTokens.length > 1
    ? wordTokens.slice(0, -1)
    : wordTokens;

  // Try phrase matches first (uses wordsToProcess indices)
  const phraseMatches = phraseDict.length > 0 ? findPhraseMatches(wordsToProcess) : new Map();

  // Build set of word indices that are part of phrase matches
  const phraseMatchedIndices = new Set<number>();
  for (const [startIdx, match] of phraseMatches) {
    for (let k = 0; k < match.wordCount; k++) {
      phraseMatchedIndices.add(startIdx + k);
    }
  }

  // Identify stopwords for single-word matching
  const words = wordsToProcess.map(t => t.word);
  const filtered = removeStopwords(words) as string[];
  const filteredSet = new Set(filtered.map(w => w.toLowerCase()));

  // Process single words (skip those in phrase matches)
  const singleCorrections = new Map<number, string>();

  for (let i = 0; i < wordsToProcess.length; i++) {
    const token = wordsToProcess[i];

    // Skip if part of phrase match
    if (phraseMatchedIndices.has(i)) {
      continue;
    }

    // Skip if it's a stopword
    if (!filteredSet.has(token.word.toLowerCase())) {
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
      // Need to check if we're between skipFromWordIndex and skipToWordIndex
      // Look at surrounding word tokens to determine position
      const prevWordToken = tokens.slice(0, tokens.indexOf(token)).reverse().find(t => t.isWord);
      const nextWordToken = tokens.slice(tokens.indexOf(token) + 1).find(t => t.isWord);

      const prevIdx = prevWordToken?.wordIndex ?? -1;
      const nextIdx = nextWordToken?.wordIndex ?? Infinity;

      // Skip if this separator is between words that are both part of the same phrase
      // Both prev and next must be IN the phrase (skipToWordIndex is exclusive)
      if (prevIdx >= skipFromWordIndex && prevIdx < skipToWordIndex &&
          nextIdx >= skipFromWordIndex && nextIdx < skipToWordIndex) {
        continue;
      }

      result += token.word;
      continue;
    }

    const wIdx = token.wordIndex!;

    // Check if we're skipping this word (part of phrase, not the first word)
    if (wIdx > skipFromWordIndex && wIdx < skipToWordIndex) {
      continue;
    }

    // Check if this starts a phrase match
    const processIdx = wordsToProcess.findIndex(t => t.wordIndex === wIdx);
    if (processIdx >= 0 && phraseMatches.has(processIdx)) {
      const match = phraseMatches.get(processIdx)!;
      result += match.term;
      // Set skip range for subsequent words in phrase
      skipFromWordIndex = wIdx;
      const lastPhraseWordIdx = wordsToProcess[processIdx + match.wordCount - 1]?.wordIndex ?? wIdx;
      skipToWordIndex = lastPhraseWordIdx + 1;
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
