# Phonetic Dictionary for STT Correction

hear-say can automatically correct speech-to-text output using phonetic matching against a domain-specific dictionary.

## Basic Usage

```typescript
import { setDictionary, hear } from 'hear-say';

// Set your domain terms (order = priority)
setDictionary(['Kerbin', 'Minmus', 'Mun', 'apoapsis', 'periapsis']);

// hear() callbacks now receive corrected text
hear((text, stop, final) => {
  // "Carbon" becomes "Kerbin"
  // "Minas" becomes "Minmus"
  console.log(text);
});
```

## Dictionary Format

### Simple string array (recommended)

```typescript
setDictionary(['Kerbin', 'Minmus', 'Mun', 'Duna', 'Eve']);
```

Order matters - earlier items get slight priority in close matches.

### With explicit weights

```typescript
setDictionary([
  { term: 'Kerbin', weight: 1.0 },
  { term: 'Minmus', weight: 0.9 },
  { term: 'Mun', weight: 0.8 },
]);
```

Weights range 0-1. Higher weight = more likely to be chosen when scores are close.

## How It Works

1. Each word in STT output is checked against the dictionary
2. Exact matches are left unchanged
3. Non-matches are scored using:
   - **Phonetic similarity** (50%) - Double Metaphone algorithm
   - **Text similarity** (30%) - Levenshtein distance
   - **Dictionary weight** (20%) - Position/explicit weight
4. Best match above threshold (0.65) replaces the word
5. Results are cached for fast subsequent lookups

## Configuration

```typescript
import { setPhoneticCorrection } from 'hear-say';

setPhoneticCorrection({
  enabled: true,       // Toggle correction on/off
  onFinal: true,       // Correct final results (default: true)
  onStreaming: true,   // Correct streaming results (default: true)
  minScore: 0.65,      // Minimum match score (default: 0.65)
  debug: false,        // Log matching decisions (default: false)
});
```

## Performance

With caching, correction takes <0.01ms per call after the first lookup of each word. The cache is cleared at the start of each new utterance.

## Tips

- Include proper nouns, technical terms, and domain-specific vocabulary
- Common English words (stopwords) are automatically skipped
- The dictionary uses its own casing - STT casing is ignored
- Update the dictionary anytime with another `setDictionary()` call
