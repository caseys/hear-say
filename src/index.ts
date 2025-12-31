import { checkPlatform, checkHearBinary } from './platform.js';

// Run checks once at startup
checkPlatform();
checkHearBinary();

export { say, getLastSpoken, isSpeaking, onSayStarted, onSayFinished, onSayGapStart, onSayGapEnd, signalGapSpeechComplete, setGapDuration, setDebug } from './say.js';
export type { SayOptions } from './say.js';
export { hear } from './hear.js';
export { loopback } from './loopback.js';
