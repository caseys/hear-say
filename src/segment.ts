const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function splitSentences(text: string): string[] {
  return [...segmenter.segment(text)]
    .map(s => s.segment.trim())
    .filter(Boolean);
}
