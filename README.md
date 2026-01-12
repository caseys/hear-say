# hear-say

A minimal macOS TypeScript library wrapping the system `say` command (text-to-speech) and the [`hear`](https://sveinbjorn.org/hear) CLI (speech-to-text).

## Requirements

- **macOS only** - This library uses macOS-specific binaries and will not work on other platforms
- Node.js >= 18
- [`hear`](https://sveinbjorn.org/hear) CLI installed (`brew install hear`)

The library will warn at startup if run on a non-macOS platform or if the `hear` CLI is not found.

## Installation

```bash
npm install hear-say
```

## API

```ts
import { say, hear, loopback } from 'hear-say';
```

### `say(text: string | false, options?: SayOptions): Promise<void>`

Queue text-to-speech using the macOS `say` command. Returns a promise that resolves when the specific text finishes speaking.

```ts
await say("Hello world");  // speak text, wait for completion
say("More text");          // queues after previous (does not interrupt)
say(false);                // stop speaking and clear queue
```

#### Options

| Option | Effect |
|--------|--------|
| `interrupt` | Skip to front of queue (wait for current to finish, last wins) |
| `clear` | Clear queue and speak next (implies interrupt) |
| `rude` | Cut off current speaker immediately |
| `latest` | Only the last call with this flag wins (supersedes previous) |
| `volume` | Set volume via `[[volm X]]` tag (e.g., 0.5, "+0.1", "-0.2") |
| `pitch` | Set pitch via `[[pbas X]]` tag (semitones) |

Options can be combined. For example:
- `{ rude: true, clear: true }` - cut off speaker AND clear queue
- `{ interrupt: true, latest: true }` - jump to front, but newer calls replace

```ts
// Polite interrupt: wait for current speech, then speak next
say("Urgent update", { interrupt: true });

// Rude interrupt: cut off current speaker immediately
say("STOP!", { rude: true });

// Clear queue and speak next
say("Starting over", { clear: true });

// Latest wins: only the last call is spoken when its turn comes
say("Status: loading...", { latest: true });
say("Status: complete!", { latest: true });  // replaces previous

// Speech modifiers: adjust volume and pitch
say("Whisper this", { volume: "-0.5" });
say("Higher pitch", { pitch: 50 });
say("Loud and low", { volume: "+0.3", pitch: -20 });
```

### `hear(callback, timeoutMs?): void`

Speech-to-text using the `hear` CLI with streaming and silence detection.

```ts
hear((text, stop, final) => {
  if (final) {
    console.log("Final:", text);
    // Complete utterance after silence timeout
  } else {
    console.log("Streaming:", text);
    // Real-time updates as speech is recognized
  }
}, 1600);  // 1600ms silence timeout (default: 2500)

hear(false);  // stop listening
```

#### Callback Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `text` | `string` | The recognized speech text |
| `stop` | `() => void` | Call to stop listening entirely |
| `final` | `boolean` | `true` after silence timeout, `false` for streaming updates |

#### Behavior

- Callback fires for every line from the hear CLI (`final=false`)
- After silence timeout, callback fires once more with `final=true`
- Callback is hot-swappable: call `hear(newFn)` to replace without restarting
- After each final utterance, the process restarts automatically unless `stop()` is called

### `loopback(text, timeoutMs?, onLine?): Promise<string>`

Speak text via TTS and return what STT transcribes. Used for testing STT accuracy.

```ts
// Basic usage
const heard = await loopback("Hello world");
console.log("Heard:", heard);

// With streaming callback
const heard = await loopback("Hello world", 1200, (text, final) => {
  if (final) {
    console.log("Final:", text);
  } else {
    console.log("Streaming:", text);
  }
});
```

#### Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `text` | `string` | The text to speak |
| `timeoutMs` | `number` | Silence timeout in ms (default: 1800) |
| `onLine` | `(text: string, final: boolean) => void` | Optional streaming callback |

## Configuration

Environment variables to customize behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE` | (system default) | macOS voice name (e.g., "Samantha", "Alex") |
| `MIN_RATE` | 200 | Minimum speech rate in words per minute |
| `MAX_RATE` | 300 | Maximum speech rate (used when queue is long) |
| `WORD_QUEUE_PLATEAU` | 50 | Words in queue to reach max rate |
| `SAY_QUEUE_BREAK` | 2 | Gap between queue items in seconds (allows hearing) |
| `HEAR_SAY_DEBUG_LOG` | `/tmp/hear-say-debug.log` | Path for debug log file |

Debug logs are written to the file at `HEAR_SAY_DEBUG_LOG`.

Example:
```bash
VOICE=Samantha MIN_RATE=200 MAX_RATE=400 node your-app.js
```

## Advanced API

Additional exports for advanced use cases:

```ts
import {
  getLastSpoken,
  isSpeaking,
  getSayStatus,
  setRepeatReduction,
  setHearMuted,
  isHearMuted,
  onMuteChange,
  setGapDuration,
  onSayStarted,
  onSayFinished,
  onSayGapStart,
  onSayGapEnd,
  signalGapSpeechComplete
} from 'hear-say';
```

### State

| Function | Returns | Description |
|----------|---------|-------------|
| `getLastSpoken()` | `string` | The last text that was spoken |
| `isSpeaking()` | `boolean` | Whether TTS is currently active |
| `getSayStatus()` | `object` | Internal say() queue state for debugging |
| `setRepeatReduction(enabled)` | `void` | Enable/disable repeat reduction (default: on) |
| `setHearMuted(enabled)` | `void` | Mute/unmute hear() callbacks |
| `isHearMuted()` | `boolean` | Whether hear() is currently muted |

**Repeat Reduction**: Automatically strips common prefix/suffix from consecutive `say()` calls, speaking only the changed portion. Exact duplicates are skipped entirely.

```ts
say("Processing file: 1 of 100")  // speaks full text
say("Processing file: 2 of 100")  // speaks "2"
say("Processing file: 2 of 100")  // skipped (duplicate)
```

### Gap Control

Between each queued speech item, there's a configurable gap (default 2s) that allows the `hear` system to capture user speech. This enables conversational turn-taking.

| Function | Description |
|----------|-------------|
| `setGapDuration(ms)` | Set gap duration in milliseconds (0 to disable) |
| `signalGapSpeechComplete()` | End gap early (e.g., when user speech is captured) |

### Events

Register callbacks for state events. Each returns an unregister function.

```ts
const unregister = onSayStarted(() => {
  console.log("Speech started");
});

// Later: unregister();
```

| Function | Fires when |
|----------|------------|
| `onSayStarted(cb)` | Speech queue begins processing |
| `onSayFinished(cb)` | Speech queue is empty |
| `onSayGapStart(cb)` | Gap begins between queue items |
| `onSayGapEnd(cb)` | Gap ends, speech resuming |
| `onMuteChange(cb)` | Hear mute state changes (callback receives boolean) |


### Apple's Embedded Speech Commands

Apple's `say` command supports inline speech control tags. These tags pass through phonetic correction unchanged.

| Tag | Effect |
|-----|--------|
| `[[slnc 500]]` | Pause for 500 milliseconds |
| `[[volm +0.1]]` | Adjust volume (relative or absolute) |
| `[[rate 150]]` | Set speech rate (words per minute) |
| `[[pbas 50]]` | Adjust pitch (semitones) |
| `[[rset]]` | Reset parameters to default |

Example:
```
"Hello, world! [[slnc 500]] After delay. [[volm -0.5]] Quieter. [[pbas 30]] Higher pitch. [[rset]] Normal."
```

When using `volume` or `pitch` options in `say()`, tags are auto-inserted and `[[rset]]` is appended.


### Phonetic Correction

The library includes a phonetic correction system that maps misrecognized words to a custom dictionary. This is useful when STT doesn't know domain-specific terms (game names, technical jargon, etc.).

```ts
import {
  setDictionary,
  setPhoneticCorrection,
  correctText
} from 'hear-say';

// Set up dictionary of domain terms (ordered by priority)
setDictionary(['Kerbin', 'Mun', 'Minmus', 'Duna', 'Jool']);

// Or with explicit weights
setDictionary([
  { term: 'Kerbin', weight: 1.0 },
  { term: 'Mun', weight: 0.9 },
]);

// Configure behavior
setPhoneticCorrection({
  enabled: true,      // Enable/disable correction
  onFinal: true,      // Apply to final utterances
  onStreaming: true,  // Apply to streaming updates
  minScore: 0.72,     // Minimum match score (0-1)
  debug: false,       // Log match details
});

// Manual correction (automatic when dictionary is set)
const corrected = correctText("I'm orbiting carbon", true);
// -> "I'm orbiting Kerbin"
```

#### How It Works

The system uses multiple signals to score potential matches:

| Factor | Weight | Description |
|--------|--------|-------------|
| Phonetic similarity | 50% | Double Metaphone encoding comparison |
| Text similarity | 40% | Levenshtein edit distance |
| Dictionary order | 5% | Earlier terms score slightly higher |
| Prefix bonus | +0.10 max | Matching first 2-3 characters |
| Syllable bonus | +0.10 | Matching syllable count (multi-syllable only) |
| Dominance bonus | +0.05 | When phonetic >> text (true phonetic match) |

**Key insight**: When STT mishears a word, it picks something that *sounds* similar but may be *spelled* differently. The "dominance bonus" rewards this pattern—high phonetic similarity with lower text similarity indicates a true phonetic substitution rather than coincidental word similarity.

#### Multi-word Phrases

Dictionary terms with underscores or spaces are matched as phrases:

```ts
setDictionary(['match_planes', 'rescue_kerbal']);

correctText("match planes", true);  // -> "match_planes"
```

#### Stopwords

Common English words (1,298 from stopwords-en) are skipped during correction to avoid false positives on words like "please", "what", "the", etc.

#### Limitations

The phonetic algorithms are English-specific (Double Metaphone, English syllabification rules). Multi-language support would require language detection and per-language phonetic encoders.

## Development

- `npm run lint` - Lint `src`
- `npm run test` - Interactive end-to-end check (requires mic/speaker)
- `npm run test:phonetic` - Unit test for phonetic tag preservation

## License

MIT
