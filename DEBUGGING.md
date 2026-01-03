# hear-say Debugging Notes

## Active Investigation: say() stops working

**Symptom**: `say()` stops working while `hear()` continues to function.

**Hypothesis**: `processingQueue` flag gets stuck as `true`, causing all new `say()` calls to return early.

**Self-healing added**: say() now detects impossible state (processingQueue=true but nothing processing) and resets. Look for "self-healing" in logs.

## Debug Log File

Debug output writes to a configurable location:
- Set `HEAR_SAY_DEBUG_LOG` env var for custom path
- Default: `$TMPDIR/hear-say-debug.log` (e.g., `/tmp/hear-say-debug.log` on macOS/Linux)

To read recent logs:
```bash
tail -100 ${HEAR_SAY_DEBUG_LOG:-$TMPDIR/hear-say-debug.log}
```

To watch live:
```bash
tail -f ${HEAR_SAY_DEBUG_LOG:-$TMPDIR/hear-say-debug.log}
```

To clear:
```bash
echo "" > ${HEAR_SAY_DEBUG_LOG:-$TMPDIR/hear-say-debug.log}
```

## What to Look For

When say breaks, check the log for:
1. Last `[say] exec:` entry - what was the last thing spoken?
2. Last `[say] exit:` entry - did the process exit?
3. Any `self-healing:` entries - did recovery kick in?
4. `[say] emitFinish` - was finish emitted?
5. State at failure: `processingQueue`, `speaking`, queue length

## Key Debug Points

| Log Entry | Meaning |
|-----------|---------|
| `[say] exec: say ...` | Starting to speak |
| `[say] exit: 0` | Speech finished normally |
| `[say] self-healing: resetting stuck processingQueue` | Detected and recovered from stuck state |
| `[say] emitStart error:` | Listener threw exception |
| `[hear] onSayFinished:` | hear responding to say finishing |

## Diagnostic Function

If you can access the module:
```typescript
import { getSayStatus } from 'hear-say';
console.log(getSayStatus());
// { processingQueue, speaking, queueLength, hasPendingInterrupt, hasActiveProcess, lastSpoken }
```

## Recent Changes (for context)

1. Added self-healing check for stuck processingQueue
2. Wrapped event emitters in try-catch
3. Lowered MAX_RATE to 330
4. Added repeat reduction (strips common prefix/suffix)
5. Improved killProcess() to return Promise and use SIGTERM
