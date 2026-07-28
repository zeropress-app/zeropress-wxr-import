import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLexically, compareWordPressIdStrings } from '../src/compare.js';

test('compares text with locale-independent lexical ordering', () => {
  assert.equal(compareLexically('Zebra', 'Ärlig'), -1);
  assert.equal(compareLexically('Ärlig', 'Zebra'), 1);
  assert.equal(compareLexically('Same', 'Same'), 0);
});

test('compares numeric WordPress IDs without Number precision loss', () => {
  assert.equal(compareWordPressIdStrings('2', '10'), -1);
  assert.equal(
    compareWordPressIdStrings('900719925474099312345', '900719925474099312346'),
    -1,
  );
  assert.equal(compareWordPressIdStrings('02', '2'), -1);
  assert.equal(compareWordPressIdStrings('id-10', 'id-2'), -1);
});
