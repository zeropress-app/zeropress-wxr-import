import assert from 'node:assert/strict';
import test from 'node:test';
import { toTerminalSafeText } from '../src/terminal.js';

test('escapes terminal controls and bidirectional formatting characters', () => {
  assert.equal(
    toTerminalSafeText('safe\u001b\n\u0085\u202E\u2066text'),
    'safe\\u001B\\u000A\\u0085\\u202E\\u2066text',
  );
});

test('preserves ordinary Unicode text', () => {
  assert.equal(toTerminalSafeText('ZeroPress 한글 �'), 'ZeroPress 한글 �');
});
