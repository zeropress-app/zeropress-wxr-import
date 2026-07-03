import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtf8Sanitizer } from '../src/utf8.js';

test('discards malformed UTF-8 bytes without creating replacement characters', () => {
  const decoder = createUtf8Sanitizer();

  assert.equal(decoder.write(Buffer.from([0xc3])), '');
  assert.equal(decoder.write(Buffer.from([0x28])), '(');
  assert.equal(decoder.write(Buffer.from([
    0x80,
    0xc0, 0xaf,
    0xe0, 0x80, 0x80,
    0xed, 0xa0, 0x80,
    0xf4, 0x90, 0x80, 0x80,
  ])), '');
  assert.equal(decoder.end(), '');
});

test('preserves valid UTF-8 including an explicitly encoded replacement character', () => {
  const decoder = createUtf8Sanitizer();

  assert.equal(decoder.write(Buffer.from([0xef])), '');
  assert.equal(decoder.write(Buffer.from([0xbf, 0xbd])), '�');
  assert.equal(decoder.write(Buffer.from('한글', 'utf8')), '한글');
  assert.equal(decoder.end(), '');
});

test('discards an incomplete UTF-8 sequence at end of input', () => {
  const decoder = createUtf8Sanitizer();

  assert.equal(decoder.write(Buffer.from('complete', 'utf8')), 'complete');
  assert.equal(decoder.write(Buffer.from([0xe2, 0x82])), '');
  assert.equal(decoder.end(), '');
});
