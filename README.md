# hear-say

Minimal macOS TypeScript glue on top of Apple’s `say` (TTS) and the [`hear`](https://sveinbjorn.org/hear) CLI (STT).

## Limits:

- **MacOS only.** Uses Apple binaries (`say`) and the macOS-only `hear` CLI.
- **Minimal speech-driven interruption** Interrupt via keyboard or inbetween said phrases.

## Vibe Code Warning

Claude did most of the work here - it's a bit messy, but solid and fast.

## Hack Warning

This project leans on Apple’s built‑in STT/TTS stack—30+ years of MacinTalk heritage, fast, tiny, and surprisingly good on older hardware. The library is a pragmatic “hack on top” of the `say` CLI and the `hear` CLI, with a small queue, tags, and glue to make them feel like an API.

Credit: `hear` is by Sveinbjörn Þórðarson (see https://sveinbjorn.org/hear).

## Features

- **Say queue** with automatic rate control as the queue grows.
- **Interrupt modes** for `say`: polite interrupt, clear queue, rude cut‑off, “latest wins.”
- **Brief gaps** between queue items for turn‑taking (helps `hear` capture speech).
- **`[[...]]` tags** (classic MacinTalk) pass through for rate/volume/pitch control.
- **STT streaming + dictionary correction** for names and domain terms.

## Install

```bash
brew install hear
npm install hear-say
```

Requires Node.js 18+ and macOS.

## Usage

```ts
import { say, hear, loopback, setDictionary } from 'hear-say';

// say(): queued TTS
await say('Hello');
say('Next up', { interrupt: true });

// hear(): streaming STT
hear((text, stop, final) => {
  if (final) console.log('Final:', text);
});

// loopback(): speak and re-hear (useful for tuning)
const heard = await loopback('Test phrase');

// dictionary: help STT with names
setDictionary(['Kerbin', 'Minmus']);
```

## Dictionary + Heuristics

When a dictionary is provided, recognized words are scored against it using phonetic and textual similarity (Double Metaphone + edit distance), with small bonuses for prefix/syllable matches. This is aimed at names and domain terms. See `use-dictionary.md` for details.

## Future:

Support other minimal, low‑resource engines with similar ergonomics:

- Windows: `System.Speech` and `Windows.Media.Speech*`
- iOS/macOS: `AVSpeechSynthesizer`
- Cross‑platform: `Pocket‑TTS` (https://github.com/kyutai-labs/pocket-tts)

## Why

I created this to use with an MCP service for Kerbal Space Program... to get that 2001-Hal-like experience.

## License

MIT
