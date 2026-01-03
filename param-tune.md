
### Testing Methodology for Finding Optimal Defaults

#### 1. Build Test Corpus
Collect real STT errors and expected corrections:
```typescript
const testCases = [
  { input: "Carbon", expected: "Kerbin", shouldMatch: true },
  { input: "Minas", expected: "Minmus", shouldMatch: true },
  { input: "navigate", expected: "navigate", shouldMatch: false },  // no change
  { input: "return", expected: "return", shouldMatch: false },      // no change
  // ... more cases
];
```

#### 2. Metrics to Measure
- **True Positives**: Correctly changed (Carbon → Kerbin)
- **False Positives**: Incorrectly changed (navigate → navigation) ← minimize this
- **True Negatives**: Correctly left alone (return → return)
- **False Negatives**: Should have changed but didn't

**Key metric**: F1 score = 2 * (precision * recall) / (precision + recall)
- Precision = TP / (TP + FP) — avoid false corrections
- Recall = TP / (TP + FN) — catch real errors

#### 3. Parameter Sweep
```typescript
// Test different threshold values
for (const minScore of [0.55, 0.60, 0.65, 0.70, 0.75]) {
  for (const maxPhoneticDist of [1, 2, 3]) {
    const results = runTestCorpus(testCases, { minScore, maxPhoneticDist });
    console.log(`minScore=${minScore}, dist=${maxPhoneticDist}: F1=${results.f1}`);
  }
}
```

#### 4. Weight Optimization
Test different scoring weight combinations:
```
[0.5, 0.3, 0.2]  ← current (phonetic-first)
[0.4, 0.4, 0.2]  ← balanced
[0.6, 0.2, 0.2]  ← strong phonetic
[0.4, 0.3, 0.3]  ← more dict weight
```

#### 5. npm run pho-test Script
Create test runner:
```bash
npm run pho-test              # run with defaults
npm run pho-test -- --sweep   # parameter sweep
npm run pho-test -- --verbose # show each decision
```

### Recommended Starting Point
Based on current testing:
- `minScore: 0.65` - conservative, avoids false positives
- `maxPhoneticDist: 2` - catches "Minas"→"Minmus" (MNS vs MNMS)
- Weights: `[0.5, 0.3, 0.2]` - phonetic dominant

These can be tuned per-domain if clients have different tolerance for false positives vs false negatives.
