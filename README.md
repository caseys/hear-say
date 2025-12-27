# hear-say

A minimal macOS TypeScript library wrapping the system `say` command (text-to-speech) and the [`hear`](https://sveinbjorn.org/hear) CLI (speech-to-text).

## Requirements

- macOS
- Node.js >= 18
- [`hear`](https://sveinbjorn.org/hear) CLI installed (`brew install hear`)

## Installation

```bash
npm install hear-say
```

## API

```ts
import { say, interrupt, raiseHand, hear, loopback } from 'hear-say';
```

### `say(text: string | false): Promise<void>`

Queue text-to-speech using the macOS `say` command. Returns a promise that resolves when the specific text finishes speaking.

```ts
await say("Hello world");  // speak text, wait for completion
say("More text");          // queues after previous (does not interrupt)
say(false);                // stop speaking and clear queue
```

### `interrupt(text: string): Promise<void>`

Interrupt any current speech and speak new text immediately. Clears the queue.

```ts
say("Hello world");
interrupt("Something urgent");  // stops "Hello world", speaks this instead
```

### `raiseHand(text: string): Promise<void>`

Wait for current speech to finish, then speak. If called multiple times while waiting, only the latest text is spoken.

```ts
say("Long explanation...");
raiseHand("I have a question");  // waits for say() to finish, then speaks
raiseHand("Actually, different question");  // replaces previous raiseHand
// Only "Actually, different question" will be spoken after "Long explanation..."
```

Useful when you want to queue a response without interrupting, but don't need to queue multiple items (newer calls supersede previous ones).

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

## License

MIT
