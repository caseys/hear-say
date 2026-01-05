import { checkPlatform, checkHearBinary } from './platform.js';

// Run checks once at startup
checkPlatform();
checkHearBinary();

export { say, getLastSpoken, isSpeaking, getSayStatus, onSayStarted, onSayFinished, onSayGapStart, onSayGapEnd, signalGapSpeechComplete, setGapDuration, setRepeatReduction } from './say.js';
export type { SayOptions } from './say.js';
export { hear } from './hear.js';
export { loopback } from './loopback.js';
export { setHearMuted, isHearMuted, onMuteChange } from './mute.js';
export { setDictionary, setPhoneticCorrection, benchmarkCorrection, correctText } from './phonetic.js';
export type { DictionaryEntry, PhoneticCorrectionOptions } from './phonetic.js';
