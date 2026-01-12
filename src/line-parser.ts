export function createLineParser(
  onLine: (line: string) => void
): (chunk: Buffer | string) => void {
  let buffer = '';

  return (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        onLine(line);
      }
    }
  };
}
