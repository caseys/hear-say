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
import { say, hear } from 'hear-say';
```

### `say(text: string | false): void`

Text-to-speech using the macOS `say` command.

```ts
say("Hello world");  // speak text
say("Something else");  // stops previous, speaks new text
say(false);  // stop speaking
```

### `hear(callback: ((text: string, stop: () => void) => void) | false, timeoutMs?: number): void`

Speech-to-text using the `hear` CLI with automatic silence detection.

```ts
hear((text, stop) => {
  console.log("You said:", text);
  // call stop() to stop listening
  // otherwise, automatically restarts for next utterance
}, 1600);  // 1600ms silence timeout (default)

hear(false);  // stop listening
```

**Behavior:**
- Accumulates text until silence (no output for `timeoutMs`)
- Callback receives the final accumulated text
- Callback is hot-swappable: call `hear(newFn)` to replace without restarting
- After each utterance, the process restarts automatically unless `stop()` is called

## License

MIT
