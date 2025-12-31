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
}, 1600);  // 1600ms silence timeout (default: 1200)

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
| `timeoutMs` | `number` | Silence timeout in ms (default: 1200) |
| `onLine` | `(text: string, final: boolean) => void` | Optional streaming callback |

## Configuration

Environment variables to customize behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE` | (system default) | macOS voice name (e.g., "Samantha", "Alex") |
| `MIN_RATE` | 230 | Minimum speech rate in words per minute |
| `MAX_RATE` | 370 | Maximum speech rate (used when queue is long) |
| `WORD_QUEUE_PLATEAU` | 15 | Words in queue to reach max rate |
| `SAY_QUEUE_BREAK` | 2 | Gap between queue items in seconds (allows hearing) |
| `HEAR_SAY_DEBUG` | (off) | Set to "1" to enable debug logging |

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
  setDebug,
  setGapDuration,
  onSayStarted,
  onSayFinished,
  onSayGapStart,
  onSayGapEnd,
  signalGapSpeechComplete
} from 'hear-say';
```

### State & Debug

| Function | Returns | Description |
|----------|---------|-------------|
| `getLastSpoken()` | `string` | The last text that was spoken |
| `isSpeaking()` | `boolean` | Whether TTS is currently active |
| `setDebug(enabled)` | `void` | Enable/disable debug logging at runtime |

```ts
import { setDebug } from 'hear-say';

// Enable debug logging (same as HEAR_SAY_DEBUG=1)
setDebug(true);

// Tools can expose this to their users however they want
if (args.verbose) {
  setDebug(true);
}
```

### Gap Control

Between each queued speech item, there's a configurable gap (default 2s) that allows the `hear` system to capture user speech. This enables conversational turn-taking.

| Function | Description |
|----------|-------------|
| `setGapDuration(ms)` | Set gap duration in milliseconds (0 to disable) |
| `signalGapSpeechComplete()` | End gap early (e.g., when user speech is captured) |

### Events

Register callbacks for speech lifecycle events. Each returns an unregister function.

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

## License

MIT
