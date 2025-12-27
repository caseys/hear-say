import { checkPlatform, checkHearBinary } from './platform.js';

// Run checks once at startup
checkPlatform();
checkHearBinary();

export { say, interrupt, raiseHand, getLastSpoken, isSpeaking, onSayStarted, onSayFinished } from './say.js';
export { hear } from './hear.js';
export { loopback } from './loopback.js';
