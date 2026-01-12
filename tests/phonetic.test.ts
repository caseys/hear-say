import assert from 'node:assert/strict';
import { setDictionary, correctText, clearCaches } from '../src/phonetic.js';

setDictionary([
  'match_planes',
  'Kerbin',
]);

function resetCaches(): void {
  clearCaches();
}

resetCaches();
const phraseWithTag = 'match [[slnc 500]] planes near carbon';
assert.equal(
  correctText(phraseWithTag, true),
  'match_planes [[slnc 500]] near Kerbin',
  'multi-word corrections should cross [[...]] tags'
);

resetCaches();
const trailingTag = 'match [[slnc 500]] planes';
assert.equal(
  correctText(trailingTag, true),
  'match_planes [[slnc 500]]',
  'phrases ending after a tag should not add trailing whitespace'
);

resetCaches();
const tagAtStart = '[[volm +0.2]] carbon on final';
assert.equal(
  correctText(tagAtStart, true),
  '[[volm +0.2]] Kerbin on final',
  'words following a tag should still be corrected'
);

console.log('✅ phonetic tag preservation tests passed');
