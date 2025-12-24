import { say, hear } from './src/index.js';

const prompts = [
  { speak: "What's the time?", expect: "It's time to get ill" },
  { speak: "What's your favorite color?", expect: "Blue" },
  { speak: "How many fingers am I holding up?", expect: "Three" },
  { speak: "What's the magic word?", expect: "Please" },
];

let current = 0;

function runTest() {
  if (current >= prompts.length) {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }

  const { speak, expect } = prompts[current];

  console.log(`\n--- Test ${current + 1}/${prompts.length} ---`);
  console.log(`🔊 Saying: "${speak}"`);
  console.log(`👂 Please say: "${expect}"`);
  console.log('Listening...\n');

  say(speak);

  hear((text, stop) => {
    console.log(`Heard: "${text}"`);

    const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const expected = expect.toLowerCase().replace(/[^\w\s]/g, '').trim();

    if (normalized.includes(expected) || expected.includes(normalized)) {
      console.log('✅ Match!');
      current++;
      stop();
      setTimeout(runTest, 500);
    } else {
      console.log(`❌ Expected "${expect}", got "${text}"`);
      console.log('Stopping.');
      stop();
      process.exit(1);
    }
  });
}

console.log('=== hear-say Interactive Test ===');
runTest();
