# Plan: STT Phonetic Correction for hear-say Library

## Overview
Extract the phonetic STT preprocessing from ollama-tools into hear-say as a reusable module. Clients provide domain-specific word dictionaries, and hear-say corrects STT output using phonetic matching.

By default this will run only on STT (hear) callback results marked 'final'.

## Dictionary Format

### Input: Simple Ordered Word List
Clients provide an array of terms, ordered by importance (most important first):

```typescript
// Simple API - just strings, order = priority
const dictionary = [
  "Microsoft",    // index 0 = highest priority
  "Apple",    // index 1
  "IBM",       // index 2
  "Oracle",  // index 3
  "Adobe", // ...
];

// Or with explicit weights (optional)
interface DictionaryEntry {
  term: string;
  weight?: number;  // 0-1, defaults based on position
}
```

### Weight Calculation
If no explicit weight provided, derive from array position:
```typescript
weight = 1.0 - (index / (dictionary.length * 2))
// First item: 1.0
// Middle item: ~0.75
// Last item: ~0.5
```

This gives a gentle bias toward earlier items without dramatically penalizing later ones.

## Processing Algorithm

### Step 1: Skip Noise Words
Use stopword.js to remove noise from 'final' STT string:
https://github.com/fergiemcdowall/stopword

### Step 2: Tokenize Input
Split STT text into words:
```
"Launch to orbit and return to Carbon"
→ ["Launch", "to", "orbit", "and", "return", "to", "Carbon"]
```

### Step 3: Skip Exact Matches
If word already exists in dictionary (case-insensitive), keep it unchanged.

### Step 4: Find Phonetic Match
For each remaining word, find best dictionary match using:

#### 4a. Phonetic Filter (isPhoneticallySimilar)
```typescript
function isPhoneticallySimilar(word1: string, word2: string): boolean {
  const [p1, s1] = doubleMetaphone(word1);  // Primary, Secondary codes
  const [p2, s2] = doubleMetaphone(word2);

  // Check all code combinations
  for (const c1 of [p1, s1]) {
    for (const c2 of [p2, s2]) {
      if (c1 === c2) return true;
      if (levenshtein(c1, c2) <= 2) return true;  // Allow fuzzy
    }
  }
  return false;
}
```

#### 4b. Score Matches
For all phonetically similar words, compute combined score:
```typescript
score = phoneticScore * 0.5 + textScore * 0.3 + weight * 0.2

// phoneticScore: 0-1 based on phonetic code similarity (dominant factor)
// textScore: 0-1 based on Levenshtein distance of original words (tiebreaker)
// weight: 0-1 from dictionary position/explicit weight (slight priority boost)
```

#### 4c. Minimum Threshold
Only accept matches with score >= 0.65 to avoid weak false positives.

### Step 5: Reconstruct Output
Join corrected tokens back into string.

## Example Flow

```
Input:  "Launch to orbit and return to Carbon"
Dict:   ["Kerbin", "Minmus", "Mun", "orbit", "land"]

Token Processing:
  "Launch"  → skip (noise/common verb)
  "to"      → skip (preposition)
  "orbit"   → skip (exact match in dict)
  "and"     → skip (conjunction)
  "return"  → skip (no phonetic match above threshold)
  "to"      → skip (preposition)
  "Carbon"  → match "Kerbin" (score 0.72)

Output: "Launch to orbit and return to Kerbin"
```

## Scoring Details

### Phonetic Score (40% of total)
Compare Double Metaphone codes using fuzzy matching:
```typescript
function phoneticScore(word1: string, word2: string): number {
  const codes1 = doubleMetaphone(word1);  // [primary, secondary]
  const codes2 = doubleMetaphone(word2);

  let bestScore = 0;
  for (const c1 of codes1) {
    for (const c2 of codes2) {
      if (c1 === c2) {
        bestScore = Math.max(bestScore, 1.0);
      } else {
        const dist = levenshtein(c1, c2);
        const sim = 1 - dist / Math.max(c1.length, c2.length);
        bestScore = Math.max(bestScore, sim);
      }
    }
  }
  return bestScore;
}
```

### Text Score (40% of total)
Levenshtein similarity on original words:
```typescript
function textScore(word1: string, word2: string): number {
  const dist = levenshtein(word1.toLowerCase(), word2.toLowerCase());
  const maxLen = Math.max(word1.length, word2.length);
  return 1 - dist / maxLen;
}
```

### Weight Score (20% of total)
From dictionary position or explicit weight (0-1).

## Dependencies
- `phonetics` npm package - provides `doubleMetaphone()` function
- Built-in Levenshtein distance function

## API for hear-say

```typescript
// Client sets dictionary once (or updates as needed)
hearSay.setDictionary(["Kerbin", "Minmus", "Mun", ...]);

// Or with weights
hearSay.setDictionary([
  { term: "Kerbin", weight: 1.0 },
  { term: "Minmus", weight: 0.9 },
]);

// hear() automatically applies correction to STT output
const result = await hearSay.hear();
// result.text is already corrected
```

## Tunable Parameters

### Configurable Options (with defaults)
```typescript
interface PhoneticCorrectionOptions {
  // Scoring weights (must sum to 1.0)
  phoneticWeight?: number;    // default: 0.5
  textWeight?: number;        // default: 0.3
  dictWeight?: number;        // default: 0.2

  // Thresholds
  minScore?: number;          // default: 0.65 - minimum combined score to accept
  maxPhoneticDist?: number;   // default: 2 - max Levenshtein distance on phonetic codes
  minWordLength?: number;     // default: 3 - skip words shorter than this

  // Debug
  debug?: boolean;            // default: false - log matching decisions
}
```

## Key Design Decisions

1. **Phonetic-first scoring**: 50% phonetic + 30% text + 20% weight keeps phonetic as dominant factor
2. **Order-based priority**: First items in dictionary get slight preference via weight (20%)
3. **Fuzzy phonetic matching**: Allow up to 2 char difference in phonetic codes (catches "Minas" → "Minmus")
4. **Conservative threshold**: 0.65 minimum prevents false positives like "navigate" → "navigation"
5. **Skip exact matches**: Don't "correct" words that are already correct
6. **Skip noise words**: Don't try to match common English words
7. **Configurable**: All key parameters exposed for client tuning

## Files to Create/Modify in hear-say
- Implementation details left to hear-say agent
- This plan defines the algorithm and data structures
